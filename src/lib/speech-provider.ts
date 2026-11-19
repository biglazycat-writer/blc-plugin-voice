import {mkdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {PluginContext, Invocation, SpeechProviderService} from 'blc-plugin-sdk';
import type {EngineRegistry} from './engines/registry.js';
import type {SettingsStore} from './settings.js';
import {newId, sha256} from './util.js';

/** Product-facing TTS returns bounded playable bytes, not workbench cache IDs. */
export function registerSpeechProvider(ctx: PluginContext, registry: EngineRegistry, settings: SettingsStore) {
  const outputs = new Map<string, {path: string; bytes: Buffer; expires: number}>();
  const active = new Set<AbortController>();
  let disposed = false;
  const release = async (audioId: string) => {
    const item = outputs.get(audioId);
    outputs.delete(audioId);
    if (item) await rm(item.path, {force: true});
    return {released: true};
  };
  const sweep = async () => {
    for (const [id, item] of outputs) if (item.expires < Date.now()) await release(id);
  };
  const provider = {
    voices: async () => ({voices: (await registry.allVoices()).map(voice => ({id: voice.id, name: voice.name}))}),
    synthesize: async (args: {text: string; voiceId?: string; speed?: number}, invocation: Invocation) => {
      await sweep();
      if (disposed || outputs.size + active.size >= 4) throw new Error('Speech provider is busy');
      const text = String(args.text ?? '').trim();
      if (!text || Array.from(text).length > 2000) throw new Error('Speech requires 1-2000 characters');
      const audioId = newId('speech');
      const dir = join(ctx.dataDir, 'speech-provider');
      const path = join(dir, `${audioId}.wav`);
      const controller = new AbortController();
      active.add(controller);
      const signal = AbortSignal.any([invocation.signal, controller.signal, AbortSignal.timeout(120000)]);
      try {
        signal.throwIfAborted();
        const current = await settings.get();
        const voiceId = args.voiceId || current.roles.reader || (await registry.allVoices())[0]?.id;
        if (!voiceId) throw new Error('请先在语音插件中安装模型或选择音色');
        const {engine, voice} = await registry.resolveVoice(voiceId);
        const params = await settings.paramsFor(voiceId);
        const speed = args.speed ?? params.speed;
        if (!Number.isFinite(speed) || speed < .5 || speed > 2) throw new Error('Invalid speech speed');
        await mkdir(dir, {recursive: true});
        signal.throwIfAborted();
        const request = {text, voice, voiceId, speed, volume: params.volume, pitch: params.pitch, outFile: path, signal};
        if (engine.synthesizeBatch) await engine.synthesizeBatch([request], {signal});
        else await engine.synthesize(request);
        signal.throwIfAborted();
        const bytes = await readFile(path);
        if (bytes.length === 0 || bytes.length > 16 * 1024 * 1024) throw new Error('Speech audio exceeds limit');
        outputs.set(audioId, {path, bytes, expires: Date.now() + 120000});
        return {audioId, mimeType: 'audio/wav'};
      } catch (error) {
        await rm(path, {force: true});
        throw error;
      } finally { active.delete(controller); }
    },
    read: async (args: {audioId: string; offset: number; limit: number}) => {
      await sweep();
      const item = outputs.get(args.audioId);
      if (!item) throw new Error('Speech audio expired or released');
      if (!Number.isInteger(args.offset) || args.offset < 0 || args.offset > item.bytes.length) throw new Error('Invalid audio offset');
      const end = Math.min(item.bytes.length, args.offset + Math.min(96 * 1024, Math.max(1, args.limit)));
      return {chunk: item.bytes.subarray(args.offset, end).toString('base64'), nextOffset: end, total: item.bytes.length, hash: sha256(item.bytes), complete: end === item.bytes.length};
    },
    release: (args: {audioId: string}) => release(args.audioId),
  } satisfies SpeechProviderService;
  ctx.services.provide('speech-provider', provider);
  return async () => {
    disposed = true;
    for (const controller of active) controller.abort();
    await Promise.all([...outputs.keys()].map(release));
  };
}
