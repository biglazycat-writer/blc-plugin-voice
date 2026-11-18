import { definePlugin, type Invocation, type PluginContext } from 'blc-plugin-sdk';

type HelloArgs = { name?: string };

/**
 * 后台入口。激活时注册清单中声明的全部命令，返回值是停用插件时的清理函数。
 * 所有命令都必须在这里注册，不要在首次调用时才补注册。
 */
export default definePlugin(async (ctx: PluginContext) => {
  ctx.commands.register('template.hello', async (args: HelloArgs, invocation: Invocation) => {
    invocation.signal.throwIfAborted();
    await invocation.progress(0.5, '正在准备问候语');
    const name = String(args?.name ?? '').trim() || '大懒猫';
    return { message: `你好，${name}！`, from: ctx.pluginId, apiVersion: ctx.apiVersion };
  });

  ctx.commands.register('template.status', () => ({
    pluginId: ctx.pluginId,
    apiVersion: ctx.apiVersion,
    generation: ctx.generation,
    commands: 3,
  }));

  ctx.commands.register('template.open', async (_args: unknown, invocation: Invocation) => {
    await ctx.views.open('main', {
      context: invocation,
      state: { openedAt: new Date().toISOString() },
    });
    return { opened: true };
  });

  return () => {
    // 停用插件时在这里释放连接、定时器、监听器等资源。本模板没有需要清理的资源。
  };
});
