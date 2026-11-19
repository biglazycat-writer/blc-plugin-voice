import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, opendir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import bunzip2 from 'unbzip2-stream';
import { MODEL_CATALOG, findCatalogModel, type CatalogModel, type ModelFamily } from './catalog.js';
import { readJson, writeTextAtomic, sanitizeId } from './util.js';

const MAX_ARCHIVE_BYTES = 1.5 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024;

export interface InstalledModel {
  modelId: string;
  family: ModelFamily;
  installedAt: string;
  /** lexicon / ruleFsts 可能是多文件逗号分隔（kokoro 多语言包）。 */
  files: { model: string; tokens: string; lexicon?: string; voices?: string; dict?: string; ruleFars?: string; ruleFsts?: string };
  sampleRate?: number;
  numSpeakers?: number;
}

export interface CatalogEntry extends CatalogModel {
  installed: boolean;
  installedAt?: string;
  sampleRate?: number;
  numSpeakers?: number;
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number;
  phase: 'download' | 'extract' | 'finalize';
}

function baseDir(dataDir: string): string {
  return join(dataDir, 'models');
}

function modelDir(dataDir: string, modelId: string): string {
  return join(baseDir(dataDir), modelId);
}

/** 解压时防止 zip-slip / 越界写。 */
function safeJoin(destRoot: string, entryName: string): string | null {
  const target = resolve(destRoot, entryName);
  const root = resolve(destRoot);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/** 去掉包内顶层目录（如 kokoro-multi-lang-v1_1/），保持所有模型布局一致。 */
function stripTopComponent(name: string): string {
  const normalized = name.replace(/\\/g, '/');
  const index = normalized.indexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

async function extractTarBz2(archivePath: string, destRoot: string): Promise<void> {
  const extract = tar.extract();
  extract.on('entry', async (header, stream, next) => {
    try {
      const relative = stripTopComponent(header.name);
      if (!relative) return next();
      const target = safeJoin(destRoot, relative);
      if (!target) return next(); // 越界条目直接丢弃
      if (header.type === 'directory') {
        await mkdir(target, { recursive: true });
        return next();
      }
      if (header.type !== 'file') return next(); // 跳过软链接等
      await mkdir(join(target, '..'), { recursive: true });
      const out = createWriteStream(target);
      let written = 0;
      stream.on('data', chunk => {
        written += (chunk as Buffer).length;
        if (written > MAX_TOTAL_BYTES) {
          stream.destroy(new Error('解压内容超过上限'));
          out.destroy(new Error('解压内容超过上限'));
        }
      });
      await pipeline(stream, out);
      next();
    } catch (error) {
      next(error as Error);
    }
  });
  await pipeline(createReadStream(archivePath), bunzip2(), extract);
}

interface ResolvedFiles {
  model: string;
  tokens: string;
  lexicon?: string;
  voices?: string;
  dict?: string;
  ruleFars?: string;
  ruleFsts?: string;
}

async function listDirRecursive(root: string, prefix = ''): Promise<Array<{ relative: string; absolute: string }>> {
  const items: Array<{ relative: string; absolute: string }> = [];
  const dir = await opendir(root);
  for await (const entry of dir) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      items.push(...await listDirRecursive(absolute, relative));
    } else if (entry.isFile()) {
      items.push({ relative, absolute });
    }
  }
  return items;
}

/**
 * 按角色归位解压后的文件，兼容各家模型包的命名差异：
 * int8/fp16/fp32 共存时优先 int8（CPU 推理更快、更省内存）。
 */
async function resolveModelFiles(dir: string, family: ModelFamily): Promise<ResolvedFiles> {
  const files = await listDirRecursive(dir);
  const byName = new Map(files.map(file => [file.relative.toLowerCase(), file]));
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const hit = byName.get(name.toLowerCase());
      if (hit) return hit.relative;
    }
    return undefined;
  };
  const firstMatch = (pattern: RegExp): string | undefined =>
    files.map(file => file.relative).sort().find(relative => pattern.test(relative));

  const model = family === 'kokoro'
    ? pick('model.int8.onnx', 'model.fp16.onnx', 'model.onnx') ?? firstMatch(/\.onnx$/)
    : pick('model.onnx') ?? firstMatch(/\.onnx$/);
  const tokens = pick('tokens.txt') ?? firstMatch(/tokens\.txt$/);
  // kokoro 多语言包带多个 lexicon（us-en/zh/gb-en），官方要求逗号分隔全部传入。
  const lexiconList = files.map(file => file.relative).filter(relative => /^lexicon[^/]*\.txt$/i.test(relative)).sort();
  const lexicon = lexiconList.length > 1 ? lexiconList.join(',') : pick('lexicon.txt') ?? firstMatch(/lexicon\.txt$/);
  const voices = family === 'kokoro' ? pick('voices.bin') ?? firstMatch(/voices\.bin$/) : undefined;
  // kokoro 中文分词需要的 jieba 字典：可能在 dict-dir 子目录，也可能直接铺在包根
  // （kokoro-multi-lang-v1_1 就是根目录布局，此时 data_dir 直接指向包根）。
  const dictDir = files.map(file => file.relative).sort()
    .find(relative => /^(dict-dir|dict_dir|dict)(\/|$)/i.test(relative));
  const jiebaAtRoot = files.some(file => file.relative.toLowerCase() === 'jieba.dict.utf8');
  // 规则文本归一化：vits 包是 rule.far，kokoro 中文包是 date/number/phone-zh.fst（逗号分隔）。
  const farsList = files.map(file => file.relative).filter(relative => /\.far$/i.test(relative)).sort();
  const fstList = files.map(file => file.relative).filter(relative => /\.fst$/i.test(relative)).sort();
  if (!model || !tokens) throw new Error('模型包缺少 onnx 模型或 tokens.txt，可能不是支持的语音模型');
  if (family === 'kokoro' && !voices) throw new Error('kokoro 模型包缺少 voices.bin');
  return {
    model,
    tokens,
    ...(lexicon ? { lexicon } : {}),
    ...(voices ? { voices } : {}),
    ...(dictDir ? { dict: dictDir.replace(/\/.+$/, '') } : (!dictDir && jiebaAtRoot && family === 'kokoro' ? { dict: '.' } : {})),
    ...(farsList.length > 0 ? { ruleFars: farsList.join(',') } : {}),
    ...(fstList.length > 0 ? { ruleFsts: fstList.join(',') } : {}),
  };
}

/** fetch 两连失败后的兜底：用系统 curl 断点续传下载（--retry 自带续传）。 */
async function downloadWithCurl(url: string, archivePath: string, expectedBytes: number, signal: AbortSignal): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    await run('curl', [
      '-L', '-C', '-', '--retry', '8', '--retry-delay', '2', '--retry-all-errors',
      '--connect-timeout', '30', '--max-time', '7200', '--speed-limit', '10240', '--speed-time', '60',
      '-sS', '-o', archivePath, url,
    ], { signal, maxBuffer: 1024 * 1024 });
    const size = (await stat(archivePath)).size;
    // 拿不到期望大小时接受非空结果，完整性交给解压阶段校验。
    return expectedBytes > 0 ? size === expectedBytes : size > 0;
  } catch {
    return false;
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

export class ModelStore {
  constructor(private readonly dataDir: string) {}

  /** 模型安装根目录：dataDir/models。 */
  root(): string {
    return baseDir(this.dataDir);
  }

  async getInstalled(modelId: string): Promise<InstalledModel | null> {
    const id = sanitizeId(modelId);
    if (!id) return null;
    const meta = await readJson<InstalledModel>(join(modelDir(this.dataDir, id), 'meta.json'));
    if (!meta) return null;
    if (!await dirExists(modelDir(this.dataDir, id))) return null;
    return meta;
  }

  async listInstalled(): Promise<InstalledModel[]> {
    try {
      const dir = await opendir(baseDir(this.dataDir));
      const models: InstalledModel[] = [];
      for await (const entry of dir) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const meta = await readJson<InstalledModel>(join(baseDir(this.dataDir), entry.name, 'meta.json'));
        if (meta) models.push(meta);
      }
      return models;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async listCatalog(): Promise<CatalogEntry[]> {
    const installed = await this.listInstalled();
    return await Promise.all(MODEL_CATALOG.map(async model => {
      const meta = installed.find(item => item.modelId === model.id);
      return {
        ...model,
        installed: !!meta,
        installedAt: meta?.installedAt,
        sampleRate: meta?.sampleRate,
        numSpeakers: meta?.numSpeakers,
      };
    }));
  }

  /**
   * 下载并解压模型。下载走镜像前缀（如 gh-proxy），解压后按 family 校验关键文件。
   * 中途取消或失败都会清理临时目录，不会留下半装状态。
   */
  async download(
    modelId: string,
    options: { mirror?: string; signal: AbortSignal; onProgress?: (progress: DownloadProgress) => void },
  ): Promise<InstalledModel> {
    const model = findCatalogModel(modelId);
    if (!model) throw new Error(`未知模型：${modelId}`);
    if (await this.getInstalled(model.id)) throw new Error('模型已安装，无需重复下载');
    const root = baseDir(this.dataDir);
    await mkdir(root, { recursive: true });
    const tmp = await mkdtemp(join(root, '.tmp-'));
    const archivePath = join(tmp, 'model.tar.bz2');
    try {
      const url = options.mirror ? `${options.mirror.replace(/\/$/, '')}/${model.url}` : model.url;
      options.onProgress?.({ receivedBytes: 0, totalBytes: model.sizeBytes, phase: 'download' });
      // 大文件在直连 GitHub 时容易中断：下载阶段自动重试一次，解压阶段不重试。
      let received = 0;
      let totalBytes = model.sizeBytes;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const response = await fetch(url, { signal: options.signal, redirect: 'follow' });
          if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
          totalBytes = Number(response.headers.get('content-length') ?? 0) || model.sizeBytes;
          received = 0;
          let lastReported = 0;
          const source = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);
          source.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received - lastReported > 4 * 1024 * 1024) {
              lastReported = received;
              options.onProgress?.({ receivedBytes: received, totalBytes, phase: 'download' });
            }
            if (received > MAX_ARCHIVE_BYTES) source.destroy(new Error('下载内容超过上限'));
          });
          await pipeline(source, createWriteStream(archivePath));
          break;
        } catch (error) {
          // fetch 两连失败：退回系统 curl（Windows 10+ / macOS / Linux 均自带），
          // 它的 --retry 自带断点续传，比重新全量下载更能扛弱网。
          if (options.signal.aborted) throw error;
          if (!options.signal.aborted && await downloadWithCurl(url, archivePath, totalBytes, options.signal)) break;
          if (attempt >= 1) {
            throw new Error(`下载失败（已重试）。${String((error as Error).message ?? error)}。直连 GitHub 不稳时，可在音色页配置镜像前缀后重试`);
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      options.onProgress?.({ receivedBytes: received, totalBytes, phase: 'extract' });
      const extractDir = join(tmp, 'files');
      await mkdir(extractDir, { recursive: true });
      await extractTarBz2(archivePath, extractDir);

      options.onProgress?.({ receivedBytes: received, totalBytes, phase: 'finalize' });
      const files = await resolveModelFiles(extractDir, model.family);
      const finalDir = modelDir(this.dataDir, model.id);
      await rm(finalDir, { recursive: true, force: true });
      await rename(extractDir, finalDir);
      const meta: InstalledModel = {
        modelId: model.id,
        family: model.family,
        installedAt: new Date().toISOString(),
        files,
      };
      await writeTextAtomic(join(finalDir, 'meta.json'), JSON.stringify(meta, null, 2));
      return meta;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /** 返回 true 表示删除成功；Windows 下模型被占用时会抛出带指引的错误。 */
  async remove(modelId: string): Promise<boolean> {
    const meta = await this.getInstalled(modelId);
    if (!meta) return false;
    try {
      await rm(modelDir(this.dataDir, sanitizeId(modelId)!), { recursive: true, force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EBUSY' || (error as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error('模型正在被语音引擎占用，请先停用再启用插件，然后重试删除');
      }
      throw error;
    }
  }

  async usageBytes(): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      const entries = await opendir(dir).catch(() => null);
      if (!entries) return;
      for await (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) total += (await stat(path)).size;
      }
    };
    await walk(baseDir(this.dataDir));
    return total;
  }

  async updateMeta(modelId: string, patch: Partial<InstalledModel>): Promise<void> {
    const meta = await this.getInstalled(modelId);
    if (!meta) return;
    await writeTextAtomic(join(modelDir(this.dataDir, sanitizeId(modelId)!), 'meta.json'),
      JSON.stringify({ ...meta, ...patch }, null, 2));
  }

  /**
   * 重新归位已安装模型的文件清单：插件升级新增角色（如 ruleFars）时，
   * 老模型不用重新下载，加载引擎时调用一次即可补齐 meta。
   */
  async refreshFiles(modelId: string): Promise<InstalledModel | null> {
    const meta = await this.getInstalled(modelId);
    if (!meta) return null;
    const dir = modelDir(this.dataDir, sanitizeId(modelId)!);
    const files = await resolveModelFiles(dir, meta.family);
    const merged = { ...meta, files: { ...meta.files, ...files } };
    await writeTextAtomic(join(dir, 'meta.json'), JSON.stringify(merged, null, 2));
    return merged;
  }

  /** 只为测试暴露：读取模型目录下相对路径文件的完整路径。 */
  resolveFile(modelId: string, relative: string): string {
    const target = safeJoin(modelDir(this.dataDir, sanitizeId(modelId)!), relative);
    if (!target) throw new Error('非法路径');
    return target;
  }
}
