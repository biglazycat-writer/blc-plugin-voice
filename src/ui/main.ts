import { connect } from 'blc-plugin-sdk/browser';
import type { Json } from 'blc-plugin-sdk';
import './style.css';

// ---------- 类型 ----------

interface VoiceRow {
  id: string;
  engineId: string;
  name: string;
  lang: string;
  gender: 'female' | 'male' | 'unknown';
  tags: string[];
  nativeSampleRate?: number;
  modelId?: string;
  speakerId?: number;
}

interface EngineRow {
  id: string;
  displayName: string;
  kind: 'system' | 'neural';
  supportsPitch: boolean;
  available: boolean;
  reason?: string;
}

interface Settings {
  favorites: Record<string, boolean>;
  roles: { reader: string; host: string; guest: string };
  params: Record<string, { speed?: number; pitch?: number; volume?: number }>;
  defaults: { speed: number; pitch: number; volume: number };
  mirror: string;
  autoContinue: boolean;
}

interface Segment {
  index: number;
  text: string;
  speaker?: string;
  voiceId: string;
  bytes: number;
  durationMs: number;
}

interface AudioManifest {
  audioId: string;
  kind: 'reading' | 'podcast' | 'test';
  segments: Segment[];
  meta: Record<string, string | number | boolean>;
  linePauseMs?: number;
}

interface CatalogModel {
  id: string;
  family: string;
  displayName: string;
  langs: string[];
  sizeBytes: number;
  speakers: number;
  quality: string;
  recommended?: boolean;
  note: string;
  installed: boolean;
  numSpeakers?: number;
  sampleRate?: number;
}

interface PodcastScript {
  scriptId: string;
  title: string;
  style: 'solo' | 'duet';
  source: 'ai' | 'fallback';
  lines: Array<{ speaker: 'host' | 'guest'; text: string }>;
}

type Tab = 'podcast' | 'voices';
type SourceMode = 'article' | 'text';
type VoiceFilter = 'all' | 'female' | 'male' | 'fav';

// ---------- 基础设施 ----------

const sdk = await connect();
const session = await sdk.context();

document.documentElement.dataset.theme = session.colorScheme
  ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/^Error:\s*/, '');
}

function showToast(message: string, isError = false): void {
  const toast = el('div', `toast${isError ? ' error' : ''}`, message);
  document.body.append(toast);
  setTimeout(() => toast.remove(), 4200);
}

/** 发起后台命令并轮询任务直到结束，返回结果（失败抛错）。 */
async function invoke<T>(command: string, args: Record<string, unknown> = {}, onProgress?: (value: number) => void): Promise<T> {
  const task = await sdk.commands.invoke(command, args as Json);
  for (;;) {
    const current = await sdk.tasks.get(task.id);
    if (current.state === 'completed') return current.result as unknown as T;
    if (current.state === 'failed') throw new Error(current.error ?? '命令执行失败');
    if (current.state === 'cancelled') throw new Error('任务已取消');
    onProgress?.(current.progress);
    await new Promise(resolve => setTimeout(resolve, 400));
  }
}

/** 与 invoke 相同，但返回取消句柄，用于长任务。 */
function startTask<T>(command: string, args: Record<string, unknown>, onProgress?: (value: number) => void): { promise: Promise<T>; cancel(): void } {
  let taskId = '';
  const promise = (async () => {
    const task = await sdk.commands.invoke(command, args as Json);
    taskId = task.id;
    for (;;) {
      const current = await sdk.tasks.get(taskId);
      if (current.state === 'completed') return current.result as unknown as T;
      if (current.state === 'failed') throw new Error(current.error ?? '命令执行失败');
      if (current.state === 'cancelled') throw new Error('任务已取消');
      onProgress?.(current.progress);
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  })();
  return {
    promise,
    cancel: () => {
      if (taskId) void sdk.tasks.cancel(taskId).catch(() => {});
    },
  };
}

function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------- 音频播放 ----------

const PLAYER_SAMPLE_RATE = 24000;
const MAX_CACHED_BUFFERS = 10;

/** 段落音频顺序播放器：分块拉取 base64 → 解码 → 连播，行间可插停顿。 */
class SegmentPlayer {
  private audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private volume = 1;
  private currentSource: AudioBufferSourceNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private fetchOrder: string[] = [];
  private playing = false;
  private index = 0;
  private offsetInSegment = 0;
  private startedAt = 0;
  private rate = 1;
  private timer: number | null = null;
  /** 世代号：play/pause/stopAll 交替时作废仍在拉取音频的旧一轮播放，避免双声或无视暂停。 */
  private generation = 0;

  constructor(
    private readonly audioId: () => string,
    private readonly getSegments: () => Segment[],
    private readonly getPauseMs: () => number,
    private readonly onIndexChange: (index: number) => void,
    private readonly onTick: (playing: boolean, index: number, elapsedMs: number) => void,
  ) {}

  private ctx(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ sampleRate: PLAYER_SAMPLE_RATE });
      this.gain = this.audioCtx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.audioCtx.destination);
    }
    return this.audioCtx;
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(2, rate));
    if (this.currentSource) this.currentSource.playbackRate.value = this.rate;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  release(): void {
    void this.stopAll();
    this.buffers.clear();
    this.fetchOrder = [];
  }

  async seek(index: number): Promise<void> {
    await this.play(index);
  }

  /** 按累计时长定位：跨段落换算成「第几段 + 段内偏移」。 */
  async seekToMs(ms: number): Promise<void> {
    const segments = this.getSegments();
    if (segments.length === 0) return;
    let remaining = Math.max(0, ms);
    for (let i = 0; i < segments.length; i += 1) {
      const duration = segments[i].durationMs || 0;
      if (remaining < duration || i === segments.length - 1) {
        await this.play(i, Math.min(remaining, duration) / 1000);
        return;
      }
      remaining -= duration;
    }
  }

  current(): { index: number; playing: boolean } {
    return { index: this.index, playing: this.playing };
  }

  private async fetchBuffer(index: number): Promise<AudioBuffer | null> {
    const audioId = this.audioId();
    if (!audioId) return null;
    // 缓存按 audioId 区分：重新合成会拿到同名 audioId 的新内容。
    const cacheKey = `${audioId}:${index}`;
    const cached = this.buffers.get(cacheKey);
    if (cached) return cached;
    const segments = this.getSegments();
    if (index < 0 || index >= segments.length) return null;
    const parts: Uint8Array[] = [];
    let offset = 0;
    let hash: string | undefined;
    for (;;) {
      const chunk = await invoke<{ chunk: string; hash: string; total: number; nextOffset: number; complete: boolean }>(
        'voice.audio.read',
        { audioId, index, offset, hash },
      );
      hash = chunk.hash;
      parts.push(base64Bytes(chunk.chunk));
      if (chunk.complete) break;
      offset = chunk.nextOffset;
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const all = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
      all.set(part, cursor);
      cursor += part.length;
    }
    const buffer = await this.ctx().decodeAudioData(all.buffer);
    if (this.buffers.size >= MAX_CACHED_BUFFERS) {
      const oldest = this.fetchOrder.shift();
      if (oldest !== undefined) this.buffers.delete(oldest);
    }
    this.buffers.set(cacheKey, buffer);
    this.fetchOrder.push(cacheKey);
    return buffer;
  }

  private async prefetch(index: number): Promise<void> {
    try {
      await this.fetchBuffer(index);
    } catch {
      // 预取失败不打断播放，真正播到该段时会重试
    }
  }

  async play(fromIndex: number, fromOffset = 0): Promise<void> {
    const gen = ++this.generation;
    await this.stopCurrent();
    if (gen !== this.generation) return;
    this.playing = true;
    this.index = fromIndex;
    this.offsetInSegment = fromOffset;
    this.onIndexChange(fromIndex);
    await this.playCurrent(gen);
    if (gen !== this.generation) return;
    void this.prefetch(fromIndex + 1);
  }

  private async playCurrent(gen: number): Promise<void> {
    const buffer = await this.fetchBuffer(this.index);
    if (gen !== this.generation) return;
    if (!buffer) {
      this.playing = false;
      this.onTick(false, this.index, 0);
      return;
    }
    const ctx = this.ctx();
    if (ctx.state === 'suspended') await ctx.resume();
    if (gen !== this.generation) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.gain ?? ctx.destination);
    const gapMs = this.index > 0 && this.offsetInSegment === 0 ? this.getPauseMs() : 0;
    const when = ctx.currentTime + 0.03 + gapMs / 1000;
    this.startedAt = when;
    source.start(when, this.offsetInSegment);
    this.currentSource = source;
    this.onTick(true, this.index, this.offsetInSegment * 1000);
    source.onended = () => {
      if (this.currentSource !== source || !this.playing) return;
      this.currentSource = null;
      const segments = this.getSegments();
      if (this.index + 1 < segments.length) {
        this.index += 1;
        this.offsetInSegment = 0;
        this.onIndexChange(this.index);
        void this.playCurrent(gen);
        void this.prefetch(this.index + 1);
      } else {
        this.playing = false;
        this.offsetInSegment = 0;
        this.onTick(false, this.index, 0);
      }
    };
    if (this.timer === null) {
      this.timer = window.setInterval(() => {
        if (!this.playing || !this.currentSource || !this.audioCtx) return;
        const elapsed = (this.audioCtx.currentTime - this.startedAt) * this.rate + this.offsetInSegment * 1000;
        this.onTick(true, this.index, Math.max(0, elapsed));
      }, 250);
    }
  }

  private async stopCurrent(): Promise<void> {
    if (this.currentSource) {
      this.currentSource.onended = null;
      try {
        this.currentSource.stop();
      } catch {
        // 已经停止
      }
      this.currentSource.disconnect();
      this.currentSource = null;
    }
  }

  async pause(): Promise<void> {
    if (!this.playing) return;
    // 仍在 fetch 的 playCurrent 完成后会照常 source.start()，先作废这一代让它放弃启动。
    this.generation += 1;
    if (this.audioCtx && this.currentSource) {
      const elapsed = (this.audioCtx.currentTime - this.startedAt) * this.rate + this.offsetInSegment * 1000;
      this.offsetInSegment = Math.max(0, elapsed / 1000);
    }
    this.playing = false;
    await this.stopCurrent();
    this.onTick(false, this.index, this.offsetInSegment * 1000);
  }

  async toggle(index?: number): Promise<void> {
    if (this.playing) {
      await this.pause();
      return;
    }
    if (index !== undefined && index !== this.index) {
      await this.play(index);
      return;
    }
    await this.play(this.index, this.offsetInSegment);
  }

  async stopAll(): Promise<void> {
    this.generation += 1;
    this.playing = false;
    await this.stopCurrent();
    this.offsetInSegment = 0;
    this.index = 0;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.onTick(false, 0, 0);
  }
}

// ---------- 页面状态 ----------

const restored = session.state && typeof session.state === 'object' && !Array.isArray(session.state)
  ? session.state as Record<string, Json>
  : {};

const state = {
  tab: (session.viewId === 'settings' || restored.tab === 'voices' ? 'voices' : 'podcast') as Tab,
  voiceId: typeof restored.voiceId === 'string' ? restored.voiceId : '',
  speed: typeof restored.speed === 'number' && restored.speed >= 0.5 && restored.speed <= 2 ? restored.speed : 1,
  scriptId: typeof restored.scriptId === 'string' ? restored.scriptId : '',
  style: (restored.style === 'solo' ? 'solo' : 'duet') as 'solo' | 'duet',
  minutes: typeof restored.minutes === 'number' && restored.minutes >= 1 && restored.minutes <= 30 ? restored.minutes : 5,
  useAi: restored.useAi !== false,
  sourceMode: (restored.sourceMode === 'text' ? 'text' : 'article') as SourceMode,
  podcastAudioId: typeof restored.podcastAudioId === 'string' ? restored.podcastAudioId : '',
  articlePath: typeof restored.articlePath === 'string' && restored.workspaceId === session.context.workspaceId ? restored.articlePath : '',
  workspaceId: session.context.workspaceId ?? '',
};

let saveTimer: number | null = null;
function markDirty(): void {
  if (saveTimer !== null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void sdk.setState(state as unknown as Json, true).catch(() => {});
  }, 300);
}

sdk.onSave(async () => {
  await sdk.setState(state as unknown as Json, false);
});

// ---------- 全局数据 ----------

let podcastManifest: AudioManifest | null = null;
let script: PodcastScript | null = null;
let voicesData: { voices: VoiceRow[]; settings: Settings; engines: EngineRow[] } | null = null;
let modelsData: { models: CatalogModel[]; engines: EngineRow[]; mirror: string } | null = null;

async function refreshVoices(): Promise<void> {
  voicesData = await invoke<{ voices: VoiceRow[]; settings: Settings; engines: EngineRow[] }>('voice.voices.list');
  const roles = voicesData.settings.roles;
  const valid = (id: string) => voicesData?.voices.some(voice => voice.id === id);
  if (!state.voiceId || !valid(state.voiceId)) {
    state.voiceId = [roles.reader, roles.host, voicesData.voices[0]?.id].find(id => id && valid(id)) ?? '';
  }
}

async function refreshManifest(audioId: string): Promise<AudioManifest | null> {
  if (!audioId) return null;
  try {
    const manifest = await invoke<AudioManifest>('voice.audio.info', { audioId });
    podcastManifest = manifest;
    return manifest;
  } catch {
    return null;
  }
}

function engineInfo(engineId: string): EngineRow | undefined {
  return voicesData?.engines.find(engine => engine.id === engineId) ?? modelsData?.engines.find(engine => engine.id === engineId);
}

// ---------- 图标 ----------

const ICONS: Record<string, string> = {
  wave: '<path d="M3 10.5v3M7 7v10M11 4v16M15 8v8M19 10.5v3"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  paste: '<rect x="8" y="4" width="9" height="17" rx="2"/><path d="M11 4V3h3v1"/><path d="M5 7v13a1 1 0 0 0 1 1h1"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="17" r="2"/>',
  mic: '<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.6"/><rect x="17" y="14" width="4" height="6" rx="1.6"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.6a3 3 0 0 1 0 5.8M17.5 19a5.2 5.2 0 0 0-2-4.1"/>',
  user: '<circle cx="12" cy="8" r="3.4"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  play: '<path d="M8 5.2v13.6L19 12z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  prev: '<path d="M18 6.5v11L9.5 12z" fill="currentColor" stroke="none"/><path d="M6 5.5v13"/>',
  next: '<path d="M6 6.5v11L14.5 12z" fill="currentColor" stroke="none"/><path d="M18 5.5v13"/>',
  volume: '<path d="M4 9.5h3L12 5.5v13L7 14.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  download: '<path d="M12 4v10M8 10.5l4 4 4-4"/><path d="M5 19h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5V4.5A1.5 1.5 0 0 0 13.5 3H5.5A1.5 1.5 0 0 0 4 4.5v8A1.5 1.5 0 0 0 5.5 14h1"/>',
  star: '<path d="M12 3.6l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.9-5.2 2.9 1-5.9L3.5 9.8l5.9-.8z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.5V10h-5.4"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  bulb: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.5 10.9V17h7v-3.1A6 6 0 0 0 12 3z"/>',
  sparkle: '<path d="M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7z"/><path d="M18.5 15l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>',
  chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2"/>',
  folder: '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l1.8 2h6A2 2 0 0 1 18.5 9.5v7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M14 6l4 4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4.5V10h5.4"/>',
  wavebig: '<path d="M3 10v4M7 6.5v11M11 3.5v17M15 7v10M19 10v4"/>',
};

function icon(name: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

function btn(label: string, className = 'btn', iconName?: string): HTMLButtonElement {
  const node = el('button', className);
  node.type = 'button';
  if (iconName) node.append(icon(iconName, 14));
  node.append(document.createTextNode(label));
  return node;
}

function optionEl(value: string, label: string): HTMLOptionElement {
  const node = el('option', '', label);
  node.value = value;
  return node;
}

function iconBtn(name: string, title: string, size = 15): HTMLButtonElement {
  const node = el('button', 'icon-btn');
  node.type = 'button';
  node.title = title;
  node.setAttribute('aria-label', title);
  node.append(icon(name, size));
  return node;
}

function rangeInput(opts: { min: number; max: number; step: number; value: number; className?: string; disabled?: boolean }): HTMLInputElement {
  const input = el('input');
  input.type = 'range';
  input.min = String(opts.min);
  input.max = String(opts.max);
  input.step = String(opts.step);
  input.value = String(opts.value);
  input.disabled = Boolean(opts.disabled);
  if (opts.className) input.className = opts.className;
  return input;
}

function setRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const ratio = max > min ? (Number(input.value) - min) / (max - min) : 0;
  input.style.setProperty('--fill', `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(2)}%`);
}

function refreshRangeFills(scope: ParentNode = document): void {
  scope.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(setRangeFill);
}

document.addEventListener('input', event => {
  if (event.target instanceof HTMLInputElement && event.target.type === 'range') setRangeFill(event.target);
});

// ---------- 页头 ----------

const app = el('div', 'app');
const appbar = el('div', 'appbar');

const brand = el('div', 'brand');
const brandMark = el('div', 'brand-mark');
brandMark.append(icon('wavebig', 22));
const brandText = el('div');
const brandTitle = el('h1', 'brand-title', '语音工坊');
const brandSub = el('p', 'brand-sub', '把文章变成自然流畅的播客');
brandText.append(brandTitle, brandSub);
brand.append(brandMark, brandText);

const tools = el('div', 'appbar-tools');
const engineChip = el('span', 'engine-chip');
const engineText = el('span', '', '引擎检测中…');
engineChip.append(el('span', 'dot'), engineText);

const voicePill = el('label', 'select-pill');
voicePill.append(icon('sparkle', 14));
const voiceSelectTop = el('select');
voiceSelectTop.title = '默认朗读音色';
voicePill.append(voiceSelectTop);

const speedGroup = el('div', 'speed-group');
const speedTop = rangeInput({ min: 0.5, max: 2, step: 0.05, value: state.speed, className: 'range' });
speedTop.style.width = '72px';
const speedTopValue = el('span', 'value', `${state.speed.toFixed(2)}×`);
speedGroup.append(el('span', '', '语速'), speedTop, speedTopValue);

tools.append(engineChip, voicePill, speedGroup);
appbar.append(brand, tools);

// ---------- 左栏骨架 ----------

const workspace = el('div', 'workspace');
const leftPanel = el('section', 'panel');

const segmented = el('div', 'segmented');
const tabPodcast = el('button');
tabPodcast.type = 'button';
tabPodcast.append(icon('headphones', 15), document.createTextNode('播客制作'));
const tabVoices = el('button');
tabVoices.type = 'button';
tabVoices.append(icon('mic', 15), document.createTextNode('音色库'));
segmented.append(tabPodcast, tabVoices);

const podcastPane = el('div', 'pane');
const voicesPane = el('div', 'pane hidden');
leftPanel.append(segmented, podcastPane, voicesPane);

// ---------- 播客：素材 ----------

const engineNotice = el('div', 'notice hidden');
engineNotice.append(icon('info', 15), el('span', '', '没有检测到可用语音引擎。先到「音色库」下载一个本地模型，或确认系统语音服务已安装。'));

const sourceCard = el('div', 'card');
const dropzone = el('div', 'dropzone');
dropzone.title = '选择工作区文章';

const dzArt = el('div', 'dz-art');
const dzDoc = el('div', 'dz-doc');
dzDoc.append(icon('doc', 26));
const dzBadge = el('div', 'dz-badge');
dzBadge.append(icon('wave', 15));
dzArt.append(dzDoc, dzBadge);
const pasteToggle = btn('粘贴文本内容', 'btn btn-outline btn-sm', 'paste');
dropzone.append(
  dzArt,
  el('div', 'dz-title', '从工作区选择一篇文章'),
  el('div', 'dz-sub', '支持 Markdown / TXT / Word，也可以直接粘贴文本'),
  el('div', 'dz-or', '或'),
  pasteToggle,
);

const articleBlock = el('div', 'article-block');
const articleQuery = el('input');
articleQuery.type = 'text';
articleQuery.placeholder = '搜索工作区文章';
const articleRefresh = btn('查找', 'btn btn-sm', 'search');
const articleSearchValue = el('div', 'field-value');
articleSearchValue.append(articleQuery, articleRefresh);
const fieldArticleSearch = el('div', 'field');
fieldArticleSearch.append(el('span', 'field-label', '搜索文章'), articleSearchValue);

const articleSelect = el('select', 'select');
articleSelect.setAttribute('aria-label', '播客来源文章');
const fieldArticleSelect = el('div', 'field');
fieldArticleSelect.append(el('span', 'field-label', '选择文章'), articleSelect);
const articleStatus = el('div', 'status');
articleBlock.append(fieldArticleSearch, fieldArticleSelect, articleStatus);

const pasteArea = el('textarea', 'paste hidden');
pasteArea.rows = 6;
pasteArea.placeholder = '把文章正文粘贴到这里，生成脚本时只读取这段文字…';

const backToArticle = btn('改从工作区选文章', 'btn btn-ghost btn-sm', 'folder');
backToArticle.classList.add('hidden');
backToArticle.style.marginTop = '8px';

const titleInput = el('input');
titleInput.type = 'text';
titleInput.placeholder = '可选，缺省取文章标题或首行';
const fieldTitle = el('div', 'field');
fieldTitle.append(el('span', 'field-label', '节目主题'), titleInput);

sourceCard.append(dropzone, articleBlock, pasteArea, backToArticle, fieldTitle);

// ---------- 播客：语音设置 ----------

const voiceCard = el('div', 'card');
const voiceCardHead = el('div', 'card-head');
const voiceCardTitle = el('div', 'card-title');
voiceCardTitle.append(icon('sliders', 15), document.createTextNode('语音设置'));
voiceCardHead.append(voiceCardTitle);

function voiceSelectBox(): { root: HTMLElement; avatar: HTMLElement; select: HTMLSelectElement } {
  const root = el('div', 'voice-select');
  const avatar = el('span', 'avatar', '声');
  const select = el('select');
  root.append(avatar, select);
  return { root, avatar, select };
}

const hostBox = voiceSelectBox();
const guestBox = voiceSelectBox();
const fieldHost = el('div', 'field');
fieldHost.append(el('span', 'field-label', '主持人'), hostBox.root);
const fieldGuest = el('div', 'field');
fieldGuest.append(el('span', 'field-label', '嘉宾'), guestBox.root);

const speedLeft = rangeInput({ min: 0.5, max: 2, step: 0.05, value: state.speed, className: 'range' });
const speedLeftValue = el('span', 'value-pill', `${state.speed.toFixed(2)}×`);
const speedLeftWrap = el('div', 'field-value');
speedLeftWrap.append(speedLeft, speedLeftValue);
const fieldSpeed = el('div', 'field');
fieldSpeed.append(el('span', 'field-label', '语速'), speedLeftWrap);

const styleChips = el('div', 'chips');
const chipDuet = el('button', 'chip-choice');
chipDuet.type = 'button';
chipDuet.append(icon('users', 14), document.createTextNode('双人对谈'));
const chipSolo = el('button', 'chip-choice');
chipSolo.type = 'button';
chipSolo.append(icon('user', 14), document.createTextNode('单人独白'));
styleChips.append(chipDuet, chipSolo);
const fieldStyle = el('div', 'field');
fieldStyle.append(el('span', 'field-label', '节目形式'), styleChips);

const advanced = el('div', 'advanced collapsed');
const advancedToggle = el('button', 'advanced-toggle');
advancedToggle.type = 'button';
const advancedChev = icon('chevron', 14);
advancedChev.classList.add('chev');
advancedToggle.append(icon('sliders', 13), document.createTextNode('高级设置（可选）'), advancedChev);
const advancedBody = el('div', 'advanced-body');

const minutesRange = rangeInput({ min: 1, max: 20, step: 1, value: state.minutes, className: 'range' });
const minutesValue = el('span', 'value-pill', `${state.minutes} 分钟`);
const minutesWrap = el('div', 'field-value');
minutesWrap.append(minutesRange, minutesValue);
const fieldMinutes = el('div', 'field');
fieldMinutes.append(el('span', 'field-label', '目标时长'), minutesWrap);

const useAiCheck = el('input');
useAiCheck.type = 'checkbox';
const useAiSwitch = el('label', 'switch');
useAiSwitch.append(useAiCheck, el('span', 'track'), document.createTextNode('使用平台 AI 生成脚本'));
const fieldScriptSource = el('div', 'field');
fieldScriptSource.append(el('span', 'field-label', '脚本来源'), useAiSwitch);

advancedBody.append(fieldMinutes, fieldScriptSource);
advanced.append(advancedToggle, advancedBody);

voiceCard.append(voiceCardHead, fieldHost, fieldGuest, fieldSpeed, fieldStyle, advanced);

const podcastActions = el('div', 'actions');
const generateButton = btn('生成脚本', 'btn btn-primary', 'sparkle');
const resetButton = btn('重置', 'btn', 'reset');
podcastActions.append(generateButton, resetButton);

podcastPane.append(engineNotice, sourceCard, voiceCard, podcastActions);

// ---------- 音色库：左栏 ----------

const voicesCard = el('div', 'card');
const voicesHead = el('div', 'card-head');
const voicesTitle = el('div', 'card-title');
voicesTitle.append(icon('mic', 15), document.createTextNode('音色库'));
const voicesCount = el('span', 'count', '');
voicesHead.append(voicesTitle, voicesCount);

const voiceSearch = el('input', 'search');
voiceSearch.type = 'text';
voiceSearch.placeholder = '搜索音色名称、语言或标签…';

const filterChips = el('div', 'chips');
const filterButtons: Array<{ filter: VoiceFilter; node: HTMLButtonElement }> = [
  { filter: 'all', node: btn('全部', 'chip-choice') },
  { filter: 'female', node: btn('女声', 'chip-choice') },
  { filter: 'male', node: btn('男声', 'chip-choice') },
  { filter: 'fav', node: btn('收藏', 'chip-choice', 'star') },
];
for (const item of filterButtons) filterChips.append(item.node);
filterChips.style.marginBottom = '8px';

const voiceList = el('div', 'voice-list');
const voicesEmpty = el('div', 'empty hidden');
voicesEmpty.append(icon('mic', 22), el('div', 'empty-title', '没有匹配的音色'), el('div', '', '换个关键词，或到右侧下载本地模型。'));

const voicesHint = el('p', 'hint', '音色来自本机引擎与已下载模型，合成过程完全离线；点一行可查看参数并试听。');

voicesCard.append(voicesHead, voiceSearch, filterChips, voiceList, voicesEmpty, voicesHint);
voicesPane.append(voicesCard);

// ---------- 右栏：播客 ----------

const rightPodcast = el('div', 'pane');

const hero = el('div', 'hero hero-podcast');
const heroArt = el('div', 'hero-art');
const heroOrb = el('button', 'hero-orb');
heroOrb.type = 'button';
heroOrb.append(icon('sparkle', 20));
const heroRing = el('span', 'hero-ring');
heroArt.append(heroOrb, heroRing);
const heroWave = el('div', 'hero-wave');
for (const height of [16, 30, 46, 62, 50, 34, 20, 12]) {
  const bar = el('span');
  bar.style.height = `${height}px`;
  heroWave.append(bar);
}
const heroText = el('div', 'hero-text');
const heroTitle = el('h2', 'hero-title', '准备开始');
const heroSub = el('p', 'hero-sub', '在左侧选择素材，生成一份可编辑的播客脚本。');
const heroMeta = el('div', 'hero-meta');
heroText.append(heroTitle, heroSub, heroMeta);
hero.append(heroArt, heroText, heroWave);

function createPlayerBar(): {
  root: HTMLElement;
  play: HTMLButtonElement;
  time: HTMLElement;
  progress: HTMLInputElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  volume: HTMLInputElement;
} {
  const root = el('div', 'player-bar');
  const play = el('button', 'play');
  play.type = 'button';
  play.setAttribute('aria-label', '播放');
  play.append(icon('play', 14));
  const time = el('span', 'time', '0:00 / 0:00');
  const progress = rangeInput({ min: 0, max: 1000, step: 1, value: 0, className: 'range progress' });
  progress.setAttribute('aria-label', '播放进度');
  const prev = iconBtn('prev', '上一句');
  const next = iconBtn('next', '下一句');
  const volumeWrap = el('div', 'volume');
  const volume = rangeInput({ min: 0, max: 1, step: 0.01, value: 1, className: 'range' });
  volume.setAttribute('aria-label', '音量');
  volumeWrap.append(icon('volume', 14), volume);
  root.append(play, time, progress, el('span', 'divider'), prev, next, el('span', 'divider'), volumeWrap);
  return { root, play, time, progress, prev, next, volume };
}

const podBar = createPlayerBar();
podBar.root.classList.add('hidden');

const scriptCard = el('div', 'card script-card');
const scriptHead = el('div', 'card-head');
const scriptTitle = el('div', 'card-title');
scriptTitle.append(icon('doc', 15), document.createTextNode('脚本内容'));
const scriptCount = el('span', 'count', '');
const copyScriptButton = btn('复制', 'btn btn-sm', 'copy');
copyScriptButton.classList.add('hidden');
const synthButton = btn('合成音频', 'btn btn-sm btn-primary', 'wave');
synthButton.classList.add('hidden');
scriptHead.append(scriptTitle, scriptCount, el('span', 'spacer'), copyScriptButton, synthButton);

const scriptLines = el('div', 'script-lines');
const scriptEmpty = el('div', 'empty');
const emptyGenerate = btn('生成脚本', 'btn btn-sm btn-outline', 'sparkle');
emptyGenerate.addEventListener('click', () => void generatePodcastScript());
scriptEmpty.append(
  icon('doc', 24),
  el('div', 'empty-title', '还没有脚本'),
  el('div', '', '在左侧选好素材，生成后可以逐句修改。'),
  emptyGenerate,
);
const scriptActions = el('div', 'script-actions');
const saveScriptButton = btn('保存修改', 'btn btn-sm', 'check');
const addLineButton = btn('加一行', 'btn btn-sm', 'plus');
const regenButton = btn('重新生成', 'btn btn-sm', 'refresh');
scriptActions.append(saveScriptButton, addLineButton, regenButton);
scriptActions.classList.add('hidden');
scriptCard.append(scriptHead, scriptLines, scriptEmpty, scriptActions);

const exportBar = el('div', 'export-bar');
const exportHint = el('span', '', '合成音频后可导出 WAV / MP3，文件保存在本机。');
exportBar.append(icon('bulb', 15), exportHint, el('span', 'spacer'));
const exportWav = btn('下载 WAV', 'btn btn-sm btn-outline', 'download');
const exportMp3 = btn('下载 MP3', 'btn btn-sm btn-outline', 'download');
exportBar.append(exportWav, exportMp3);

rightPodcast.append(hero, podBar.root, scriptCard, exportBar);

// ---------- 右栏：音色库 ----------

const rightVoices = el('div', 'pane hidden');

const voiceHero = el('div', 'hero');
const voiceHeroArt = el('div', 'hero-art');
const voiceOrb = el('button', 'hero-orb');
voiceOrb.type = 'button';
voiceOrb.append(icon('play', 18));
const voiceRing = el('span', 'hero-ring');
voiceHeroArt.append(voiceOrb, voiceRing);
const voiceHeroText = el('div', 'hero-text');
const voiceHeroTitle = el('h2', 'hero-title', '音色');
const voiceHeroSub = el('p', 'hero-sub', '点右侧按钮试听当前音色。');
const voiceHeroMeta = el('div', 'hero-meta');
voiceHeroText.append(voiceHeroTitle, voiceHeroSub, voiceHeroMeta);
voiceHero.append(voiceHeroArt, voiceHeroText);

const previewBar = createPlayerBar();
previewBar.root.classList.add('hidden');

const detailCard = el('div', 'card');
const detailHead = el('div', 'card-head');
const detailTitle = el('div', 'card-title');
detailTitle.append(icon('sliders', 15), document.createTextNode('音色参数'));
const readerButton = btn('设为默认朗读', 'btn btn-sm', 'check');
detailHead.append(detailTitle, el('span', 'spacer'), readerButton);
const paramRows = el('div');
const detailHint = el('p', 'hint', '参数按音色单独保存，朗读与播客合成都会使用。');
detailCard.append(detailHead, paramRows, detailHint);

const modelsCard = el('div', 'card models-card');
const modelsHead = el('div', 'card-head');
const modelsTitle = el('div', 'card-title');
modelsTitle.append(icon('chip', 15), document.createTextNode('本地神经网络模型'));
const modelsCount = el('span', 'count', '');
modelsHead.append(modelsTitle, modelsCount);
const modelsList = el('div', 'model-list');
const mirrorInput = el('input');
mirrorInput.type = 'text';
mirrorInput.placeholder = '可选：GitHub 下载镜像前缀，如 https://gh-proxy.com/';
const mirrorSave = btn('保存', 'btn btn-sm', 'check');
const mirrorValue = el('div', 'field-value');
mirrorValue.append(mirrorInput, mirrorSave);
const fieldMirror = el('div', 'field');
fieldMirror.append(el('span', 'field-label', '下载镜像'), mirrorValue);
fieldMirror.style.marginTop = '8px';
modelsCard.append(modelsHead, modelsList, fieldMirror);

rightVoices.append(voiceHero, previewBar.root, detailCard, modelsCard);

const rightPanel = el('section', 'panel');
rightPanel.append(rightPodcast, rightVoices);

workspace.append(leftPanel, rightPanel);
app.append(appbar, workspace);

const root = document.getElementById('app')!;
root.replaceChildren(app);

// ---------- 播放器 ----------

let podScrubbing = false;
let previewScrubbing = false;
let previewAudioId = '';
const previewSegments: Segment[] = [];

function totalMs(segments: Segment[]): number {
  return segments.reduce((sum, segment) => sum + (segment.durationMs || 0), 0);
}

function podcastSegments(): Segment[] {
  return podcastManifest?.segments ?? [];
}

function podcastPlayerTick(playing: boolean, index: number, elapsedMs: number): void {
  const segments = podcastSegments();
  const total = totalMs(segments);
  const before = totalMs(segments.slice(0, index));
  const current = Math.min(elapsedMs, segments[index]?.durationMs ?? 0);
  const position = before + current;
  podBar.time.textContent = `${fmtDuration(position)} / ${fmtDuration(total)}`;
  if (!podScrubbing) {
    podBar.progress.value = String(total > 0 ? Math.round((position / total) * 1000) : 0);
    setRangeFill(podBar.progress);
  }
  podBar.play.replaceChildren(icon(playing ? 'pause' : 'play', 14));
  podBar.play.setAttribute('aria-label', playing ? '暂停' : '播放');
  if (hasAudio()) {
    heroOrb.replaceChildren(icon(playing ? 'pause' : 'play', 20));
    heroOrb.setAttribute('aria-label', playing ? '暂停' : '播放');
  }
}

const podcastPlayer = new SegmentPlayer(
  () => state.podcastAudioId,
  podcastSegments,
  () => podcastManifest?.linePauseMs ?? 420,
  index => highlightScriptLine(index),
  (playing, index, elapsedMs) => podcastPlayerTick(playing, index, elapsedMs),
);

function previewPlayerTick(playing: boolean, index: number, elapsedMs: number): void {
  const segments = previewSegments;
  const total = totalMs(segments);
  const before = totalMs(segments.slice(0, index));
  const current = Math.min(elapsedMs, segments[index]?.durationMs ?? 0);
  const position = before + current;
  previewBar.time.textContent = `${fmtDuration(position)} / ${fmtDuration(total)}`;
  if (!previewScrubbing) {
    previewBar.progress.value = String(total > 0 ? Math.round((position / total) * 1000) : 0);
    setRangeFill(previewBar.progress);
  }
  previewBar.play.replaceChildren(icon(playing ? 'pause' : 'play', 14));
  voiceOrb.replaceChildren(icon(playing ? 'pause' : 'play', 18));
}

const previewPlayer = new SegmentPlayer(
  () => previewAudioId,
  () => previewSegments,
  () => 0,
  () => {},
  (playing, index, elapsedMs) => previewPlayerTick(playing, index, elapsedMs),
);

// ---------- 通用交互 ----------

function setTab(tab: Tab): void {
  state.tab = tab;
  tabPodcast.classList.toggle('active', tab === 'podcast');
  tabVoices.classList.toggle('active', tab === 'voices');
  podcastPane.classList.toggle('hidden', tab !== 'podcast');
  voicesPane.classList.toggle('hidden', tab !== 'voices');
  rightPodcast.classList.toggle('hidden', tab !== 'podcast');
  rightVoices.classList.toggle('hidden', tab !== 'voices');
  brandSub.textContent = tab === 'podcast' ? '把文章变成自然流畅的播客' : '管理音色与本地模型';
  markDirty();
}

function applySpeed(value: number): void {
  state.speed = Math.max(0.5, Math.min(2, value));
  const text = `${state.speed.toFixed(2)}×`;
  speedTop.value = String(state.speed);
  speedLeft.value = String(state.speed);
  speedTopValue.textContent = text;
  speedLeftValue.textContent = text;
  setRangeFill(speedTop);
  setRangeFill(speedLeft);
  podcastPlayer.setRate(state.speed);
  previewPlayer.setRate(state.speed);
  markDirty();
}

function setSourceMode(mode: SourceMode): void {
  state.sourceMode = mode;
  articleBlock.classList.toggle('hidden', mode === 'text');
  dropzone.classList.toggle('hidden', mode === 'text');
  pasteArea.classList.toggle('hidden', mode === 'article');
  backToArticle.classList.toggle('hidden', mode === 'article');
  markDirty();
}

function setStyle(style: 'duet' | 'solo'): void {
  state.style = style;
  chipDuet.classList.toggle('active', style === 'duet');
  chipSolo.classList.toggle('active', style === 'solo');
  fieldGuest.classList.toggle('hidden', style === 'solo');
  markDirty();
  renderHero();
}

function hasAudio(): boolean {
  return Boolean(state.podcastAudioId) && podcastSegments().length > 0;
}

function renderHero(): void {
  const audio = hasAudio();
  heroMeta.replaceChildren();
  if (audio) {
    heroTitle.textContent = '你的播客已就绪！';
    heroSub.textContent = '点击播放，或导出为音频文件。';
    heroOrb.disabled = false;
    if (podcastPlayer.current().playing) heroOrb.replaceChildren(icon('pause', 20));
    else heroOrb.replaceChildren(icon('play', 20));
    heroOrb.setAttribute('aria-label', '播放播客');
    heroMeta.append(pill(fmtDuration(totalMs(podcastSegments())), 'accent'), pill(state.style === 'solo' ? '单人独白' : '双人对谈'));
    if (script) heroMeta.append(pill(script.source === 'ai' ? 'AI 脚本' : '本地脚本'));
  } else if (script) {
    heroTitle.textContent = '脚本已就绪';
    heroSub.textContent = '检查台词后合成音频，试听与导出都在这里。';
    heroOrb.disabled = false;
    heroOrb.replaceChildren(icon('wave', 20));
    heroOrb.setAttribute('aria-label', '合成音频');
    heroMeta.append(pill(`${script.lines.length} 句`, 'accent'), pill(state.style === 'solo' ? '单人独白' : '双人对谈'));
    heroMeta.append(pill(script.source === 'ai' ? 'AI 脚本' : '本地脚本'));
  } else {
    heroTitle.textContent = '准备开始';
    heroSub.textContent = '在左侧选好素材，生成可编辑的播客脚本。';
    heroOrb.disabled = true;
    heroOrb.replaceChildren(icon('sparkle', 20));
    heroOrb.setAttribute('aria-label', '尚未生成脚本');
  }
}

function pill(text: string, tone?: 'accent' | 'warm'): HTMLElement {
  const node = el('span', `pill${tone ? ` ${tone}` : ''}`);
  node.append(document.createTextNode(text));
  return node;
}

// ---------- 右栏状态 ----------

function renderPodcastState(): void {
  const audio = hasAudio();
  podBar.root.classList.toggle('hidden', !audio);
  exportWav.disabled = !audio;
  exportMp3.disabled = !audio;
  exportHint.textContent = audio ? '支持导出为 WAV / MP3，文件保存在本机。' : '合成音频后可导出 WAV / MP3。';
  scriptLines.classList.toggle('hidden', !script);
  scriptEmpty.classList.toggle('hidden', Boolean(script));
  scriptActions.classList.toggle('hidden', !script);
  copyScriptButton.classList.toggle('hidden', !script);
  synthButton.classList.toggle('hidden', !script);
  scriptCount.textContent = script ? `${script.lines.length} 句` : '';
  scriptCount.classList.toggle('hidden', !script);
  renderHero();
}

// ---------- 播客逻辑 ----------

function renderTopVoiceOptions(): void {
  if (!voicesData) return;
  voiceSelectTop.replaceChildren();
  for (const voice of voicesData.voices) {
    voiceSelectTop.append(optionEl(voice.id, `${voice.name}（${voice.lang}）`));
  }
  if (state.voiceId) voiceSelectTop.value = state.voiceId;
}

function renderVoicePickers(): void {
  if (!voicesData) return;
  for (const [box, role] of [[hostBox, 'host'], [guestBox, 'guest']] as const) {
    const previous = box.select.value;
    box.select.replaceChildren();
    for (const voice of voicesData.voices) {
      box.select.append(optionEl(voice.id, `${voice.name}（${voice.lang}）`));
    }
    const preferred = [previous, voicesData.settings.roles[role], state.voiceId]
      .find(id => id && voicesData?.voices.some(voice => voice.id === id));
    if (preferred) box.select.value = preferred;
    renderVoiceBoxAvatar(box, box.select.value);
  }
}

function renderVoiceBoxAvatar(box: { root: HTMLElement; avatar: HTMLElement; select: HTMLSelectElement }, voiceId: string): void {
  const voice = voicesData?.voices.find(item => item.id === voiceId);
  box.avatar.textContent = voice ? voice.name.trim().slice(0, 1).toUpperCase() : '声';
  box.avatar.classList.toggle('male', voice?.gender === 'male');
}

function renderEngineChip(): void {
  const engines = voicesData?.engines ?? [];
  const available = engines.filter(engine => engine.available);
  engineChip.classList.toggle('ok', available.length > 0);
  engineChip.classList.toggle('bad', available.length === 0);
  if (available.length > 0) {
    engineText.textContent = `本机引擎就绪 · ${voicesData?.voices.length ?? 0} 个音色`;
    engineChip.title = '';
  } else {
    engineText.textContent = engines.length === 0 ? '未检测到引擎' : '引擎不可用';
    engineChip.title = engines.map(engine => `${engine.displayName}: ${engine.reason ?? '未知原因'}`).join('\n');
  }
  engineNotice.classList.toggle('hidden', available.length > 0);
}

async function refreshArticles(): Promise<void> {
  articleRefresh.disabled = true;
  articleStatus.textContent = '正在读取文章…';
  try {
    const result = await invoke<{ items: { path: string; title: string }[]; truncated: boolean }>('voice.articles.list', { query: articleQuery.value });
    articleSelect.replaceChildren();
    articleSelect.append(optionEl('', '选择一篇文章'));
    if (session.context.documentId && session.context.editorId) {
      articleSelect.append(optionEl('__current__', '当前打开的文章（包含未保存修改）'));
    }
    for (const article of result.items) {
      articleSelect.append(optionEl(article.path, `${article.title} · ${article.path}`));
    }
    if ([...articleSelect.options].some(option => option.value === state.articlePath)) articleSelect.value = state.articlePath;
    if (!articleSelect.value && session.context.documentId && session.context.editorId) articleSelect.value = '__current__';
    articleStatus.textContent = result.truncated ? '文章较多，请输入关键词筛选。工作区文章使用已保存的内容。' : `${result.items.length} 篇文章 · 工作区文章使用已保存的内容`;
  } catch (error) {
    articleStatus.textContent = errorMessage(error);
  } finally {
    articleRefresh.disabled = false;
  }
}

function autoGrow(node: HTMLTextAreaElement): void {
  node.style.height = 'auto';
  node.style.height = `${Math.min(180, Math.max(26, node.scrollHeight))}px`;
}

function scriptLineEditor(line: { speaker: 'host' | 'guest'; text: string }): HTMLElement {
  const row = el('div', 'script-line');
  const speakerSelect = el('select', 'speaker');
  speakerSelect.append(optionEl('host', '主持人'), optionEl('guest', '嘉宾'));
  speakerSelect.value = line.speaker;
  speakerSelect.classList.toggle('guest', line.speaker === 'guest');
  speakerSelect.addEventListener('change', () => speakerSelect.classList.toggle('guest', speakerSelect.value === 'guest'));

  const textarea = el('textarea');
  textarea.rows = 1;
  textarea.value = line.text;
  textarea.addEventListener('input', () => autoGrow(textarea));

  const remove = iconBtn('trash', '删除这一句', 14);
  remove.classList.add('remove');
  remove.addEventListener('click', () => row.remove());

  row.append(speakerSelect, textarea, remove);
  requestAnimationFrame(() => autoGrow(textarea));
  return row;
}

function renderScript(): void {
  scriptLines.replaceChildren();
  if (script) {
    for (const line of script.lines) scriptLines.append(scriptLineEditor(line));
  }
  renderPodcastState();
}

function highlightScriptLine(index: number): void {
  const nodes = scriptLines.querySelectorAll('.script-line');
  nodes.forEach((node, i) => {
    node.classList.toggle('playing', i === index);
    if (i === index) node.scrollIntoView({ block: 'nearest' });
  });
}

async function generatePodcastScript(): Promise<void> {
  const source: 'document' | 'text' | 'article' = state.sourceMode === 'text'
    ? 'text'
    : articleSelect.value === '__current__' ? 'document' : 'article';
  if (source === 'article' && !articleSelect.value) {
    showToast('请先选择一篇文章', true);
    return;
  }
  if (source === 'text' && !pasteArea.value.trim()) {
    showToast('请先粘贴文章内容', true);
    return;
  }
  generateButton.disabled = true;
  const label = generateButton.lastChild;
  if (label) label.textContent = '生成中…';
  try {
    const args: Json = {
      source,
      style: state.style,
      minutes: state.minutes,
      useAi: state.useAi,
      ...(source === 'text' ? { text: pasteArea.value.trim() } : {}),
      ...(source === 'article' ? { path: articleSelect.value } : {}),
      ...(titleInput.value.trim() ? { title: titleInput.value.trim() } : {}),
    };
    script = await invoke<PodcastScript>('voice.podcast.script', args);
    state.scriptId = script.scriptId;
    markDirty();
    renderScript();
    showToast(script.source === 'ai' ? '脚本已生成，可逐句修改后合成' : '已按本地规则生成脚本');
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    generateButton.disabled = false;
    if (label) label.textContent = '生成脚本';
  }
}

async function renderPodcastAudio(): Promise<void> {
  if (!script) {
    showToast('请先生成脚本', true);
    return;
  }
  const hostVoiceId = hostBox.select.value;
  if (!hostVoiceId) {
    showToast('请选择主持人音色', true);
    return;
  }
  synthButton.disabled = true;
  const original = synthButton.lastChild?.textContent ?? '合成音频';
  try {
    const result = await invoke<{ audioId: string; durationMs: number; segments: number }>(
      'voice.podcast.render',
      {
        scriptId: script.scriptId,
        hostVoiceId,
        guestVoiceId: guestBox.select.value || hostVoiceId,
        speed: state.speed,
      },
      value => { if (synthButton.lastChild) synthButton.lastChild.textContent = `合成 ${Math.round(value * 100)}%`; },
    );
    state.podcastAudioId = result.audioId;
    markDirty();
    await refreshManifest(result.audioId);
    renderPodcastState();
    // 重新合成沿用同一 audioId，先清掉上一轮已解码的缓存，避免命中旧音频。
    podcastPlayer.release();
    await podcastPlayer.play(0);
    showToast(`合成完成：${result.segments} 句，约 ${fmtDuration(result.durationMs)}`);
  } catch (error) {
    showToast(errorMessage(error), true);
  } finally {
    synthButton.disabled = false;
    if (synthButton.lastChild) synthButton.lastChild.textContent = original;
  }
}

async function exportPodcast(format: 'wav' | 'mp3'): Promise<void> {
  if (!state.podcastAudioId) {
    showToast('请先合成播客音频', true);
    return;
  }
  try {
    const result = await invoke<{ saved: boolean; path?: string; reason?: string }>('voice.export', { audioId: state.podcastAudioId, format });
    showToast(result.saved ? `已保存到 ${result.path}` : result.reason ?? '已生成缓存文件');
  } catch (error) {
    showToast(errorMessage(error), true);
  }
}

function scriptPlainText(): string {
  if (!script) return '';
  return script.lines.map(line => `${line.speaker === 'host' ? '主持人' : '嘉宾'}：${line.text}`).join('\n');
}

function copyScriptText(): void {
  const text = scriptPlainText();
  if (!text) return;
  const done = () => {
    copyScriptButton.replaceChildren(icon('check', 14), document.createTextNode('已复制'));
    setTimeout(() => copyScriptButton.replaceChildren(icon('copy', 14), document.createTextNode('复制')), 1600);
  };
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    return;
  }
  fallbackCopy(text, done);
}

function fallbackCopy(text: string, done: () => void): void {
  const helper = el('textarea');
  helper.value = text;
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.append(helper);
  helper.select();
  try {
    document.execCommand('copy');
    done();
  } catch {
    showToast('复制失败，请手动选择文本', true);
  } finally {
    helper.remove();
  }
}

// ---------- 音色库逻辑 ----------

let voiceFilter: VoiceFilter = 'all';

function selectVoice(voiceId: string): void {
  state.voiceId = voiceId;
  markDirty();
  renderVoiceList();
  renderVoiceDetail();
  if (voicesData) voiceSelectTop.value = voiceId;
}

function toggleFavorite(voice: VoiceRow): void {
  void (async () => {
    const next = !(voicesData?.settings.favorites[voice.id] ?? false);
    try {
      await invoke('voice.settings.update', { favorites: { [voice.id]: next } });
      await refreshVoices();
      renderVoiceList();
      renderVoiceDetail();
      showToast(next ? `已收藏「${voice.name}」` : '已取消收藏');
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  })();
}

async function previewVoice(voice: VoiceRow): Promise<void> {
  voiceHeroSub.textContent = '正在合成试听…';
  try {
    const result = await invoke<{ audioId: string; durationMs: number }>('voice.voices.test', { voiceId: voice.id });
    previewAudioId = result.audioId;
    previewSegments.length = 0;
    const manifest = await invoke<AudioManifest>('voice.audio.info', { audioId: result.audioId });
    previewSegments.push(...manifest.segments);
    previewBar.root.classList.remove('hidden');
    previewBar.progress.value = '0';
    await previewPlayer.play(0);
    voiceHeroSub.textContent = `试听「${voice.name}」 · 约 ${fmtDuration(result.durationMs)}`;
  } catch (error) {
    voiceHeroSub.textContent = '试听失败';
    showToast(errorMessage(error), true);
  }
}

function visibleVoices(): VoiceRow[] {
  if (!voicesData) return [];
  const query = voiceSearch.value.trim().toLowerCase();
  return voicesData.voices.filter(voice => {
    if (voiceFilter === 'female' && voice.gender !== 'female') return false;
    if (voiceFilter === 'male' && voice.gender !== 'male') return false;
    if (voiceFilter === 'fav' && !voicesData?.settings.favorites[voice.id]) return false;
    if (!query) return true;
    return `${voice.name} ${voice.lang} ${voice.tags.join(' ')}`.toLowerCase().includes(query);
  });
}

function renderVoiceList(): void {
  if (!voicesData) return;
  const voices = visibleVoices();
  voiceList.replaceChildren();
  voicesEmpty.classList.toggle('hidden', voices.length > 0);
  voicesCount.textContent = String(voices.length);

  const groups = new Map<string, VoiceRow[]>();
  for (const voice of voices) {
    const key = voice.modelId ? `${voice.engineId}:${voice.modelId}` : voice.engineId;
    const list = groups.get(key) ?? [];
    list.push(voice);
    groups.set(key, list);
  }

  for (const [, groupVoices] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const first = groupVoices[0];
    const engine = engineInfo(first.engineId);
    const head = el('div', 'group-head');
    const label = el('span', '', first.modelId ? `${first.tags[0] ?? first.modelId}` : `${engine?.displayName ?? first.engineId}`);
    const count = el('span', 'count', String(groupVoices.length));
    head.append(label, count);
    if (engine && !engine.available) {
      const warn = el('span', 'pill warm', engine.reason ?? '不可用');
      head.append(warn);
    }
    voiceList.append(head);

    const sorted = [...groupVoices].sort((a, b) =>
      Number(voicesData?.settings.favorites[b.id] ?? false) - Number(voicesData?.settings.favorites[a.id] ?? false)
      || a.name.localeCompare(b.name, 'zh'));
    for (const voice of sorted) {
      const favorite = voicesData?.settings.favorites[voice.id] ?? false;
      const item = el('div', `voice-item${voice.id === state.voiceId ? ' selected' : ''}`);
      const avatar = el('span', `avatar${voice.gender === 'male' ? ' male' : ''}`, voice.name.trim().slice(0, 1).toUpperCase());
      const info = el('div', 'info');
      const gender = voice.gender === 'female' ? '女声' : voice.gender === 'male' ? '男声' : '不限';
      const tags = voice.tags.length ? ` · ${voice.tags.slice(0, 2).join(' / ')}` : '';
      info.append(el('div', 'name', voice.name), el('div', 'meta', `${voice.lang} · ${gender}${tags}`));

      const actions = el('div', 'row-actions');
      const star = iconBtn('star', favorite ? '取消收藏' : '收藏', 15);
      star.classList.toggle('active', favorite);
      star.addEventListener('click', event => {
        event.stopPropagation();
        toggleFavorite(voice);
      });
      const test = iconBtn('play', '试听', 15);
      test.addEventListener('click', event => {
        event.stopPropagation();
        selectVoice(voice.id);
        void previewVoice(voice);
      });
      actions.append(star, test);

      item.append(avatar, info, actions);
      item.addEventListener('click', () => selectVoice(voice.id));
      voiceList.append(item);
    }
  }
}

function paramRow(
  label: string,
  opts: { min: number; max: number; step: number; value: number; unit: string; decimals: number; disabled?: boolean; onCommit: (value: number) => void },
): HTMLElement {
  const row = el('div', 'field');
  row.append(el('span', 'field-label', label));
  const wrap = el('div', 'field-value');
  const input = rangeInput({
    min: opts.min,
    max: opts.max,
    step: opts.step,
    value: opts.value,
    disabled: opts.disabled,
    className: 'range',
  });
  const format = (value: number) => `${opts.decimals > 0 ? value.toFixed(opts.decimals) : Math.round(value)}${opts.unit}`;
  const valueNode = el('span', 'value-pill', format(opts.value));
  input.addEventListener('input', () => { valueNode.textContent = format(Number(input.value)); });
  input.addEventListener('change', () => opts.onCommit(Number(input.value)));
  wrap.append(input, valueNode);
  row.append(wrap);
  setRangeFill(input);
  return row;
}

function renderVoiceDetail(): void {
  const voice = voicesData?.voices.find(item => item.id === state.voiceId);
  paramRows.replaceChildren();
  voiceHeroMeta.replaceChildren();

  if (!voice) {
    voiceHeroTitle.textContent = '还没有可用音色';
    voiceHeroSub.textContent = '到下方下载一个本地模型，或检查系统语音引擎。';
    voiceOrb.disabled = true;
    readerButton.disabled = true;
    return;
  }

  const engine = engineInfo(voice.engineId);
  const favorite = voicesData?.settings.favorites[voice.id] ?? false;
  const gender = voice.gender === 'female' ? '女声' : voice.gender === 'male' ? '男声' : '不限';
  voiceHeroTitle.textContent = voice.name;
  voiceHeroSub.textContent = `${engine?.displayName ?? voice.engineId} · ${voice.lang} · ${gender}`;
  voiceHeroMeta.append(pill(voice.lang, 'accent'));
  if (voice.modelId) voiceHeroMeta.append(pill('本地模型'));
  else voiceHeroMeta.append(pill('系统引擎'));
  for (const tag of voice.tags.slice(0, 2)) voiceHeroMeta.append(pill(tag));
  if (favorite) voiceHeroMeta.append(pill('已收藏', 'warm'));
  voiceOrb.disabled = false;

  const params = voicesData?.settings.params[voice.id] ?? {};
  const defaults = voicesData?.settings.defaults ?? { speed: 1, pitch: 0, volume: 100 };
  const save = (key: 'speed' | 'pitch' | 'volume') => (value: number) => {
    void (async () => {
      try {
        await invoke('voice.settings.update', { params: { [voice.id]: { [key]: value } } });
        showToast('参数已保存');
      } catch (error) {
        showToast(errorMessage(error), true);
      }
    })();
  };
  paramRows.append(
    paramRow('语速', { min: 0.5, max: 2, step: 0.05, value: params.speed ?? defaults.speed, unit: '×', decimals: 2, onCommit: save('speed') }),
    paramRow('音高', { min: -50, max: 50, step: 1, value: params.pitch ?? defaults.pitch, unit: '%', decimals: 0, disabled: engine ? !engine.supportsPitch : true, onCommit: save('pitch') }),
    paramRow('音量', { min: 0, max: 200, step: 5, value: params.volume ?? defaults.volume, unit: '%', decimals: 0, onCommit: save('volume') }),
  );

  const isReader = voicesData?.settings.roles.reader === voice.id;
  readerButton.disabled = isReader;
  readerButton.replaceChildren(icon(isReader ? 'check' : 'mic', 14), document.createTextNode(isReader ? '默认朗读音色' : '设为默认朗读'));
}

function renderModels(): void {
  if (!modelsData) return;
  modelsList.replaceChildren();
  mirrorInput.value = modelsData.mirror ?? '';
  modelsCount.textContent = String(modelsData.models.length);

  for (const model of modelsData.models) {
    const item = el('div', `model-item${model.installed ? ' installed' : ''}`);
    const info = el('div', 'info');
    const title = el('div', 'title');
    title.append(document.createTextNode(model.displayName));
    if (model.recommended) title.append(pill('推荐 · 最像真人', 'accent'));
    if (model.installed) title.append(pill('已安装'));
    const facts = el('div', 'facts', [
      fmtBytes(model.sizeBytes),
      model.langs.join('/').toUpperCase(),
      `${model.numSpeakers ?? model.speakers} 音色`,
      model.sampleRate ? `${model.sampleRate} Hz` : '',
    ].filter(Boolean).join(' · '));
    info.append(title, facts, el('div', 'note', model.note));

    const progress = el('div', 'progress hidden');
    const fill = el('div');
    progress.append(fill);
    const status = el('div', 'status');
    info.append(progress, status);

    const actionWrap = el('div');
    if (!model.installed) {
      const download = btn('下载', 'btn btn-sm btn-primary', 'download');
      download.addEventListener('click', () => {
        void (async () => {
          download.disabled = true;
          progress.classList.remove('hidden');
          status.textContent = '开始下载…';
          const task = startTask('voice.models.download', { modelId: model.id }, value => {
            fill.style.width = `${Math.round(value * 100)}%`;
            status.textContent = `下载中 ${Math.round(value * 100)}% · 可离开本页`;
          });
          try {
            await task.promise;
            showToast(`「${model.displayName}」安装完成，可在左侧音色列表中选用`);
          } catch (error) {
            showToast(errorMessage(error), true);
          } finally {
            await loadModels();
          }
        })();
      });
      actionWrap.append(download);
    } else {
      const remove = iconBtn('trash', '删除模型', 15);
      remove.addEventListener('click', () => {
        if (!window.confirm(`删除模型「${model.displayName}」？将释放约 ${(model.sizeBytes / 1048576).toFixed(0)} MB 空间。`)) return;
        void (async () => {
          try {
            await invoke('voice.models.remove', { modelId: model.id });
            showToast('模型已删除');
          } catch (error) {
            showToast(errorMessage(error), true);
          } finally {
            await loadModels();
          }
        })();
      });
      actionWrap.append(remove);
    }

    item.append(info, actionWrap);
    modelsList.append(item);
  }
}

async function loadModels(): Promise<void> {
  modelsData = await invoke<{ models: CatalogModel[]; engines: EngineRow[]; mirror: string }>('voice.models.list');
  renderModels();
  renderVoiceList();
  renderVoiceDetail();
  renderTopVoiceOptions();
  renderVoicePickers();
  renderEngineChip();
}

// ---------- 事件 ----------

tabPodcast.addEventListener('click', () => setTab('podcast'));
tabVoices.addEventListener('click', () => setTab('voices'));

speedTop.addEventListener('input', () => applySpeed(Number(speedTop.value)));
speedLeft.addEventListener('input', () => applySpeed(Number(speedLeft.value)));

voiceSelectTop.addEventListener('change', () => selectVoice(voiceSelectTop.value));

hostBox.select.addEventListener('change', () => {
  renderVoiceBoxAvatar(hostBox, hostBox.select.value);
  void invoke('voice.settings.update', { roles: { host: hostBox.select.value } }).catch(error => showToast(errorMessage(error), true));
});
guestBox.select.addEventListener('change', () => {
  renderVoiceBoxAvatar(guestBox, guestBox.select.value);
  void invoke('voice.settings.update', { roles: { guest: guestBox.select.value } }).catch(error => showToast(errorMessage(error), true));
});

chipDuet.addEventListener('click', () => setStyle('duet'));
chipSolo.addEventListener('click', () => setStyle('solo'));

advancedToggle.addEventListener('click', () => advanced.classList.toggle('collapsed'));

minutesRange.addEventListener('input', () => {
  state.minutes = Number(minutesRange.value);
  minutesValue.textContent = `${state.minutes} 分钟`;
  markDirty();
});

useAiCheck.addEventListener('change', () => {
  state.useAi = useAiCheck.checked;
  markDirty();
});

pasteToggle.addEventListener('click', () => setSourceMode('text'));
backToArticle.addEventListener('click', () => setSourceMode('article'));
dropzone.addEventListener('click', event => {
  if (event.target instanceof HTMLElement && event.target.closest('button')) return;
  setSourceMode('article');
  articleSelect.focus();
});

articleRefresh.addEventListener('click', () => void refreshArticles());
articleQuery.addEventListener('keydown', event => {
  if (event.key === 'Enter') void refreshArticles();
});
articleSelect.addEventListener('change', () => {
  state.articlePath = articleSelect.value;
  markDirty();
});

generateButton.addEventListener('click', () => void generatePodcastScript());
resetButton.addEventListener('click', () => {
  state.articlePath = '';
  articleSelect.value = '';
  pasteArea.value = '';
  titleInput.value = '';
  state.minutes = 5;
  minutesRange.value = '5';
  minutesValue.textContent = '5 分钟';
  state.useAi = true;
  useAiCheck.checked = true;
  setStyle('duet');
  setSourceMode('article');
  showToast('已重置素材与设置');
});

saveScriptButton.addEventListener('click', () => {
  void (async () => {
    if (!script) return;
    const lines = [...scriptLines.querySelectorAll('.script-line')].map(node => ({
      speaker: (node.querySelector('select') as HTMLSelectElement).value as 'host' | 'guest',
      text: (node.querySelector('textarea') as HTMLTextAreaElement).value.trim(),
    })).filter(line => line.text);
    if (lines.length === 0) {
      showToast('脚本至少需要一句台词', true);
      return;
    }
    try {
      await invoke('voice.podcast.script.update', { scriptId: script.scriptId, lines });
      const refreshed = await invoke<PodcastScript>('voice.podcast.script.read', { scriptId: script.scriptId });
      script = refreshed;
      renderScript();
      showToast('脚本修改已保存');
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  })();
});

addLineButton.addEventListener('click', () => {
  const row = scriptLineEditor({ speaker: 'host', text: '' });
  scriptLines.append(row);
  (row.querySelector('textarea') as HTMLTextAreaElement | null)?.focus();
});

regenButton.addEventListener('click', () => void generatePodcastScript());
synthButton.addEventListener('click', () => void renderPodcastAudio());
copyScriptButton.addEventListener('click', copyScriptText);
exportWav.addEventListener('click', () => void exportPodcast('wav'));
exportMp3.addEventListener('click', () => void exportPodcast('mp3'));

heroOrb.addEventListener('click', () => {
  if (hasAudio()) void podcastPlayer.toggle();
  else if (script) void renderPodcastAudio();
});

podBar.play.addEventListener('click', () => void podcastPlayer.toggle());
podBar.prev.addEventListener('click', () => {
  void podcastPlayer.seek(Math.max(0, podcastPlayer.current().index - 1));
});
podBar.next.addEventListener('click', () => {
  void podcastPlayer.seek(Math.min(podcastSegments().length - 1, podcastPlayer.current().index + 1));
});
podBar.progress.addEventListener('input', () => {
  podScrubbing = true;
  const total = totalMs(podcastSegments());
  podBar.time.textContent = `${fmtDuration((Number(podBar.progress.value) / 1000) * total)} / ${fmtDuration(total)}`;
});
podBar.progress.addEventListener('change', () => {
  podScrubbing = false;
  void podcastPlayer.seekToMs((Number(podBar.progress.value) / 1000) * totalMs(podcastSegments()));
});
podBar.volume.addEventListener('input', () => podcastPlayer.setVolume(Number(podBar.volume.value)));

voiceOrb.addEventListener('click', () => {
  const voice = voicesData?.voices.find(item => item.id === state.voiceId);
  if (voice) void previewVoice(voice);
});
previewBar.play.addEventListener('click', () => void previewPlayer.toggle());
previewBar.progress.addEventListener('input', () => {
  previewScrubbing = true;
  const total = totalMs(previewSegments);
  previewBar.time.textContent = `${fmtDuration((Number(previewBar.progress.value) / 1000) * total)} / ${fmtDuration(total)}`;
});
previewBar.progress.addEventListener('change', () => {
  previewScrubbing = false;
  void previewPlayer.seekToMs((Number(previewBar.progress.value) / 1000) * totalMs(previewSegments));
});
previewBar.volume.addEventListener('input', () => previewPlayer.setVolume(Number(previewBar.volume.value)));
previewBar.prev.addEventListener('click', () => {
  void previewPlayer.seek(Math.max(0, previewPlayer.current().index - 1));
});
previewBar.next.addEventListener('click', () => {
  void previewPlayer.seek(Math.min(previewSegments.length - 1, previewPlayer.current().index + 1));
});

readerButton.addEventListener('click', () => {
  const voice = voicesData?.voices.find(item => item.id === state.voiceId);
  if (!voice) return;
  void (async () => {
    try {
      await invoke('voice.settings.update', { roles: { reader: voice.id } });
      state.voiceId = voice.id;
      renderTopVoiceOptions();
      renderVoiceList();
      renderVoiceDetail();
      showToast(`已把「${voice.name}」设为默认朗读音色`);
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  })();
});

voiceSearch.addEventListener('input', () => renderVoiceList());
for (const item of filterButtons) {
  item.node.addEventListener('click', () => {
    voiceFilter = item.filter;
    for (const other of filterButtons) other.node.classList.toggle('active', other.filter === voiceFilter);
    renderVoiceList();
  });
}

mirrorSave.addEventListener('click', () => {
  void (async () => {
    try {
      await invoke('voice.settings.update', { mirror: mirrorInput.value.trim() });
      showToast('镜像已保存');
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  })();
});

// ---------- 初始化 ----------

async function bootstrap(): Promise<void> {
  // 先同步表单初始状态，避免数据加载期间控件是空的
  setStyle(state.style);
  setSourceMode(state.sourceMode);
  useAiCheck.checked = state.useAi;
  minutesRange.value = String(state.minutes);
  minutesValue.textContent = `${state.minutes} 分钟`;
  speedTop.value = String(state.speed);
  speedLeft.value = String(state.speed);
  const initialSpeed = `${state.speed.toFixed(2)}×`;
  speedTopValue.textContent = initialSpeed;
  speedLeftValue.textContent = initialSpeed;
  filterButtons[0].node.classList.add('active');
  renderPodcastState();
  refreshRangeFills();

  try {
    await refreshVoices();
    renderTopVoiceOptions();
    renderVoicePickers();
    renderEngineChip();
    renderVoiceList();
    renderVoiceDetail();
    await loadModels();
    await refreshArticles();
    if (voicesData && !voicesData.engines.some(engine => engine.available)) {
      showToast('本机暂无可用语音引擎，先到「音色库」下载一个模型', true);
    }
    if (state.scriptId) {
      try {
        script = await invoke<PodcastScript>('voice.podcast.script.read', { scriptId: state.scriptId });
        renderScript();
      } catch {
        state.scriptId = '';
      }
    }
    if (state.podcastAudioId) {
      const manifest = await refreshManifest(state.podcastAudioId);
      if (manifest && manifest.segments.length > 0) {
        podcastPlayerTick(false, 0, 0);
      } else {
        state.podcastAudioId = '';
      }
    }
  } catch (error) {
    showToast(`初始化失败：${errorMessage(error)}`, true);
  }
  renderPodcastState();
  setTab(state.tab);
}

// API 1 修订 2：骨架渲染完即通知宿主结束加载提示，不等待动画帧（原生容器可能隐藏）。
sdk.ready().catch(error => console.error('ready 失败', error));

void bootstrap();
