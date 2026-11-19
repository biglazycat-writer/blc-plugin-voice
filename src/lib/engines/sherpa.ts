import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstalledModel, ModelStore } from '../model-store.js';
import { findCatalogModel, speakerLabelFor } from '../catalog.js';
import { encodeWav, floatToInt16, resampleLinear, clampNumber, TARGET_SAMPLE_RATE } from '../util.js';
import { normalizeZhReadingText, normalizeLoudness, applyFades, appendTailSilence } from '../normalize.js';
import { throwIfAborted, type EngineInfo, type EngineVoice, type SynthesisRequest, type TtsEngine } from './types.js';

interface SherpaGeneratedAudio {
  samples: Float32Array;
  sampleRate: number;
}

interface SherpaOfflineTts {
  sampleRate: number;
  numSpeakers: number;
  generate(request: { text: string; sid: number; speed: number }): SherpaGeneratedAudio;
  generateAsync(request: {
    text: string;
    sid: number;
    speed: number;
    onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void;
  }): Promise<SherpaGeneratedAudio>;
}

interface SherpaModule {
  OfflineTts: new (config: Record<string, unknown>) => SherpaOfflineTts;
}

export interface SherpaAvailability {
  ok: boolean;
  reason?: string;
}

/** sherpa-onnx-node 是可选依赖：未安装时优雅降级，不影响其他引擎。 */
async function loadSherpaModule(): Promise<SherpaModule | null> {
  try {
    // CJS 包经 ESM dynamic import 时，导出在 default 命名空间下。
    const imported = (await import('sherpa-onnx-node')) as unknown as Record<string, unknown>;
    const mod = (imported.OfflineTts ? imported : (imported.default as Record<string, unknown> | undefined)) ?? imported;
    return mod as unknown as SherpaModule;
  } catch {
    return null;
  }
}

function buildConfig(model: InstalledModel): Record<string, unknown> {
  const files = model.files;
  const modelConfig: Record<string, unknown> = model.family === 'kokoro'
    ? {
        model: files.model,
        voices: files.voices,
        tokens: files.tokens,
        // kokoro 多语言包：lexicon 可为逗号分隔的多个文件（官方要求 us-en + zh 全传），
        // dataDir 指向包根（内含 espeak-ng 字典与 jieba 分词文件）。
        ...(files.lexicon ? { lexicon: files.lexicon } : {}),
        ...(files.dict ? { dataDir: files.dict } : {}),
        lang: '',
      }
    : {
        model: files.model,
        tokens: files.tokens,
        ...(files.lexicon ? { lexicon: files.lexicon } : {}),
        // vits 数据目录兜底（keqing 等包的 dict 目录用于中文分词）。
        ...(files.dict ? { dataDir: files.dict } : {}),
      };
  return {
    model: { [model.family]: modelConfig },
    // 规则文本归一化（数字/日期/电话）：vits 用 rule.far，kokoro 中文用一组 fst。
    ...(files.ruleFars ? { ruleFars: files.ruleFars } : {}),
    ...(files.ruleFsts ? { ruleFsts: files.ruleFsts } : {}),
    numThreads: 2,
    provider: 'cpu',
    debug: 0,
  };
}

/**sherpa 配置里的相对路径要解析到模型目录；lexicon/ruleFsts 可能是逗号分隔的多文件。 */
function absolutizeConfig(config: Record<string, unknown>, modelRoot: string, family: string): Record<string, unknown> {
  const isAbsolute = (value: string): boolean => /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
  const absolutize = (value: string): string =>
    isAbsolute(value) ? value : value.split(',').map(part => part.trim() ? join(modelRoot, part.trim()) : part).join(',');
  const modelConfig = (config.model as Record<string, Record<string, unknown>>)[family];
  for (const [key, value] of Object.entries(modelConfig)) {
    if (typeof value === 'string' && value && !isAbsolute(value)) {
      modelConfig[key] = absolutize(value);
    }
  }
  for (const key of ['ruleFars', 'ruleFsts'] as const) {
    if (typeof config[key] === 'string' && config[key] && !isAbsolute(config[key] as string)) {
      config[key] = absolutize(config[key] as string);
    }
  }
  return config;
}

export class SherpaEngine implements TtsEngine {
  readonly info: EngineInfo = {
    id: 'sherpa',
    displayName: '本地神经网络模型',
    kind: 'neural',
    supportsPitch: false,
    available: false,
  };
  private readonly loaded = new Map<string, SherpaOfflineTts>();
  private modulePromise: Promise<SherpaModule | null> | null = null;

  constructor(private readonly models: ModelStore) {}

  private module(): Promise<SherpaModule | null> {
    this.modulePromise ??= loadSherpaModule();
    return this.modulePromise;
  }

  /** 探测组件与已装模型；组件缺失时给出明确的补装指引。 */
  async probe(): Promise<SherpaAvailability> {
    const module = await this.module();
    if (!module) return { ok: false, reason: '未安装 sherpa-onnx-node 组件（可选依赖），请重新安装插件并勾选「准备依赖」' };
    const installed = await this.models.listInstalled();
    return { ok: true, ...(installed.length === 0 ? { reason: '还没有已安装的模型，请在模型页下载一个' } : {}) };
  }

  private async ensureModel(modelId: string): Promise<{ tts: SherpaOfflineTts; meta: InstalledModel }> {
    const module = await this.module();
    if (!module) throw new Error('未安装 sherpa-onnx-node 组件，请重新安装插件并勾选「准备依赖」');
    const meta = await this.models.getInstalled(modelId);
    if (!meta) throw new Error('模型尚未安装，请先在模型页下载');
    const existing = this.loaded.get(modelId);
    if (existing) return { tts: existing, meta };
    // 插件升级可能引入新的文件角色（如 ruleFars），老模型加载时补齐一次。
    const refreshed = await this.models.refreshFiles(modelId).catch(() => null);
    const effective = refreshed ?? meta;
    const modelRoot = join(this.models.root(), modelId);
    const config = absolutizeConfig(buildConfig(effective), modelRoot, effective.family);
    const tts = new module.OfflineTts(config);
    this.loaded.set(modelId, tts);
    if (tts.sampleRate !== effective.sampleRate || tts.numSpeakers !== effective.numSpeakers) {
      await this.models.updateMeta(modelId, { sampleRate: tts.sampleRate, numSpeakers: tts.numSpeakers });
    }
    return { tts, meta: effective };
  }

  async listVoices(): Promise<EngineVoice[]> {
    const availability = await this.probe();
    this.info.available = availability.ok;
    this.info.reason = availability.reason;
    if (!availability.ok && availability.reason?.includes('sherpa-onnx-node')) return [];
    const installed = await this.models.listInstalled();
    const voices: EngineVoice[] = [];
    for (const meta of installed) {
      const catalog = findCatalogModel(meta.modelId);
      const speakers = meta.numSpeakers ?? catalog?.speakers ?? 1;
      for (let sid = 0; sid < Math.max(1, speakers); sid += 1) {
        const label = catalog ? speakerLabelFor(catalog, sid) : { name: `说话人 ${sid + 1}`, lang: 'zh', gender: 'unknown' as const };
        voices.push({
          id: `sherpa:${meta.modelId}:${sid}`,
          engineId: 'sherpa',
          name: label.name,
          lang: label.lang,
          gender: label.gender,
          tags: [catalog?.displayName ?? meta.modelId, ...(catalog?.langs ?? [])],
          nativeSampleRate: meta.sampleRate,
          modelId: meta.modelId,
          speakerId: sid,
        });
      }
    }
    return voices;
  }

  async synthesize(request: SynthesisRequest): Promise<{ durationMs: number }> {
    const { tts, meta } = await this.ensureModel(request.voice.modelId ?? '');
    throwIfAborted(request.signal);
    const sid = clampNumber(request.voice.speakerId ?? 0, 0, tts.numSpeakers - 1, 0);
    const speed = clampNumber(request.speed, 0.5, 2, 1);
    // 中文音色先做数字/日期/百分比归一，避免神经模型把阿拉伯数字读错或读丢。
    const text = request.voice.lang.startsWith('zh') ? normalizeZhReadingText(request.text) : request.text;
    const audio = await tts.generateAsync({
      text,
      sid: Math.floor(sid),
      speed,
      onProgress: () => (request.signal.aborted ? 0 : 1),
    });
    throwIfAborted(request.signal);
    const volume = clampNumber(request.volume / 100, 0, 2, 1);
    let samples = resampleLinear(audio.samples, audio.sampleRate, TARGET_SAMPLE_RATE);
    // 拟人化后处理：响度归一 → 音量微调 → 首尾淡入淡出 → 段尾呼吸静音。
    samples = normalizeLoudness(samples);
    if (volume !== 1) samples = samples.map(value => value * volume);
    samples = applyFades(samples, TARGET_SAMPLE_RATE);
    samples = appendTailSilence(samples, TARGET_SAMPLE_RATE);
    const pcm = floatToInt16(samples);
    await writeFile(request.outFile, encodeWav(pcm, TARGET_SAMPLE_RATE));
    void meta;
    return { durationMs: Math.round((pcm.length * 1000) / TARGET_SAMPLE_RATE) };
  }

  async synthesizeBatch(requests: SynthesisRequest[], options: { onProgress?: (completed: number, total: number) => void; signal: AbortSignal }): Promise<{ durationMs: number }> {
    let durationMs = 0;
    let completed = 0;
    for (const request of requests) {
      throwIfAborted(options.signal);
      durationMs += (await this.synthesize(request)).durationMs;
      completed += 1;
      options.onProgress?.(completed, requests.length);
    }
    return { durationMs };
  }

  /** 停用或删除模型前释放句柄，否则 Windows 下模型文件会保持占用。 */
  async releaseModel(modelId: string): Promise<void> {
    this.loaded.delete(modelId);
    if (globalThis.gc) globalThis.gc();
  }

  dispose(): void {
    this.loaded.clear();
  }
}
