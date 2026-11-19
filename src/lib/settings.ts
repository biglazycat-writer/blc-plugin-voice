import type { PluginContext, Json } from 'blc-plugin-sdk';
import { clampNumber } from './util.js';

export interface VoiceParams {
  speed: number;
  pitch: number;
  volume: number;
}

export interface VoiceSettings {
  version: 1;
  favorites: Record<string, boolean>;
  roles: { reader: string; host: string; guest: string };
  /** 每音色覆盖参数；未设置的音色用 defaults。 */
  params: Record<string, Partial<VoiceParams>>;
  defaults: VoiceParams;
  /** 下载镜像前缀，如 https://gh-proxy.com/。 */
  mirror: string;
  /** 朗读是否连播下一段。 */
  autoContinue: boolean;
}

export const DEFAULT_SETTINGS: VoiceSettings = {
  version: 1,
  favorites: {},
  roles: { reader: '', host: '', guest: '' },
  params: {},
  defaults: { speed: 1, pitch: 0, volume: 100 },
  mirror: '',
  autoContinue: true,
};

const STORAGE_KEY = 'voice.settings';

function isRecord(value: Json | undefined): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migrate(value: Json | undefined): VoiceSettings {
  if (!isRecord(value)) return { ...DEFAULT_SETTINGS, favorites: {}, params: {} };
  const source = value as Record<string, unknown>;
  const roles = isRecord(source.roles as Json) ? source.roles as Record<string, unknown> : {};
  return {
    version: 1,
    favorites: Object.fromEntries(
      Object.entries(isRecord(source.favorites as Json) ? source.favorites as Record<string, unknown> : {})
        .filter(([, enabled]) => typeof enabled === 'boolean'),
    ) as Record<string, boolean>,
    roles: {
      reader: typeof roles.reader === 'string' ? roles.reader : '',
      host: typeof roles.host === 'string' ? roles.host : '',
      guest: typeof roles.guest === 'string' ? roles.guest : '',
    },
    params: Object.fromEntries(
      Object.entries(isRecord(source.params as Json) ? source.params as Record<string, unknown> : {})
        .filter(([, params]) => isRecord(params as Json))
        .map(([id, params]) => {
          const record = params as Record<string, unknown>;
          const entry: Partial<VoiceParams> = {};
          if (typeof record.speed === 'number') entry.speed = clampNumber(record.speed, 0.5, 2, 1);
          if (typeof record.pitch === 'number') entry.pitch = clampNumber(record.pitch, -50, 50, 0);
          if (typeof record.volume === 'number') entry.volume = clampNumber(record.volume, 0, 200, 100);
          return [id, entry];
        })
        .filter(([, entry]) => Object.keys(entry).length > 0),
    ) as Record<string, Partial<VoiceParams>>,
    defaults: (() => {
      const sourceDefaults = isRecord(source.defaults as Json) ? source.defaults as Record<string, unknown> : {};
      return {
        speed: clampNumber(sourceDefaults.speed, 0.5, 2, DEFAULT_SETTINGS.defaults.speed),
        pitch: clampNumber(sourceDefaults.pitch, -50, 50, DEFAULT_SETTINGS.defaults.pitch),
        volume: clampNumber(sourceDefaults.volume, 0, 200, DEFAULT_SETTINGS.defaults.volume),
      };
    })(),
    mirror: typeof source.mirror === 'string' ? source.mirror : '',
    autoContinue: typeof source.autoContinue === 'boolean' ? source.autoContinue : DEFAULT_SETTINGS.autoContinue,
  };
}

export class SettingsStore {
  private cache: VoiceSettings | null = null;

  constructor(private readonly ctx: Pick<PluginContext, 'storage'>) {}

  async get(): Promise<VoiceSettings> {
    if (this.cache) return this.cache;
    this.cache = migrate(await this.ctx.storage.get(STORAGE_KEY));
    return this.cache;
  }

  /** 浅合并顶层字段的补丁写入，返回合并后的完整设置。 */
  async update(patch: Record<string, unknown>): Promise<VoiceSettings> {
    const current = await this.get();
    const next: VoiceSettings = { ...current };
    if (patch.favorites && typeof patch.favorites === 'object' && !Array.isArray(patch.favorites)) {
      next.favorites = { ...current.favorites, ...(patch.favorites as Record<string, boolean>) };
    }
    if (patch.roles && typeof patch.roles === 'object' && !Array.isArray(patch.roles)) {
      next.roles = { ...current.roles, ...(patch.roles as VoiceSettings['roles']) };
    }
    if (patch.params && typeof patch.params === 'object' && !Array.isArray(patch.params)) {
      next.params = { ...current.params };
      for (const [voiceId, params] of Object.entries(patch.params as Record<string, unknown>)) {
        if (params === null) {
          delete next.params[voiceId];
          continue;
        }
        if (params && typeof params === 'object' && !Array.isArray(params)) {
          next.params[voiceId] = { ...current.params[voiceId], ...(params as Partial<VoiceParams>) };
        }
      }
    }
    if (patch.defaults && typeof patch.defaults === 'object' && !Array.isArray(patch.defaults)) {
      next.defaults = { ...current.defaults, ...(patch.defaults as VoiceParams) };
    }
    if (typeof patch.mirror === 'string') next.mirror = patch.mirror.trim();
    if (typeof patch.autoContinue === 'boolean') next.autoContinue = patch.autoContinue;
    this.cache = migrate(JSON.parse(JSON.stringify(next)) as Json);
    await this.ctx.storage.set(STORAGE_KEY, this.cache as unknown as Json);
    return this.cache;
  }

  /** 音色的最终合成参数：个人覆盖 > 全局默认。 */
  async paramsFor(voiceId: string): Promise<VoiceParams> {
    const settings = await this.get();
    return { ...settings.defaults, ...settings.params[voiceId] };
  }
}
