import { ModelStore } from '../model-store.js';
import { SapiEngine } from './sapi.js';
import { SayEngine } from './say.js';
import { EspeakEngine } from './espeak.js';
import { SherpaEngine } from './sherpa.js';
import type { EngineInfo, EngineVoice, TtsEngine } from './types.js';

export class EngineRegistry {
  private readonly engines: TtsEngine[];
  private voicesCache: EngineVoice[] | null = null;

  constructor(models: ModelStore) {
    const platformEngines: TtsEngine[] = [];
    if (process.platform === 'win32') platformEngines.push(new SapiEngine());
    if (process.platform === 'darwin') platformEngines.push(new SayEngine());
    if (process.platform === 'linux') platformEngines.push(new EspeakEngine());
    platformEngines.push(new SherpaEngine(models));
    this.engines = platformEngines;
  }

  list(): TtsEngine[] {
    return [...this.engines];
  }

  infos(): EngineInfo[] {
    return this.engines.map(engine => ({ ...engine.info }));
  }

  /** 跨引擎音色目录；探测有开销，结果缓存到停用为止。 */
  async allVoices(): Promise<EngineVoice[]> {
    if (this.voicesCache) return this.voicesCache;
    const results = await Promise.all(this.engines.map(async engine => {
      try {
        return await engine.listVoices();
      } catch {
        return [];
      }
    }));
    this.voicesCache = results.flat();
    return this.voicesCache;
  }

  async resolveVoice(voiceId: string): Promise<{ engine: TtsEngine; voice: EngineVoice }> {
    const voices = await this.allVoices();
    const voice = voices.find(item => item.id === voiceId);
    if (!voice) throw new Error(`找不到音色：${voiceId}（模型可能未安装，请刷新音色列表）`);
    const engine = this.engines.find(item => item.info.id === voice.engineId);
    if (!engine) throw new Error(`音色对应的引擎不可用：${voice.engineId}`);
    return { engine, voice };
  }

  invalidate(): void {
    this.voicesCache = null;
  }

  dispose(): void {
    for (const engine of this.engines) engine.dispose();
  }
}
