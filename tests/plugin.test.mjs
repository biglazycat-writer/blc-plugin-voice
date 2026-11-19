import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../dist/main.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** 最小 mock 宿主上下文：storage 用内存 Map，dataDir 用临时目录。 */
async function harness({ ai } = {}) {
  const commands = new Map();
  const opened = [];
  const services = [];
  const storage = new Map();
  const dataDir = await mkdtemp(join(tmpdir(), 'blc-voice-test-'));
  const context = {
    pluginId: 'blc-plugin-voice',
    apiVersion: 1,
    apiRevision: 4,
    generation: 'test-generation',
    dataDir,
    commands: { register: (id, handler) => commands.set(id, handler) },
    views: {
      open: async (id, options) => {
        opened.push({ id, options });
        return { viewId: id, instanceId: 'test-instance' };
      },
    },
    storage: {
      get: async key => storage.get(key) ?? null,
      set: async (key, value) => void storage.set(key, value),
    },
    services: { provide: (id, methods) => void services.push({ id, methods }) },
    documents: {
      export: async () => {
        throw new Error('测试不提供文档桥');
      },
    },
    ...(ai ? { ai } : {}),
  };
  return { context, commands, opened, services, storage, dataDir };
}

function invocation(signal = AbortSignal.timeout(120000)) {
  const progressLog = [];
  return {
    signal,
    progress: async (value, message) => void progressLog.push({ value, message }),
    progressLog,
  };
}

test('清单声明的命令全部在激活时注册，且提供清理函数', async () => {
  const { context, commands } = await harness();
  const dispose = await plugin.activate(context);
  const declared = manifest.biglazycat.contributes.commands.map(command => command.id).sort();
  assert.deepEqual([...commands.keys()].sort(), declared);
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('voice.open 默认打开播客制作并透传调用上下文', async () => {
  const { context, commands, opened } = await harness();
  const dispose = await plugin.activate(context);
  const inv = invocation();
  const result = await commands.get('voice.open')({}, inv);
  assert.equal(result.opened, true);
  assert.equal(opened[0].id, 'main');
  assert.equal(opened[0].options.context, inv);
  assert.equal(opened[0].options.state.tab, 'podcast');
  assert.equal(manifest.biglazycat.settingsView, 'settings');
  assert.equal(manifest.biglazycat.contributes.views.find(view => view.id === 'main').title, '播客制作');
  dispose();
});

test('播客制作读取所选工作区文章，不依赖当前编辑器', async () => {
  const {context, commands, dataDir} = await harness();
  context.workspace = {
    read: async request => {
      assert.equal(request.workspaceId, 'workspace');
      assert.equal(request.workspaceSession, 'session');
      assert.equal(request.path, '作品/测试文章.md');
      return {content: '# 所选文章\n\n所选文章正文用于生成播客，内容足够长，可以组织成独白脚本并验证读的是所选文章。', hash: 'stable', complete: true};
    },
  };
  const dispose = await plugin.activate(context);
  try {
    const script = await commands.get('voice.podcast.script')({source: 'article', path: '作品/测试文章.md', style: 'solo', useAi: false}, {...invocation(), workspaceId: 'workspace', workspaceSession: 'session'});
    assert.ok(script.lines.some(line => line.text.includes('所选文章正文')));
    assert.equal(script.style, 'solo');
  } finally {dispose(); await rm(dataDir, {recursive: true, force: true});}
});

test('voice.status 汇报引擎、音色与磁盘占用', async () => {
  const { context, commands, dataDir } = await harness();
  const dispose = await plugin.activate(context);
  const status = await commands.get('voice.status')({}, invocation());
  assert.equal(status.pluginId, 'blc-plugin-voice');
  assert.ok(Array.isArray(status.engines));
  assert.ok(status.engines.some(engine => engine.id === 'sherpa'));
  assert.equal(typeof status.voiceCount, 'number');
  assert.equal(status.modelUsageBytes >= 0, true);
  assert.equal(status.audioUsageBytes >= 0, true);
  dispose();
  await rm(dataDir, { recursive: true, force: true });
});

test('音色列表返回结构完整的音色行与设置', async () => {
  const { context, commands, dataDir } = await harness();
  const dispose = await plugin.activate(context);
  const result = await commands.get('voice.voices.list')({}, invocation());
  assert.ok(Array.isArray(result.voices));
  assert.equal(result.settings.version, 1);
  assert.ok(Array.isArray(result.engines));
  for (const voice of result.voices) {
    assert.ok(voice.id.startsWith(`${voice.engineId}:`), `音色 ID 应带引擎前缀：${voice.id}`);
    assert.ok(voice.name);
    assert.ok(voice.lang);
  }
  dispose();
  await rm(dataDir, { recursive: true, force: true });
});

test('settings.update 深合并收藏、角色与每音色参数', async () => {
  const { context, commands, dataDir } = await harness();
  const dispose = await plugin.activate(context);
  const first = await commands.get('voice.settings.update')({
    favorites: { 'sapi:Microsoft Huihui Desktop': true },
    roles: { reader: 'sapi:Microsoft Huihui Desktop' },
    params: { 'sapi:Microsoft Huihui Desktop': { speed: 1.2 } },
    mirror: 'https://gh-proxy.com/',
  }, invocation());
  assert.equal(first.favorites['sapi:Microsoft Huihui Desktop'], true);
  assert.equal(first.roles.reader, 'sapi:Microsoft Huihui Desktop');
  const second = await commands.get('voice.settings.update')({
    roles: { host: 'say:Tingting' },
    params: { 'sapi:Microsoft Huihui Desktop': { pitch: -10 } },
  }, invocation());
  assert.equal(second.roles.reader, 'sapi:Microsoft Huihui Desktop', '未提到的角色保持不变');
  assert.equal(second.roles.host, 'say:Tingting');
  assert.equal(second.params['sapi:Microsoft Huihui Desktop'].speed, 1.2);
  assert.equal(second.params['sapi:Microsoft Huihui Desktop'].pitch, -10);
  assert.equal(second.mirror, 'https://gh-proxy.com/');
  assert.equal(second.defaults.speed, 1);
  dispose();
  await rm(dataDir, { recursive: true, force: true });
});

test('voice.job.create 切分粘贴文本并统计段落', async () => {
  const { context, commands, dataDir } = await harness();
  const dispose = await plugin.activate(context);
  const job = await commands.get('voice.job.create')({
    source: 'text',
    text: '# 标题\n\n第一段内容。\n\n第二段内容更长一些，用来验证切分行为是否正常工作。',
  }, invocation());
  assert.match(job.jobId, /^job-/);
  assert.equal(job.paragraphCount, 3);
  assert.equal(job.paragraphs[0].text, '标题');
  const empty = commands.get('voice.job.create')({ source: 'text', text: '   ' }, invocation());
  await assert.rejects(() => empty, /粘贴的文本是空的/);
  dispose();
  await rm(dataDir, { recursive: true, force: true });
});

test('voice.render + audio.info + audio.read 全链路（SAPI 可用时）', async t => {
  if (process.platform !== 'win32') return t.skip('非 Windows 环境跳过 SAPI 真实合成');
  const { context, commands, dataDir } = await harness();
  const dispose = await plugin.activate(context);
  const inv = invocation();
  const voices = await commands.get('voice.voices.list')({}, inv);
  const sapiVoice = voices.voices.find(voice => voice.engineId === 'sapi');
  if (!sapiVoice) return t.skip('本机没有 SAPI 音色，跳过');
  const job = await commands.get('voice.job.create')({
    source: 'text',
    text: '这是第一段。\n\n这是第二段，内容稍长一点。',
  }, inv);
  const render = await commands.get('voice.render')({ jobId: job.jobId, voiceId: sapiVoice.id, speed: 1 }, inv);
  assert.equal(render.audioId, job.jobId);
  assert.equal(render.segmentCount, 2);
  assert.ok(render.durationMs > 0);
  const info = await commands.get('voice.audio.info')({ audioId: render.audioId }, inv);
  assert.equal(info.segments.length, 2);
  assert.equal(info.segments[0].text, '这是第一段。');
  for (const segment of info.segments) {
    assert.ok(segment.durationMs > 0);
    assert.equal(segment.file, undefined, '清单不应暴露内部文件名');
    let assembled = '';
    let offset = 0;
    let hash;
    for (;;) {
      const chunk = await commands.get('voice.audio.read')({ audioId: render.audioId, index: segment.index, offset, hash }, inv);
      assembled += chunk.chunk;
      hash = chunk.hash;
      if (chunk.complete) break;
      offset = chunk.nextOffset;
    }
    assert.ok(assembled.length > 0);
    assert.equal(Buffer.from(assembled, 'base64').toString('ascii', 0, 4), 'RIFF');
  }
  const badIndex = commands.get('voice.audio.read')({ audioId: render.audioId, index: 99, offset: 0 }, inv);
  await assert.rejects(() => badIndex, /越界/);
  dispose();
  await rm(dataDir, { recursive: true, force: true });
});

test('已取消的调用以 AbortError 结束', async t => {
  if (process.platform !== 'win32') return t.skip('非 Windows 环境跳过 SAPI 真实合成');
  const { context, commands, dataDir } = await harness();
  const dispose = await plugin.activate(context);
  const voices = await commands.get('voice.voices.list')({}, invocation());
  const sapiVoice = voices.voices.find(voice => voice.engineId === 'sapi');
  if (!sapiVoice) return t.skip('本机没有 SAPI 音色，跳过');
  const controller = new AbortController();
  const inv = invocation(controller.signal);
  const job = await commands.get('voice.job.create')({ source: 'text', text: '取消测试。'.repeat(3) }, invocation());
  controller.abort();
  await assert.rejects(
    () => commands.get('voice.render')({ jobId: job.jobId, voiceId: sapiVoice.id }, inv),
    error => error.name === 'AbortError' || /取消/.test(String(error.message)),
  );
  dispose();
  await rm(dataDir, { recursive: true, force: true });
});

test('播客脚本通过通用 AI 接口生成，并可明确选择本地规则', async () => {
  const { context, commands, dataDir } = await harness({
    ai: {
      generate: async (request, options) => {
        assert.ok(request.prompt.includes('播客脚本'));
        assert.equal('conversationId' in request, false);
        assert.ok(options.signal instanceof AbortSignal);
        return {
          text: '```json\n[{"speaker":"host","text":"欢迎收听"},{"speaker":"guest","text":"今天聊这篇"},{"speaker":"host","text":"好，开始吧"}]\n```',
        };
      },
    },
  });
  const dispose = await plugin.activate(context);
  const inv = invocation();
  const script = await commands.get('voice.podcast.script')({
    source: 'text',
    text: '一篇测试文章的正文，内容足够长，可以支撑一次脚本生成的验证流程，这里多写一些字数。',
    style: 'duet',
    minutes: 2,
  }, inv);
  assert.equal(script.source, 'ai');
  assert.equal(script.lines.length, 3);
  const updated = await commands.get('voice.podcast.script.update')({
    scriptId: script.scriptId,
    lines: [{ speaker: 'host', text: '改过的开场' }, { speaker: 'guest', text: '改过的回应' }],
  }, inv);
  assert.equal(updated.saved, true);
  const readBack = await commands.get('voice.podcast.script.read')({ scriptId: script.scriptId }, inv);
  assert.deepEqual(readBack.lines.map(line => line.text), ['改过的开场', '改过的回应']);

  const fallbackCtx = await harness();
  const fallbackDispose = await plugin.activate(fallbackCtx.context);
  const fallback = await fallbackCtx.commands.get('voice.podcast.script')({
    source: 'text',
    text: '另一篇用于降级路径的文章，长度也足够，保证规则脚本能从中抽取到要点句子并组织成对话轮次。',
    style: 'duet',
    useAi: false,
  }, invocation());
  assert.equal(fallback.source, 'fallback');
  assert.ok(fallback.lines.length >= 4);
  fallbackDispose();
  dispose();
  await rm(dataDir, { recursive: true, force: true });
});

test('AI 失败和取消不会静默保存本地规则脚本', async () => {
  const {context,commands,dataDir} = await harness({ai:{generate:async()=>{throw new Error('MODEL_UNAVAILABLE: 平台没有可用模型');}}});
  const dispose = await plugin.activate(context);
  try {
    await assert.rejects(() => commands.get('voice.podcast.script')({source:'text',text:'用于脚本生成的文章内容。'.repeat(10),style:'solo'}, invocation()), /MODEL_UNAVAILABLE/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => commands.get('voice.podcast.script')({source:'text',text:'用于脚本生成的文章内容。'.repeat(10),style:'solo'}, invocation(controller.signal)), error => error.name === 'AbortError');
    assert.deepEqual(await readdir(join(dataDir,'scripts')).catch(error=>{if(error.code==='ENOENT')return [];throw error;}),[]);
  } finally {dispose();await rm(dataDir,{recursive:true,force:true});}
});

test('播客合成（SAPI 可用时）：逐行音色与停顿元数据', async t => {
  if (process.platform !== 'win32') return t.skip('非 Windows 环境跳过 SAPI 真实合成');
  const { context, commands, dataDir } = await harness();
  const dispose = await plugin.activate(context);
  const inv = invocation();
  const voices = await commands.get('voice.voices.list')({}, inv);
  const sapiVoices = voices.voices.filter(voice => voice.engineId === 'sapi');
  if (sapiVoices.length === 0) return t.skip('本机没有 SAPI 音色，跳过');
  // 主持/嘉宾都用中文音色，避免 SAPI 英文音色读中文静音的已知行为。
  const zhVoices = sapiVoices.filter(voice => voice.lang.startsWith('zh'));
  const hostVoice = (zhVoices[0] ?? sapiVoices[0]).id;
  const guestVoice = (zhVoices[1] ?? zhVoices[0] ?? sapiVoices[0]).id;
  const script = await commands.get('voice.podcast.script')({
    source: 'text',
    text: '播客合成测试文章：先有开场，再有内容，最后收尾。内容足够长以便切分出多段，用于验证播客管线。',
    style: 'duet',
    useAi: false,
  }, inv);
  await commands.get('voice.settings.update')({ roles: { host: hostVoice, guest: guestVoice } }, inv);
  const result = await commands.get('voice.podcast.render')({ scriptId: script.scriptId, speed: 1 }, inv);
  assert.equal(result.audioId, script.scriptId);
  assert.ok(result.segments >= 3);
  const info = await commands.get('voice.audio.info')({ audioId: result.audioId }, inv);
  assert.equal(info.kind, 'podcast');
  assert.equal(info.linePauseMs, 420);
  assert.ok(info.segments.some(segment => segment.speaker === 'guest'));
  dispose();
  await rm(dataDir, { recursive: true, force: true });
});

test('voice.models.list 返回目录与镜像设置', async () => {
  const { context, commands, dataDir } = await harness();
  const dispose = await plugin.activate(context);
  const result = await commands.get('voice.models.list')({}, invocation());
  assert.ok(result.models.length >= 5);
  for (const model of result.models) {
    assert.equal(typeof model.installed, 'boolean');
    assert.ok(model.sizeBytes > 0);
  }
  assert.equal(result.mirror, '');
  const unknown = commands.get('voice.models.download')({ modelId: 'not-exist' }, invocation());
  await assert.rejects(() => unknown, /未知模型/);
  dispose();
  await rm(dataDir, { recursive: true, force: true });
});

test('tts 服务可用并拒绝空文本', async t => {
  const { context, commands, services, dataDir } = await harness();
  const dispose = await plugin.activate(context);
  const service = services.find(item => item.id === 'tts');
  assert.ok(service, '应提供 tts 服务');
  await assert.rejects(() => service.methods.synthesize({ text: ' ' }), /缺少要合成的文本/);
  if (process.platform === 'win32') {
    const voices = await commands.get('voice.voices.list')({}, invocation());
    const sapiVoice = voices.voices.find(voice => voice.engineId === 'sapi');
    if (sapiVoice) {
      const result = await service.methods.synthesize({ text: '服务试听', voiceId: sapiVoice.id });
      assert.match(result.audioId, /^svc-/);
    }
  } else {
    t.skip('仅 Windows 验证真实合成');
  }
  dispose();
  await rm(dataDir, { recursive: true, force: true });
});

test('清单入口、视图、菜单与服务引用自洽', async () => {
  const spec = manifest.biglazycat;
  assert.equal(spec.apiVersion, 1);
  assert.equal(spec.main, 'dist/main.js');
  assert.equal(spec.mainView, spec.contributes.views[0].id);
  assert.equal(spec.contributes.views[0].entry, 'dist/ui/index.html');
  for (const menu of spec.contributes.menus) {
    assert.ok(spec.contributes.commands.some(command => command.id === menu.command));
  }
  const serviceIds = new Set(spec.contributes.services.map(service => service.id));
  assert.ok(serviceIds.has('tts'));
  for (const service of spec.contributes.services) {
    assert.ok(service.methods.length >= 1);
  }
});
