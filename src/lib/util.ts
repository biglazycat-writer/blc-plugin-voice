import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

/** 结果上限 1 MiB，音频分块留足 JSON 信封余量。 */
export const AUDIO_CHUNK_BYTES = 600 * 1024;

/** 目标音频格式：全部段落归一到 24000 Hz / 单声道 / 16 bit。
 * 选 24k 是因为旗舰模型（Kokoro）原生 24k，避免降采样损失；SAPI 等更低采样率的引擎会被安全上采样。 */
export const TARGET_SAMPLE_RATE = 24000;

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 原子写文本文件：先写临时文件再改名，避免留下半截产物。 */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

export function sanitizeId(value: unknown, fallback = ''): string {
  const s = String(value ?? '').trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(s) ? s : fallback;
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 简单线性重采样：语音场景下 22.05k/24k 互换听感可接受。 */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(samples.length - 1, left + 1);
    const frac = pos - left;
    out[i] = samples[left] * (1 - frac) + samples[right] * frac;
  }
  return out;
}

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

export function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] / 32768;
  return out;
}

/** 生成指定毫秒数的静音段。 */
export function silenceSamples(sampleRate: number, durationMs: number): Float32Array {
  const length = Math.max(0, Math.round((sampleRate * durationMs) / 1000));
  return new Float32Array(length);
}

/** 编码标准 44 字节头的 PCM WAV。 */
export function encodeWav(pcm: Int16Array, sampleRate: number, channels = 1): Buffer {
  const dataBytes = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i += 1) buffer.writeInt16LE(pcm[i], 44 + i * 2);
  return buffer;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bits: number;
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
}

/** 遍历 RIFF 块解析 WAV；SAPI/PowerShell 会写扩展 fmt 块，不能假定 data 固定在偏移 44。 */
export function parseWav(buffer: Buffer): WavInfo {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let dataOffset = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 8 + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(offset + 10) || 1;
      sampleRate = buffer.readUInt32LE(offset + 12);
      bits = buffer.readUInt16LE(offset + 22) || 16;
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataBytes = Math.min(size, buffer.length - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!sampleRate || !dataBytes) throw new Error('WAV 缺少 fmt/data 块');
  const bytesPerFrame = channels * (bits / 8);
  return {
    sampleRate,
    channels,
    bits,
    dataOffset,
    dataBytes,
    durationMs: Math.round((dataBytes * 1000) / (sampleRate * bytesPerFrame)),
  };
}

/** 把多个同格式 WAV 合并成一个；用于导出整段音频。 */
export function concatWavs(buffers: Buffer[]): { buffer: Buffer; pcm: Int16Array; sampleRate: number; durationMs: number } {
  if (buffers.length === 0) throw new Error('没有可合并的音频段');
  const first = parseWav(buffers[0]);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for (const buffer of buffers) {
    const info = parseWav(buffer);
    if (info.sampleRate !== first.sampleRate || info.bits !== first.bits || info.channels !== first.channels) {
      throw new Error('音频段格式不一致，无法直接拼接');
    }
    chunks.push(buffer.subarray(info.dataOffset, info.dataOffset + info.dataBytes));
    totalBytes += info.dataBytes;
  }
  const pcm = new Int16Array(totalBytes / 2);
  let cursor = 0;
  for (const chunk of chunks) {
    for (let i = 0; i + 1 < chunk.length; i += 2) pcm[cursor++] = chunk.readInt16LE(i);
  }
  const buffer = encodeWav(pcm, first.sampleRate, first.channels);
  return { buffer, pcm, sampleRate: first.sampleRate, durationMs: Math.round((totalBytes * 1000) / (first.sampleRate * first.channels * 2)) };
}
