import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {registerSpeechProvider} from '../dist/lib/speech-provider.js';
import {encodeWav} from '../dist/lib/util.js';

test('speech provider selects a default voice and returns playable chunks, then releases its output', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'speech-provider-'));
  let provider;
  const wav = encodeWav(new Int16Array(100000), 22050, 1);
  const engine = {synthesize: async request => {assert.equal(request.voiceId, 'fixture'); await writeFile(request.outFile, wav);}};
  const registry = {allVoices: async () => [{id: 'fixture', name: 'Fixture'}], resolveVoice: async () => ({engine, voice: {id: 'fixture', name: 'Fixture'}})};
  const settings = {get: async () => ({roles: {}}), paramsFor: async () => ({speed: 1, pitch: 1, volume: 1})};
  const dispose = registerSpeechProvider({dataDir, services: {provide: (id, methods) => {assert.equal(id, 'speech-provider'); provider = methods;}}}, registry, settings);
  try {
    const {audioId, mimeType} = await provider.synthesize({text: '中文测试'}, {signal: new AbortController().signal});
    assert.equal(mimeType, 'audio/wav');
    let offset = 0, hash;
    const chunks = [];
    for (;;) {
      const part = await provider.read({audioId, offset, limit: 10000});
      chunks.push(Buffer.from(part.chunk, 'base64')); offset = part.nextOffset; hash = part.hash;
      if (part.complete) break;
    }
    const bytes = Buffer.concat(chunks);
    assert.deepEqual(bytes, wav);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    await provider.release({audioId});
    await assert.rejects(() => provider.read({audioId, offset: 0, limit: 1}), /released/);
    await assert.rejects(() => provider.synthesize({text: ''}, {signal: new AbortController().signal}), /1-2000/);
  } finally {await dispose(); await rm(dataDir, {recursive: true, force: true});}
});

test('speech provider forwards cancellation to its engine', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'speech-cancel-'));
  let provider, started;
  const ready = new Promise(resolve => {started = resolve;});
  const engine = {synthesize: request => new Promise((resolve, reject) => {request.signal.addEventListener('abort', () => reject(request.signal.reason), {once: true}); started();})};
  const dispose = registerSpeechProvider({dataDir, services: {provide: (_, value) => {provider = value;}}}, {allVoices: async () => [{id: 'fixture'}], resolveVoice: async () => ({engine, voice: {id: 'fixture'}})}, {get: async () => ({roles: {}}), paramsFor: async () => ({speed: 1, volume: 1, pitch: 1})});
  try {
    const controller = new AbortController();
    const pending = provider.synthesize({text: 'cancel'}, {signal: controller.signal});
    const assertion = assert.rejects(pending, error => error.name === 'AbortError');
    await ready; controller.abort(); await assertion;
  } finally {await dispose(); await rm(dataDir, {recursive: true, force: true});}
});
