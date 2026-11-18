import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import plugin from '../dist/main.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/** 用最小 mock 代替宿主 PluginContext，测试不依赖大懒猫创作平台。 */
function harness() {
  const commands = new Map();
  const opened = [];
  const context = {
    pluginId: 'blc-plugin-template',
    apiVersion: 1,
    generation: 'test-generation',
    dataDir: '/tmp/blc-plugin-template-test',
    commands: { register: (id, handler) => commands.set(id, handler) },
    views: {
      open: async (id, options) => {
        opened.push({ id, options });
        return { viewId: id, instanceId: 'test-instance' };
      },
    },
  };
  return { context, commands, opened };
}

function invocation(signal = AbortSignal.timeout(5000)) {
  const progressLog = [];
  return {
    signal,
    progress: async (value, message) => { progressLog.push({ value, message }); },
    progressLog,
  };
}

test('清单声明的命令全部在激活时注册，且提供清理函数', async () => {
  const { context, commands } = harness();
  const dispose = await plugin.activate(context);
  const declared = manifest.biglazycat.contributes.commands.map(command => command.id).sort();
  assert.deepEqual([...commands.keys()].sort(), declared);
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
});

test('template.hello 返回问候并报告进度', async () => {
  const { context, commands } = harness();
  await plugin.activate(context);
  const inv = invocation();
  const result = await commands.get('template.hello')({ name: '  测试  ' }, inv);
  assert.equal(result.message, '你好，测试！');
  assert.equal(result.from, 'blc-plugin-template');
  assert.equal(result.apiVersion, 1);
  assert.deepEqual(inv.progressLog, [{ value: 0.5, message: '正在准备问候语' }]);

  const fallback = await commands.get('template.hello')({}, invocation());
  assert.equal(fallback.message, '你好，大懒猫！');
});

test('已取消的调用不产生进度等副作用', async () => {
  const { context, commands } = harness();
  await plugin.activate(context);
  const controller = new AbortController();
  controller.abort();
  const inv = invocation(controller.signal);
  await assert.rejects(() => commands.get('template.hello')({}, inv), { name: 'AbortError' });
  assert.equal(inv.progressLog.length, 0);
});

test('template.status 返回插件身份与命令数', async () => {
  const { context, commands } = harness();
  await plugin.activate(context);
  assert.deepEqual(await commands.get('template.status')({}, invocation()), {
    pluginId: 'blc-plugin-template',
    apiVersion: 1,
    generation: 'test-generation',
    commands: 3,
  });
});

test('template.open 打开 main 视图并传递调用上下文', async () => {
  const { context, commands, opened } = harness();
  await plugin.activate(context);
  const inv = invocation();
  const result = await commands.get('template.open')({}, inv);
  assert.equal(result.opened, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].id, 'main');
  assert.equal(opened[0].options.context, inv);
  assert.equal(typeof opened[0].options.state.openedAt, 'string');
});

test('清单入口、视图与菜单引用自洽', () => {
  const spec = manifest.biglazycat;
  assert.equal(spec.apiVersion, 1);
  assert.equal(spec.main, 'dist/main.js');
  assert.equal(spec.mainView, spec.contributes.views[0].id);
  assert.equal(spec.contributes.views[0].entry, 'dist/ui/index.html');
  for (const menu of spec.contributes.menus) {
    assert.ok(spec.contributes.commands.some(command => command.id === menu.command));
  }
});
