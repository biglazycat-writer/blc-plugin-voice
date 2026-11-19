import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { concatWavs } from './util.js';
import type { AudioStore } from './audio-store.js';

/** 动态引入纯 JS 编码器，失败时回退 WAV，不让 MP3 成为硬依赖。 */
async function encodeMp3(pcm: Int16Array, sampleRate: number, onProgress?: (ratio: number) => void): Promise<Buffer | null> {
  try {
    const lamejs = (await import('@breezystack/lamejs')) as unknown as {
      Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => {
        encodeBuffer(left: Int16Array): Int8Array;
        flush(): Int8Array;
      };
    };
    const encoder = new lamejs.Mp3Encoder(1, sampleRate, 96);
    const blockSize = 1152 * 16;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < pcm.length; offset += blockSize) {
      const block = pcm.subarray(offset, Math.min(pcm.length, offset + blockSize));
      chunks.push(Buffer.from(encoder.encodeBuffer(block)));
      onProgress?.(Math.min(1, (offset + blockSize) / pcm.length));
    }
    chunks.push(Buffer.from(encoder.flush()));
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

export interface ExportResult {
  path: string;
  format: 'wav' | 'mp3';
  bytes: number;
  durationMs: number;
  sampleRate: number;
}

/** 拼接全部段落并按格式导出；结果同时留在插件缓存目录，可整块回读。 */
export async function exportAudio(
  audio: AudioStore,
  dataDir: string,
  audioId: string,
  format: 'wav' | 'mp3',
): Promise<ExportResult> {
  const manifest = await audio.get(audioId);
  if (!manifest) throw new Error('音频产物不存在');
  if (manifest.segments.length === 0 && !manifest.exported) throw new Error('这段音频还没有任何合成结果');
  const buffers: Buffer[] = [];
  for (const segment of manifest.segments) {
    buffers.push(await readFile(audio.segmentPath(audioId, segment.file)));
  }
  const merged = concatWavs(buffers);
  const outDir = join(dataDir, 'audio', audioId);
  if (format === 'mp3') {
    const mp3 = await encodeMp3(merged.pcm, merged.sampleRate);
    if (mp3) {
      const path = join(outDir, 'export.mp3');
      await writeFile(path, mp3);
      await audio.saveExport(audioId, 'mp3', mp3, merged.durationMs);
      return { path, format: 'mp3', bytes: mp3.length, durationMs: merged.durationMs, sampleRate: merged.sampleRate };
    }
    // 编码器不可用：回退 WAV
  }
  const path = join(outDir, 'export.wav');
  await writeFile(path, merged.buffer);
  await audio.saveExport(audioId, 'wav', merged.buffer, merged.durationMs);
  return { path, format: 'wav', bytes: merged.buffer.length, durationMs: merged.durationMs, sampleRate: merged.sampleRate };
}
