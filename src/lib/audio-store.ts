import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256, writeTextAtomic, AUDIO_CHUNK_BYTES, TARGET_SAMPLE_RATE, type WavInfo } from './util.js';

export type AudioKind = 'reading' | 'podcast' | 'test';

export interface SegmentInfo {
  index: number;
  /** 相对音频目录的文件名。 */
  file: string;
  text: string;
  /** 说话人角色或音色名，仅播客有意义。 */
  speaker?: string;
  voiceId: string;
  bytes: number;
  durationMs: number;
}

export interface AudioManifest {
  audioId: string;
  kind: AudioKind;
  createdAt: string;
  sampleRate: number;
  channels: 1;
  segments: SegmentInfo[];
  meta: Record<string, string | number | boolean>;
  /** 导出产物（WAV/MP3）文件名，存在时可直接整块读取。 */
  exported?: { file: string; format: 'wav' | 'mp3'; bytes: number; durationMs: number };
}

export class AudioStore {
  constructor(private readonly dataDir: string) {}

  private dir(audioId: string): string {
    return join(this.dataDir, 'audio', audioId);
  }

  segmentPath(audioId: string, file: string): string {
    // 文件名只能是我们生成的 seg-*.wav / export.*，防御性校验防止穿越。
    if (!/^[a-zA-Z0-9._-]+$/.test(file)) throw new Error('非法音频文件名');
    return join(this.dir(audioId), file);
  }

  async create(audioId: string, kind: AudioKind, meta: Record<string, string | number | boolean> = {}): Promise<void> {
    await mkdir(this.dir(audioId), { recursive: true });
    await this.saveManifest(audioId, {
      audioId,
      kind,
      createdAt: new Date().toISOString(),
      sampleRate: TARGET_SAMPLE_RATE,
      channels: 1,
      segments: [],
      meta,
    });
  }

  async saveManifest(audioId: string, manifest: AudioManifest): Promise<void> {
    await writeTextAtomic(join(this.dir(audioId), 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  async get(audioId: string): Promise<AudioManifest | null> {
    const manifest = await readFile(join(this.dir(audioId), 'manifest.json'), 'utf8')
      .then(text => JSON.parse(text) as AudioManifest)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    return manifest;
  }

  async list(): Promise<AudioManifest[]> {
    const root = join(this.dataDir, 'audio');
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const manifests: AudioManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await this.get(entry.name);
      if (manifest) manifests.push(manifest);
    }
    manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return manifests;
  }

  async writeSegment(audioId: string, index: number, buffer: Buffer, info: Omit<SegmentInfo, 'index' | 'file' | 'bytes' | 'durationMs'>, wavInfo: WavInfo): Promise<SegmentInfo> {
    const file = `seg-${String(index).padStart(5, '0')}.wav`;
    await writeFile(this.segmentPath(audioId, file), buffer);
    const segment: SegmentInfo = {
      index,
      file,
      bytes: buffer.length,
      durationMs: wavInfo.durationMs,
      ...info,
    };
    return segment;
  }

  /** base64 分块读取：单块 600KB，序列化后远低于 1 MiB 结果上限。 */
  async readChunk(audioId: string, file: string, offset = 0, expectedHash?: string): Promise<{ chunk: string; hash: string; total: number; nextOffset: number; complete: boolean }> {
    const buffer = await readFile(this.segmentPath(audioId, file));
    const hash = sha256(buffer);
    if (expectedHash && expectedHash !== hash) throw new Error('音频内容已变更，请重新读取');
    const safeOffset = Math.max(0, Math.min(offset, buffer.length));
    const slice = buffer.subarray(safeOffset, Math.min(buffer.length, safeOffset + AUDIO_CHUNK_BYTES));
    return {
      chunk: slice.toString('base64'),
      hash,
      total: buffer.length,
      nextOffset: safeOffset + slice.length,
      complete: safeOffset + slice.length >= buffer.length,
    };
  }

  async saveExport(audioId: string, format: 'wav' | 'mp3', buffer: Buffer, durationMs: number): Promise<void> {
    const manifest = await this.get(audioId);
    if (!manifest) throw new Error('音频产物不存在');
    const file = `export.${format}`;
    await writeFile(this.segmentPath(audioId, file), buffer);
    manifest.exported = { file, format, bytes: buffer.length, durationMs };
    await this.saveManifest(audioId, manifest);
  }

  async exportedPath(audioId: string): Promise<string | null> {
    const manifest = await this.get(audioId);
    if (!manifest?.exported) return null;
    return this.segmentPath(audioId, manifest.exported.file);
  }

  /** 清理超过 maxAgeMs 的产物；返回删除的数量。 */
  async cleanup(maxAgeMs = 7 * 24 * 3600 * 1000, keepIds: string[] = []): Promise<number> {
    const root = join(this.dataDir, 'audio');
    const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    let removed = 0;
    const cutoff = Date.now() - maxAgeMs;
    for (const entry of entries) {
      if (!entry.isDirectory() || keepIds.includes(entry.name)) continue;
      const info = await stat(join(root, entry.name)).catch(() => null);
      if (!info || info.mtimeMs < cutoff) {
        await rm(join(root, entry.name), { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  /** 试听等临时产物：保留最近 keepCount 个，其余删除。 */
  async pruneTests(keepCount = 8): Promise<void> {
    const manifests = await this.list();
    const tests = manifests.filter(manifest => manifest.kind === 'test');
    for (const manifest of tests.slice(keepCount)) {
      await rm(this.dir(manifest.audioId), { recursive: true, force: true });
    }
  }

  async usageBytes(): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else total += (await stat(path).catch(() => null))?.size ?? 0;
      }
    };
    await walk(join(this.dataDir, 'audio'));
    return total;
  }
}
