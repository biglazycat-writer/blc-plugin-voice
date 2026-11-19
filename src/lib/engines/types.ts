export interface EngineVoice {
  /** 全局唯一：`<engineId>:<原生标识>`，跨引擎不冲突。 */
  id: string;
  engineId: string;
  name: string;
  lang: string;
  gender: 'female' | 'male' | 'unknown';
  tags: string[];
  /** 本音色原生采样率；全部产物会归一到 24000 Hz。 */
  nativeSampleRate?: number;
  /** 神经模型音色才有的模型 ID。 */
  modelId?: string;
  /** 多说话人模型里的说话人序号。 */
  speakerId?: number;
}

export interface SynthesisRequest {
  text: string;
  voice: EngineVoice;
  /** 0.5–2.0。 */
  speed: number;
  /** 0–200，100 表示不变。 */
  volume: number;
  /** 神经引擎不支持时忽略。 */
  pitch: number;
  outFile: string;
  signal: AbortSignal;
}

export interface BatchOptions {
  onProgress?: (completed: number, total: number) => void;
  signal: AbortSignal;
}

export interface EngineInfo {
  id: string;
  displayName: string;
  /** system 内置开箱即用；neural 需要下载模型。 */
  kind: 'system' | 'neural';
  supportsPitch: boolean;
  available: boolean;
  reason?: string;
}

export interface TtsEngine {
  readonly info: EngineInfo;
  /** 探测可用性并返回音色目录；结果由注册表缓存。 */
  listVoices(): Promise<EngineVoice[]>;
  synthesize(request: SynthesisRequest): Promise<{ durationMs: number }>;
  /** 引擎可用更快的整批实现时覆盖；默认逐段调用 synthesize。 */
  synthesizeBatch?(requests: SynthesisRequest[], options: BatchOptions): Promise<{ durationMs: number }>;
  /** 停用时释放子进程与模型句柄。 */
  dispose(): void;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('操作已取消');
    error.name = 'AbortError';
    throw error;
  }
}

export function isAbortError(error: unknown): boolean {
  return (error as Error)?.name === 'AbortError' || String((error as Error)?.message ?? '').includes('aborted');
}
