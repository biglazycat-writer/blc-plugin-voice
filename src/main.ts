import { definePlugin, readDocument, type Invocation, type Json } from 'blc-plugin-sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { ModelStore } from './lib/model-store.js';
import { EngineRegistry } from './lib/engines/registry.js';
import { SettingsStore } from './lib/settings.js';
import { AudioStore } from './lib/audio-store.js';
import { PodcastStore, generateScript, replaceLines, renderPodcast, LINE_PAUSE_MS } from './lib/podcast.js';
import { exportAudio } from './lib/export.js';
import { splitIntoParagraphs } from './lib/splitter.js';
import { clampNumber, sanitizeId, newId, parseWav } from './lib/util.js';
import { registerSpeechProvider } from './lib/speech-provider.js';
import {listArticles, readArticle} from './lib/articles.js';

type JobRecord = {
  jobId: string;
  title: string;
  createdAt: string;
  paragraphs: Array<{ index: number; text: string; chars: number }>;
};

interface TrackedSignal {
  signal: AbortSignal;
  unregister(): void;
  abort(): void;
}

const SAMPLE_TEXT = '你好，我是大懒猫创作平台的本地语音。这句话用来试听当前音色的效果。';

export default definePlugin(ctx => {
  const models = new ModelStore(ctx.dataDir);
  const registry = new EngineRegistry(models);
  const settings = new SettingsStore(ctx);
  const audio = new AudioStore(ctx.dataDir);
  const scripts = new PodcastStore(ctx.dataDir);
  /** 进行中的长任务（渲染/下载），停用插件时统一中止。 */
  const tracked = new Set<TrackedSignal>();

  function linkedSignal(invocation: Invocation): TrackedSignal {
    const controller = new AbortController();
    const record: TrackedSignal = {
      signal: AbortSignal.any([invocation.signal, controller.signal]),
      unregister: () => tracked.delete(record),
      abort: () => controller.abort(),
    };
    tracked.add(record);
    return record;
  }

  /** 从调用上下文读取不可变文档快照；没有文档上下文时返回 null。 */
  async function readInvocationDocument(invocation: Invocation): Promise<string | null> {
    if (!invocation.workspaceId || !invocation.workspaceSession || !invocation.documentId || !invocation.editorId) return null;
    const document = await readDocument(ctx.documents, {
      workspaceId: invocation.workspaceId,
      workspaceSession: invocation.workspaceSession,
      documentId: invocation.documentId,
      editorId: invocation.editorId,
      windowId: invocation.windowId,
    }, { signal: invocation.signal });
    return document.content;
  }

  /** 朗读任务存内存即可：重启后重新从文档创建，音频产物都在 dataDir。 */
  const jobs = new Map<string, JobRecord>();

  /** 把合成结果写进 manifest 的公共流程。 */
  async function saveSegments(audioId: string, requests: Array<{ outFile: string; text: string; voiceId: string }>, totalDurationMs: number): Promise<void> {
    const manifest = await audio.get(audioId);
    if (!manifest) return;
    const segments = [];
    let sampleRate = 0;
    for (let i = 0; i < requests.length; i += 1) {
      const buffer = await readFile(requests[i].outFile);
      const info = parseWav(buffer);
      if (i === 0) sampleRate = info.sampleRate;
      segments.push({
        index: i,
        file: requests[i].outFile.split(/[\\/]/).pop()!,
        text: requests[i].text,
        voiceId: requests[i].voiceId,
        bytes: buffer.length,
        durationMs: info.durationMs,
      });
    }
    manifest.segments = segments;
    // 各引擎产物采样率不同（SAPI/sherpa 归一到 24000，say/espeak 原生 22050），以真实 WAV 头为准。
    if (sampleRate) manifest.sampleRate = sampleRate;
    manifest.meta.totalDurationMs = Math.round(totalDurationMs);
    await audio.saveManifest(audioId, manifest);
  }

  ctx.commands.register('voice.open', async (args: { tab?: string } | undefined, invocation: Invocation) => {
    await ctx.views.open('main', {
      context: invocation,
      state: {
        openedAt: new Date().toISOString(),
        tab: args?.tab === 'voices' ? 'voices' : 'podcast',
      },
    });
    return { opened: true, view: 'main' };
  });

  ctx.commands.register('voice.status', async () => {
    const voices = await registry.allVoices();
    const [installed, modelUsage, audioUsage] = await Promise.all([
      models.listInstalled(),
      models.usageBytes(),
      audio.usageBytes(),
    ]);
    return {
      pluginId: ctx.pluginId,
      apiRevision: ctx.apiRevision,
      engines: registry.infos(),
      voiceCount: voices.length,
      installedModels: installed.map(model => model.modelId),
      modelUsageBytes: modelUsage,
      audioUsageBytes: audioUsage,
      runningTasks: tracked.size,
    };
  });

  ctx.commands.register('voice.engines.list', async () => {
    // 触发一次探测，保证 available/reason 是新鲜值。
    await registry.allVoices();
    return registry.infos();
  });

  ctx.commands.register('voice.voices.list', async () => {
    const [voices, current] = await Promise.all([registry.allVoices(), settings.get()]);
    return { voices, settings: current, engines: registry.infos() };
  });

  ctx.commands.register('voice.settings.get', async () => settings.get());

  ctx.commands.register('voice.settings.update', async (args: Record<string, unknown>) => settings.update(args ?? {}));

  ctx.commands.register('voice.voices.test', async (args: { voiceId?: string; text?: string; speed?: number }, invocation: Invocation) => {
    const voiceId = String(args?.voiceId ?? '');
    if (!voiceId) throw new Error('请指定要试听的音色');
    const { engine, voice } = await registry.resolveVoice(voiceId);
    const params = await settings.paramsFor(voiceId);
    const text = String(args?.text ?? '').trim() || SAMPLE_TEXT;
    const audioId = newId('test');
    await audio.create(audioId, 'test', { voiceId, voiceName: voice.name });
    const outFile = audio.segmentPath(audioId, 'seg-00000.wav');
    const linked = linkedSignal(invocation);
    const request = {
      text,
      voice,
      voiceId,
      speed: clampNumber(args?.speed, 0.5, 2, params.speed),
      volume: params.volume,
      pitch: params.pitch,
      outFile,
      signal: linked.signal,
    };
    try {
      const { durationMs } = engine.synthesizeBatch
        ? await engine.synthesizeBatch([request], { signal: request.signal })
        : await engine.synthesize(request);
      await saveSegments(audioId, [request], durationMs);
      return { audioId, voiceName: voice.name, durationMs };
    } finally {
      linked.unregister();
      await audio.pruneTests();
    }
  });

  ctx.commands.register('voice.job.create', async (args: { source?: string; text?: string; title?: string }, invocation: Invocation) => {
    const source = args?.source === 'text' ? 'text' : 'document';
    const raw = source === 'text' ? String(args?.text ?? '') : await readInvocationDocument(invocation);
    if (!raw || !raw.trim()) {
      throw new Error(source === 'document'
        ? '调用上下文里没有文档：请在编辑器里打开文章后再朗读，或改用粘贴文本'
        : '粘贴的文本是空的');
    }
    const paragraphs = splitIntoParagraphs(raw);
    if (paragraphs.length === 0) throw new Error('文章切分后没有可朗读的段落');
    const job: JobRecord = {
      jobId: newId('job'),
      title: String(args?.title ?? '').trim() || paragraphs[0].text.slice(0, 30),
      createdAt: new Date().toISOString(),
      paragraphs,
    };
    jobs.set(job.jobId, job);
    const textsIncluded = paragraphs.reduce((sum, paragraph) => sum + paragraph.chars, 0) <= 200_000;
    return {
      jobId: job.jobId,
      title: job.title,
      paragraphCount: paragraphs.length,
      totalChars: paragraphs.reduce((sum, paragraph) => sum + paragraph.chars, 0),
      // 段落全文随结果返回（超长文档省略，合成后经音频清单获取）以控制结果体积。
      paragraphs: paragraphs.map(paragraph => ({
        index: paragraph.index,
        chars: paragraph.chars,
        ...(textsIncluded ? { text: paragraph.text } : {}),
      })),
    };
  });

  ctx.commands.register('voice.render', async (args: { jobId?: string; voiceId?: string; speed?: number }, invocation: Invocation) => {
    const job = jobs.get(String(args?.jobId ?? ''));
    if (!job) throw new Error('朗读任务不存在或已失效，请重新创建任务');
    const voiceId = String(args?.voiceId ?? '');
    if (!voiceId) throw new Error('请选择朗读音色');
    const { engine, voice } = await registry.resolveVoice(voiceId);
    const params = await settings.paramsFor(voiceId);
    const speed = clampNumber(args?.speed, 0.5, 2, params.speed);
    const audioId = job.jobId;
    invocation.signal.throwIfAborted();
    await audio.create(audioId, 'reading', { title: job.title.slice(0, 80), voiceId, voiceName: voice.name, speed });
    const linked = linkedSignal(invocation);
    const requests = job.paragraphs.map(paragraph => ({
      text: paragraph.text,
      voice,
      voiceId,
      speed,
      volume: params.volume,
      pitch: params.pitch,
      outFile: audio.segmentPath(audioId, `seg-${String(paragraph.index).padStart(5, '0')}.wav`),
      signal: linked.signal,
    }));
    try {
      let durationMs = 0;
      if (engine.synthesizeBatch) {
        ({ durationMs } = await engine.synthesizeBatch(requests, {
          signal: invocation.signal,
          onProgress: (completed, total) => void invocation.progress(completed / total, `已朗读 ${completed}/${total} 段`),
        }));
      } else {
        let done = 0;
        for (const request of requests) {
          durationMs += (await engine.synthesize(request)).durationMs;
          done += 1;
          await invocation.progress(done / requests.length, `已朗读 ${done}/${requests.length} 段`);
        }
      }
      await saveSegments(audioId, requests, durationMs);
      return { audioId, segmentCount: requests.length, durationMs, title: job.title };
    } finally {
      linked.unregister();
    }
  });

  ctx.commands.register('voice.audio.info', async (args: { audioId?: string }) => {
    const audioId = sanitizeId(args?.audioId);
    if (!audioId) throw new Error('缺少 audioId');
    const manifest = await audio.get(audioId);
    if (!manifest) throw new Error('音频产物不存在');
    return {
      ...manifest,
      segments: manifest.segments.map(segment => ({ ...segment, file: undefined })),
      linePauseMs: manifest.meta.linePauseMs ?? (manifest.kind === 'podcast' ? LINE_PAUSE_MS : 0),
    };
  });

  ctx.commands.register('voice.audio.read', async (args: { audioId?: string; index?: number; offset?: number; hash?: string }) => {
    const audioId = sanitizeId(args?.audioId);
    if (!audioId) throw new Error('缺少 audioId');
    const manifest = await audio.get(audioId);
    if (!manifest) throw new Error('音频产物不存在');
    let file: string;
    if (args?.index === undefined || args.index === null) {
      if (!manifest.exported) throw new Error('该产物还没有导出的整段文件，请先在朗读/播客页导出');
      file = manifest.exported.file;
    } else {
      const index = args.index;
      if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.segments.length) throw new Error('分段序号越界');
      file = manifest.segments[index].file;
    }
    return audio.readChunk(audioId, file, args?.offset ?? 0, args?.hash);
  });

  ctx.commands.register('voice.export', async (args: { audioId?: string; format?: string }, invocation: Invocation) => {
    const audioId = sanitizeId(args?.audioId);
    if (!audioId) throw new Error('缺少 audioId');
    const format = args?.format === 'mp3' ? 'mp3' : 'wav';
    const result = await exportAudio(audio, ctx.dataDir, audioId, format);
    invocation.signal.throwIfAborted();
    const target = await ctx.ui.saveFile({
      defaultName: `${result.format === 'mp3' ? '播客' : '朗读'}-${audioId}.${result.format}`,
      filters: { [result.format === 'mp3' ? 'MP3 音频' : 'WAV 音频']: [result.format] },
    });
    if (!target) return { saved: false, reason: '已生成但未选择保存位置', cachePath: result.path };
    await writeFile(target, await readFile(result.path));
    return { saved: true, path: target, format: result.format, bytes: result.bytes, durationMs: result.durationMs };
  });

  ctx.commands.register('voice.models.list', async () => {
    const [catalog, current] = await Promise.all([models.listCatalog(), settings.get()]);
    await registry.allVoices();
    return { models: catalog, engines: registry.infos(), mirror: current.mirror };
  });

  ctx.commands.register('voice.models.download', async (args: { modelId?: string }, invocation: Invocation) => {
    const modelId = sanitizeId(args?.modelId);
    if (!modelId) throw new Error('缺少 modelId');
    const current = await settings.get();
    const linked = linkedSignal(invocation);
    try {
      const meta = await models.download(modelId, {
        mirror: current.mirror || undefined,
        signal: linked.signal,
        onProgress: progress => {
          const ratio = progress.phase === 'download' && progress.totalBytes > 0
            ? progress.receivedBytes / progress.totalBytes
            : progress.phase === 'extract' ? 0.99 : 1;
          void invocation.progress(Math.min(1, ratio), progress.phase === 'download'
            ? `下载中 ${(progress.receivedBytes / 1048576).toFixed(1)} MB`
            : progress.phase === 'extract' ? '解压模型包…' : '整理模型文件…');
        },
      });
      registry.invalidate();
      return { installed: true, modelId: meta.modelId, files: meta.files };
    } finally {
      linked.unregister();
    }
  });

  ctx.commands.register('voice.models.remove', async (args: { modelId?: string }) => {
    const modelId = sanitizeId(args?.modelId);
    if (!modelId) throw new Error('缺少 modelId');
    const sherpa = registry.list().find(engine => engine.info.id === 'sherpa');
    if (sherpa && 'releaseModel' in sherpa) {
      await (sherpa as unknown as { releaseModel: (id: string) => Promise<void> }).releaseModel(modelId);
    }
    const removed = await models.remove(modelId);
    registry.invalidate();
    return { removed };
  });

  function podcastContext() {
    return { ctx, registry, settings, audio };
  }
  ctx.commands.register('voice.articles.list', (args: {query?: string}, invocation: Invocation) => listArticles(ctx, invocation, args?.query));

  ctx.commands.register('voice.podcast.script', async (args: Record<string, unknown>, invocation: Invocation) => {
    const style = args?.style === 'solo' ? 'solo' : 'duet';
    const source = args?.source === 'text' ? 'text' : 'document';
    const documentText = args?.source === 'article'
      ? await readArticle(ctx, invocation, String(args.path ?? ''))
      : source === 'document' ? await readInvocationDocument(invocation) : null;
    const linked = linkedSignal(invocation);
    try {
      const script = await generateScript(podcastContext(), {
        source,
        text: typeof args?.text === 'string' ? args.text : undefined,
        title: typeof args?.title === 'string' ? args.title : undefined,
        style,
        minutes: typeof args?.minutes === 'number' ? args.minutes : undefined,
        useAi: args?.useAi !== false,
        modelId: typeof args?.modelId === 'string' ? args.modelId : undefined,
      }, documentText, linked.signal);
      linked.signal.throwIfAborted();
      await scripts.save(script);
      await invocation.progress(1, '脚本已生成');
      return script as unknown as Json;
    } finally {
      linked.unregister();
    }
  });

  ctx.commands.register('voice.podcast.script.read', async (args: { scriptId?: string }) => {
    const script = await scripts.get(String(args?.scriptId ?? ''));
    if (!script) throw new Error('脚本不存在');
    return script as unknown as Json;
  });

  ctx.commands.register('voice.podcast.script.update', async (args: { scriptId?: string; lines?: unknown[] }) => {
    const script = await scripts.get(String(args?.scriptId ?? ''));
    if (!script) throw new Error('脚本不存在');
    const updated = replaceLines(script, Array.isArray(args?.lines) ? args.lines : []);
    await scripts.save(updated);
    return { saved: true, lineCount: updated.lines.length };
  });

  ctx.commands.register('voice.podcast.render', async (args: { scriptId?: string; hostVoiceId?: string; guestVoiceId?: string; speed?: number }, invocation: Invocation) => {
    const script = await scripts.get(String(args?.scriptId ?? ''));
    if (!script) throw new Error('脚本不存在');
    const current = await settings.get();
    const hostVoiceId = String(args?.hostVoiceId ?? current.roles.host ?? '');
    if (!hostVoiceId) throw new Error('请先在音色页选择主持人音色');
    const guestVoiceId = String(args?.guestVoiceId ?? current.roles.guest ?? hostVoiceId);
    const speed = clampNumber(args?.speed, 0.5, 2, current.defaults.speed);
    const linked = linkedSignal(invocation);
    try {
      const result = await renderPodcast(podcastContext(), {
        script,
        hostVoiceId,
        guestVoiceId: script.style === 'solo' ? hostVoiceId : guestVoiceId,
        speed,
        signal: linked.signal,
        onProgress: (completed, total, message) => void invocation.progress(completed / total, message ?? '合成中'),
      });
      return { ...result, scriptId: script.scriptId, title: script.title };
    } finally {
      linked.unregister();
    }
  });

  // 服务：给其他插件/宿主 AI 调用本地 TTS。产物是缓存片段，返回 audioId。
  ctx.services.provide('tts', {
    voices: async () => {
      const [voices, current] = await Promise.all([registry.allVoices(), settings.get()]);
      return { voices, roles: current.roles } as unknown as Json;
    },
    synthesize: async (args: { text?: string; voiceId?: string; speed?: number }) => {
      const text = String(args?.text ?? '').trim();
      if (!text) throw new Error('缺少要合成的文本');
      if (text.length > 2000) throw new Error('文本超过 2000 字，请分段调用');
      const current = await settings.get();
      const voiceId = String(args?.voiceId ?? current.roles.reader ?? '');
      if (!voiceId) throw new Error('请指定音色，或先在语音工坊设置默认朗读音色');
      const { engine, voice } = await registry.resolveVoice(voiceId);
      const params = await settings.paramsFor(voiceId);
      const audioId = newId('svc');
      await audio.create(audioId, 'test', { voiceId, voiceName: voice.name, viaService: true });
      const outFile = audio.segmentPath(audioId, 'seg-00000.wav');
      const request = {
        text,
        voice,
        voiceId,
        speed: clampNumber(args?.speed, 0.5, 2, params.speed),
        volume: params.volume,
        pitch: params.pitch,
        outFile,
        signal: AbortSignal.timeout(120000),
      };
      await (engine.synthesizeBatch ? engine.synthesizeBatch([request], { signal: request.signal }) : engine.synthesize(request));
      await saveSegments(audioId, [request], 0);
      await audio.pruneTests();
      return { audioId } as unknown as Json;
    },
  });

  // 激活期清理过期产物，保持 dataDir 不无限增长。
  void audio.cleanup(7 * 24 * 3600 * 1000).catch(() => {});

  const disposeSpeechProvider = registerSpeechProvider(ctx, registry, settings);
  return async () => {
    for (const record of tracked) record.abort();
    await disposeSpeechProvider();
    registry.dispose();
  };
});
