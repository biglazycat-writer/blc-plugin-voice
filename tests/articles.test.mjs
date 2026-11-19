import test from 'node:test';
import assert from 'node:assert/strict';
import {listArticles, readArticle} from '../dist/lib/articles.js';

const invocation = {workspaceId: 'workspace', workspaceSession: 'session', signal: new AbortController().signal};
test('article picker lists saved text articles using the public workspace API', async () => {
  const ctx = {workspace: {resources: async request => {
    assert.equal(request.workspaceId, 'workspace'); assert.equal(request.workspaceSession, 'session');
    const items = request.path ? [{Rel: 'folder/article.md', Name: 'article.md', Title: 'Article', IsDir: false}] : [{Rel: 'folder', Name: 'folder', IsDir: true}, {Rel: 'image.png', Name: 'image.png', IsDir: false}];
    return {items, total: items.length, nextOffset: items.length};
  }}};
  assert.deepEqual((await listArticles(ctx, invocation)).items, [{path: 'folder/article.md', title: 'Article'}]);
});
test('article reads use byte offsets and reject changes between chunks', async () => {
  const ctx = {workspace: {read: async request => request.offset === 0 ? {content: '中文', hash: 'same', nextOffset: 6, totalBytes: 7, complete: false} : {content: '!', hash: 'same', nextOffset: 7, totalBytes: 7, complete: true}}};
  assert.equal(await readArticle(ctx, invocation, 'article.md'), '中文!');
  ctx.workspace.read = async request => ({content: 'text', hash: request.offset === 0 ? 'first' : 'changed', nextOffset: 4, totalBytes: 8, complete: false});
  await assert.rejects(() => readArticle(ctx, invocation, 'article.md'), /修改/);
});
