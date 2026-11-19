import type {Invocation, PluginContext} from 'blc-plugin-sdk';

function scope(invocation: Invocation) {
  if (!invocation.workspaceId || !invocation.workspaceSession) throw new Error('请先打开创作工作区，再选择文章');
  return {workspaceId: invocation.workspaceId, workspaceSession: invocation.workspaceSession};
}

export async function listArticles(ctx: PluginContext, invocation: Invocation, query = '') {
  const context = scope(invocation);
  const queue = [''];
  const items: {path: string; title: string}[] = [];
  const keyword = query.trim().toLowerCase();
  let visited = 0;
  while (queue.length && visited++ < 512 && items.length < 500) {
    const path = queue.shift()!;
    let offset = 0;
    for (;;) {
      invocation.signal.throwIfAborted();
      const page = await ctx.workspace.resources({...context, path, offset, limit: 100});
      for (const entry of page.items) {
        if (entry.IsDir) queue.push(entry.Rel);
        else if (/\.(md|markdown|txt)$/i.test(entry.Name) && (!keyword || `${entry.Title} ${entry.Rel}`.toLowerCase().includes(keyword))) {
          items.push({path: entry.Rel, title: entry.Title || entry.Name.replace(/\.[^.]+$/, '')});
          if (items.length >= 500) break;
        }
      }
      if (page.nextOffset >= page.total || items.length >= 500) break;
      if (page.nextOffset <= offset) throw new Error('文章列表分页无效');
      offset = page.nextOffset;
    }
  }
  return {items, truncated: items.length >= 500 || queue.length > 0};
}

export async function readArticle(ctx: PluginContext, invocation: Invocation, path: string): Promise<string> {
  const context = scope(invocation);
  if (!/\.(md|markdown|txt)$/i.test(path)) throw new Error('请选择工作区中的文章');
  let offset = 0, hash = '', content = '';
  for (;;) {
    invocation.signal.throwIfAborted();
    const part = await ctx.workspace.read({...context, path, offset, limit: 96 * 1024});
    if (!hash) hash = part.hash;
    if (part.hash !== hash) throw new Error('文章读取时已修改，请重新生成');
    content += part.content;
    if (part.complete) return content;
    if (part.totalBytes > 16 * 1024 * 1024 || part.nextOffset <= offset) throw new Error('文章内容过大或读取失败');
    offset = part.nextOffset;
  }
}
