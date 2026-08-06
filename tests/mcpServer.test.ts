import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/adapters/memoryStorage.ts';
import { FakeModelBackend } from '../src/adapters/fakeModelBackend.ts';
import { TavernStudyHost } from '../src/core/tavernStudyHost.ts';
import { TavernStudyMcpServer } from '../src/mcp/server.ts';
import type { AuthContext } from '../src/auth.ts';

const owner: AuthContext = { actorId: 'owner', actorType: 'owner', displayName: 'Owner', scopes: new Set(['study:read', 'study:write', 'chapters:write', 'desk:read', 'desk:write', 'published:read', 'comments:read', 'comments:write']) };
const companion: AuthContext = { actorId: 'companion', actorType: 'ai', displayName: 'Reader', scopes: new Set(['published:read', 'comments:read']) };

function fixture() {
  const storage = createMemoryStorage();
  const model = new FakeModelBackend({ ok: true, terminal: 'clean', text: 'Next.', thinking: '', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
  return new TavernStudyHost({ storage, model });
}

async function initialize(server: TavernStudyMcpServer) {
  return server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
}
async function call(server: TavernStudyMcpServer, id: number, name: string, args: any = {}) {
  return server.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

test('runs the shelf and bookclub tool flows against the underlying study and reading services', async () => {
  const host = fixture();
  const server = new TavernStudyMcpServer(host, owner);
  const initialized = await initialize(server);
  assert.equal(initialized.result.serverInfo.name, 'tavern-study');
  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map((tool: any) => tool.name), ['shelf', 'bookclub']);

  const created = await host.study.create({ project: 'demo', category: 'world', title: 'Lore', content: 'Brass key.' });
  assert.equal(created.success, true);
  const listResult = await call(server, 3, 'shelf', { project: 'demo' });
  assert.equal(listResult.result.structuredContent.count, 1);
  const getResult = await call(server, 4, 'shelf', { action: 'get', id: created.id });
  assert.equal(getResult.result.structuredContent.content, 'Brass key.');
  const statsResult = await call(server, 41, 'shelf', { action: 'stats' });
  assert.deepEqual(statsResult.result.structuredContent, { success: true, by_category: { world: 1 }, by_project: { demo: 1 }, total: 1 });

  const draft = await host.reading.createDraft({ project: 'demo', title: 'One', content: 'Published.' });
  const chapterId = draft.chapter.id;
  await host.reading.publish(chapterId);
  const chapters = await call(server, 5, 'bookclub', {});
  assert.equal(chapters.result.structuredContent.count, 1);
  const read = await call(server, 6, 'bookclub', { action: 'read', id: chapterId });
  assert.equal(read.result.structuredContent.content, 'Published.');
  const commented = await call(server, 7, 'bookclub', { action: 'comment', chapter_id: chapterId, content: 'Nice.' });
  assert.equal(commented.result.structuredContent.success, true);
  const comments = await call(server, 8, 'bookclub', { action: 'comments', chapter_id: chapterId });
  assert.equal(comments.result.structuredContent.count, 1);
  // comment authorship is server-derived from AuthContext, never read from the request body.
  assert.equal(comments.result.structuredContent.comments[0].author_id, owner.actorId);
});

test('shelf has no write actions and bookclub gates its actions by scope', async () => {
  const server = new TavernStudyMcpServer(fixture(), companion);
  await initialize(server);
  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map((tool: any) => tool.name), ['bookclub']);
  const deniedShelf = await call(server, 3, 'shelf', {});
  assert.equal(deniedShelf.error.code, -32602);
  const deniedComment = await call(server, 4, 'bookclub', { action: 'comment', chapter_id: 'x', content: 'x' });
  assert.equal(deniedComment.error.code, -32602);
  const unknownTool = await call(server, 5, 'nonexistent', {});
  assert.equal(unknownTool.error.code, -32602);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('validates lifecycle, ids, and rejects unknown fields', async () => {
  const server = new TavernStudyMcpServer(fixture(), owner);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 100, method: 'tools/list' })).error.code, -32002);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: null as any, method: 'initialize' })).error.code, -32600);
  await initialize(server);
  const invalid = await call(server, 2, 'shelf', { action: 'get' });
  assert.equal(invalid.result.isError, true);
  const unknownField = await call(server, 3, 'shelf', { bogus: true } as any);
  assert.equal(unknownField.result.isError, true);
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 4, method: 'ping' })).result, {});
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'initialize' }), null);
});
