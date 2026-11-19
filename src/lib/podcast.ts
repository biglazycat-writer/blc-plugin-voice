import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginContext } from 'blc-plugin-sdk';
import { readJson, writeTextAtomic, newId, clampNumber, TARGET_SAMPLE_RATE } from './util.js';
import { splitIntoParagraphs } from './splitter.js';
import { extractJsonArray } from './ai-text.js';
import type { EngineRegistry } from './engines/registry.js';
import type { SynthesisRequest } from './engines/types.js';
import type { SettingsStore, VoiceParams } from './settings.js';
import type { AudioStore, SegmentInfo } from './audio-store.js';
import { parseWav } from './util.js';

export type PodcastStyle = 'solo' | 'duet';
export type PodcastSpeaker = 'host' | 'guest';

export interface PodcastLine {
  speaker: PodcastSpeaker;
  text: string;
}

export interface PodcastScript {
  scriptId: string;
  title: string;
  style: PodcastStyle;
  source: 'ai' | 'fallback';
  createdAt: string;
  lines: PodcastLine[];
}

const MAX_LINES = 200;
const MAX_LINE_CHARS = 200;
/** 中文朗读语速经验值：每分钟约 280 字。 */
const CHARS_PER_MINUTE = 280;
/** 行间停顿（毫秒），写入 manifest 供页面播放时插入。 */
export const LINE_PAUSE_MS = 420;

export class PodcastStore {
  private dir(): string {
    return join(this.dataDir, 'scripts');
  }

  constructor(private readonly dataDir: string) {}

  async save(script: PodcastScript): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
    await writeTextAtomic(join(this.dir(), `${script.scriptId}.json`), JSON.stringify(script, null, 2));
  }

  async get(scriptId: string): Promise<PodcastScript | null> {
    const id = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(scriptId) ? scriptId : '';
    if (!id) return null;
    return readJson<PodcastScript>(join(this.dir(), `${id}.json`));
  }
}

function sanitizeLines(input: unknown[]): PodcastLine[] {
  const lines: PodcastLine[] = [];
  for (const item of input) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const speaker = record.speaker === 'guest' ? 'guest' : record.speaker === 'host' ? 'host' : null;
    const text = typeof record.text === 'string' ? record.text.replace(/\s+/g, ' ').trim() : '';
    if (!speaker || !text) continue;
    for (let offset = 0; offset < text.length && lines.length < MAX_LINES; offset += MAX_LINE_CHARS) {
      lines.push({ speaker, text: text.slice(offset, offset + MAX_LINE_CHARS) });
    }
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

/** 宿主 AI 不可用或输出不合规时的本地规则脚本：抽取要点组织成对话轮次。 */
export function buildFallbackScript(title: string, paragraphs: string[], style: PodcastStyle, minutes: number): PodcastScript {
  const targetChars = Math.max(600, Math.round(minutes * CHARS_PER_MINUTE));
  const body = paragraphs.filter(text => text.length >= 20);
  const pool = body.length > 0 ? body : paragraphs;
  const lines: PodcastLine[] = [
    { speaker: 'host', text: `欢迎收听本期节目。今天我们聊一聊「${title.slice(0, 40)}」，根据这篇文章整理一些值得聊的内容。` },
  ];
  if (style === 'duet') lines.push({ speaker: 'guest', text: '好啊，这篇的内容其实挺有信息量的，我们一条条来拆开说。' });
  let usedChars = 80;
  for (let i = 0; i < pool.length && usedChars < targetChars && lines.length < MAX_LINES - 1; i += 1) {
    const paragraph = pool[i];
    const lead = paragraph.slice(0, 90);
    const rest = paragraph.length > 90 ? paragraph.slice(90, 180) : '';
    if (style === 'duet') {
      lines.push({ speaker: 'guest', text: i === 0 ? `先说第一点：${lead}` : `还有一个要点，${lead}` });
      usedChars += lead.length + 10;
      if (rest) {
        lines.push({ speaker: 'host', text: `嗯，这部分我补充一下背景，${rest}` });
        usedChars += rest.length + 10;
      } else {
        lines.push({ speaker: 'host', text: i % 2 === 0 ? '这个角度有意思，为什么这么说？' : '明白了，那实际使用中要注意什么？' });
        usedChars += 16;
      }
    } else {
      lines.push({ speaker: 'host', text: i === 0 ? `第一部分，${lead}` : `接下来看，${lead}` });
      usedChars += lead.length + 8;
      if (rest) {
        lines.push({ speaker: 'host', text: rest });
        usedChars += rest.length;
      }
    }
  }
  if (style === 'duet') lines.push({ speaker: 'guest', text: '总结一下，这篇文章的核心观点都在上面的几点里，值得再回顾一遍。' });
  lines.push({ speaker: 'host', text: '本期节目就到这里，感谢收听，我们下期再见。' });
  return {
    scriptId: newId('pod'),
    title,
    style,
    source: 'fallback',
    createdAt: new Date().toISOString(),
    lines,
  };
}

function buildPrompt(title: string, paragraphs: string[], style: PodcastStyle, minutes: number): string {
  const targetChars = Math.max(600, Math.round(minutes * CHARS_PER_MINUTE));
  const speakerRule = style === 'duet'
    ? '用 host（主持人）与 guest（嘉宾）两人对谈；host 负责开场、串场、追问与收尾，guest 负责解读文章内容、举例子、给观点。'
    : '只有 host（主讲人）一个人，用讲稿的方式把文章讲成一期节目，有开场、有小结。';
  return [
    '你是资深播客编剧。请把下面这篇文章改编成播客脚本。',
    '硬性要求：',
    '1. 只输出一个 JSON 数组，不要输出任何解释、标题或代码块标记；',
    '2. 数组元素形如 {"speaker":"host","text":"台词"}；',
    `3. ${speakerRule}`,
    '4. 台词口语化自然，不要出现 markdown 符号、链接、表格或代码；',
    `5. 每条台词不超过 120 字，总字数约 ${targetChars} 字（约 ${minutes} 分钟）；`,
    '6. 覆盖文章所有要点，顺序可以调整，结尾要有总结与告别。',
    `文章标题：${title}`,
    '文章正文：',
    paragraphs.join('\n'),
  ].join('\n');
}

export interface PodcastContext {
  ctx: Pick<PluginContext, 'ai'>;
  registry: EngineRegistry;
  settings: SettingsStore;
  audio: AudioStore;
}

export interface ScriptInput {
  source: 'document' | 'text';
  text?: string;
  title?: string;
  style: PodcastStyle;
  minutes?: number;
  useAi?: boolean;
  modelId?: string;
}

export async function generateScript(
  context: PodcastContext,
  args: ScriptInput,
  documentText: string | null,
  signal?: AbortSignal,
): Promise<PodcastScript> {
  signal?.throwIfAborted();
  const raw = args.source === 'text' ? (args.text ?? '') : (documentText ?? '');
  if (!raw.trim()) throw new Error('没有可用的文章内容：请从文档打开，或在表单里粘贴文本');
  const paragraphs = splitIntoParagraphs(raw, 400).map(paragraph => paragraph.text);
  const title = (args.title ?? '').trim() || paragraphs[0]?.slice(0, 30) || '未命名节目';
  const minutes = clampNumber(args.minutes, 1, 30, 5);
  const useAi = args.useAi !== false;
  if (useAi) {
    const response = await context.ctx.ai.generate({prompt: buildPrompt(title, paragraphs, args.style, minutes), modelId: args.modelId}, {signal});
    signal?.throwIfAborted();
    const array = extractJsonArray(response.text);
    const lines = array ? sanitizeLines(array) : [];
    if (lines.length < 2) throw new Error('平台 AI 返回的脚本格式不正确，请重新生成或选择本地规则');
    return {scriptId: newId('pod'), title, style: args.style, source: 'ai', createdAt: new Date().toISOString(), lines};
  }
  return buildFallbackScript(title, paragraphs, args.style, minutes);
}

/** 用户编辑后的行整体替换。 */
export function replaceLines(script: PodcastScript, lines: unknown[]): PodcastScript {
  const sanitized = sanitizeLines(lines);
  if (sanitized.length < 1) throw new Error('脚本至少要保留一行台词');
  return { ...script, lines: sanitized };
}

export interface PodcastRenderOptions {
  script: PodcastScript;
  hostVoiceId: string;
  guestVoiceId: string;
  speed: number;
  signal: AbortSignal;
  onProgress?: (completed: number, total: number, message?: string) => void | Promise<void>;
}

interface RenderJob {
  voiceId: string;
  speaker: PodcastSpeaker;
  lines: PodcastLine[];
  startIndex: number;
}

/** 连续同音色的行合并成一批，交给引擎的批量通道（SAPI 一次进程、sherpa 复用句柄）。 */
function groupJobs(script: PodcastScript): RenderJob[] {
  const jobs: RenderJob[] = [];
  for (const line of script.lines) {
    const voiceId = line.speaker === 'guest' ? 'guest' : 'host';
    const last = jobs[jobs.length - 1];
    if (last && last.voiceId === voiceId) {
      last.lines.push(line);
    } else {
      jobs.push({ voiceId, speaker: line.speaker, lines: [line], startIndex: jobs.reduce((sum, job) => sum + job.lines.length, 0) });
    }
  }
  return jobs;
}

/** 逐行合成 + 行间停顿写进 manifest；页面按行续播，导出时才真正拼接。 */
export async function renderPodcast(
  context: PodcastContext,
  options: PodcastRenderOptions,
): Promise<{ audioId: string; durationMs: number; segments: number }> {
  const { script } = options;
  if (script.style === 'duet' && (!options.hostVoiceId || !options.guestVoiceId)) {
    throw new Error('双人播客需要指定主持人与嘉宾音色');
  }
  const audioId = script.scriptId;
  await context.audio.create(audioId, 'podcast', {
    style: script.style,
    source: script.source,
    title: script.title.slice(0, 80),
    hostVoiceId: options.hostVoiceId,
    guestVoiceId: options.guestVoiceId,
    speed: options.speed,
  });
  const paramsCache = new Map<string, VoiceParams>();
  const paramsFor = async (voiceId: string): Promise<VoiceParams> => {
    if (!paramsCache.has(voiceId)) paramsCache.set(voiceId, await context.settings.paramsFor(voiceId));
    return paramsCache.get(voiceId)!;
  };

  const segments: SegmentInfo[] = [];
  const jobs = groupJobs(script);
  const total = script.lines.length;
  let done = 0;
  let durationMs = 0;
  let sampleRate = 0;
  for (const job of jobs) {
    const voiceId = job.voiceId === 'guest' ? options.guestVoiceId : options.hostVoiceId;
    const voiceParams = await paramsFor(voiceId);
    const { engine, voice } = await context.registry.resolveVoice(voiceId);
    const requests: SynthesisRequest[] = job.lines.map((line, offset) => ({
      text: line.text,
      voice,
      speed: options.speed,
      volume: voiceParams.volume,
      pitch: voiceParams.pitch,
      outFile: context.audio.segmentPath(audioId, `seg-${String(job.startIndex + offset).padStart(5, '0')}.wav`),
      signal: options.signal,
    }));
    if (engine.synthesizeBatch) {
      await engine.synthesizeBatch(requests, {
        signal: options.signal,
        onProgress: completed => void options.onProgress?.(done + completed, total, `第 ${done + completed}/${total} 句`),
      });
    } else {
      for (const request of requests) {
        await engine.synthesize(request);
        done += 1;
        await options.onProgress?.(done, total, `第 ${done}/${total} 句`);
      }
    }
    for (let offset = 0; offset < requests.length; offset += 1) {
      const request = requests[offset];
      const buffer = await readFile(request.outFile);
      const info = parseWav(buffer);
      if (sampleRate === 0) sampleRate = info.sampleRate;
      durationMs += info.durationMs;
      segments.push({
        index: job.startIndex + offset,
        file: request.outFile.split(/[\\/]/).pop()!,
        text: request.text,
        speaker: job.speaker,
        voiceId,
        bytes: buffer.length,
        durationMs: info.durationMs,
      });
    }
    done = job.startIndex + job.lines.length;
    await options.onProgress?.(done, total, `第 ${done}/${total} 句`);
  }
  const manifest = await context.audio.get(audioId);
  if (manifest) {
    manifest.segments = segments;
    // 引擎产物采样率随引擎而异（SAPI/sherpa 24000、say/espeak 22050），以真实 WAV 头为准。
    manifest.sampleRate = sampleRate || TARGET_SAMPLE_RATE;
    manifest.meta.totalDurationMs = Math.round(durationMs + total * LINE_PAUSE_MS);
    manifest.meta.linePauseMs = LINE_PAUSE_MS;
    await context.audio.saveManifest(audioId, manifest);
  }
  return { audioId, durationMs: Math.round(durationMs + total * LINE_PAUSE_MS), segments: segments.length };
}
