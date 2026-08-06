import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeModelBackend } from '../src/adapters/fakeModelBackend.ts';
import { createMemoryStorage } from '../src/adapters/memoryStorage.ts';
import { DeskGenerationService } from '../src/core/deskGenerationService.ts';

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const windowSeed = { id: 'w', project: 'P', title: 'W', recipeId: 'r', note: '', noteDepth: 3, stateBoard: {}, timelineState: {}, vars: {}, createdAt: 't0', updatedAt: 't0' };
const userSeed = { id: 'u', windowId: 'w', role: 'user' as const, content: 'go', variants: ['go'], activeVariant: 0, thinking: null, report: null, createdAt: 't0' };
async function seededStorage() { const storage = createMemoryStorage({ deskWindows: [windowSeed] }); await storage.desk.createFloor(userSeed); return storage; }

test('commits only a clean model result and streams progress events', async () => {
  const storage = await seededStorage(); const seen: string[] = [];
  const backend = new FakeModelBackend({ ok: true, terminal: 'clean', text: '<content>\nstory\n</content>\n```stateboard\n{"place":"new"}\n```', thinking: ' thought ', usage }, [{ type: 'text', text: 'story' }]);
  const service = new DeskGenerationService(backend, storage.deskTurn);
  const result = await service.generate({ windowId: 'w', mode: 'normal', floorId: 'f', userFloor: userSeed, system: [], prompt: 'go', model: 'fake', report: {}, stateBoard: { place: 'old' }, boardBeforeTrusted: true, committedAt: 't1', onEvent: (event) => { seen.push(event.type); } });
  assert.equal(result.success, true); assert.equal((await storage.desk.getFloor('f'))?.content, 'story');
  assert.deepEqual((await storage.desk.getWindow('w'))?.stateBoard, { place: 'new' }); assert.deepEqual((await storage.desk.getFloor('f'))?.report?.boardBefore, { place: 'old' }); assert.deepEqual(seen, ['text']);
});

test('does not write partial text when the backend lacks a clean terminal result', async () => {
  const storage = await seededStorage();
  const service = new DeskGenerationService(new FakeModelBackend({ ok: false, kind: 'protocol', detail: 'EOF', usage }), storage.deskTurn);
  const result = await service.generate({ windowId: 'w', mode: 'normal', floorId: 'f', userFloor: userSeed, system: [], prompt: 'go', model: 'fake', report: {}, stateBoard: {}, boardBeforeTrusted: true, committedAt: 't1' });
  assert.equal(result.success, false); assert.equal(await storage.desk.getFloor('f'), null);
});

test('rejects empty final content and an aborted request before commit', async () => {
  const storage = await seededStorage();
  const empty = new DeskGenerationService(new FakeModelBackend({ ok: true, terminal: 'clean', text: '<content>\n</content>', thinking: '', usage }), storage.deskTurn);
  const common = { windowId: 'w', mode: 'normal' as const, floorId: 'f', userFloor: userSeed, system: [], prompt: 'go', model: 'fake', report: {}, stateBoard: {}, boardBeforeTrusted: true, committedAt: 't1' };
  assert.equal((await empty.generate(common)).success, false);
  const controller = new AbortController(); controller.abort();
  assert.equal((await empty.generate({ ...common, signal: controller.signal })).error, 'aborted');
  assert.equal(await storage.desk.getFloor('f'), null);
});

test('does not let an untrusted roll smuggle board snapshots through report fields', async () => {
  const oldFloor = { id: 'f', windowId: 'w', role: 'assistant' as const, content: 'v1', variants: ['v1'], activeVariant: 0, thinking: null, report: {}, createdAt: 't0' };
  const storage = createMemoryStorage({ deskWindows: [windowSeed], deskFloors: [oldFloor] });
  const service = new DeskGenerationService(new FakeModelBackend({ ok: true, terminal: 'clean', text: 'v2', thinking: '', usage }), storage.deskTurn);
  const result = await service.generate({ windowId: 'w', mode: 'roll', floorId: 'f', expectedFloor: oldFloor,
    system: [], prompt: 'go', model: 'fake', report: { boardBefore: { forged: true }, boardAfter: { forged: true }, stateBoardStale: false, commitToken: 'forged' },
    stateBoard: { fallback: true }, boardBeforeTrusted: false, committedAt: 't1' });
  assert.equal(result.success, true);
  const report = (await storage.desk.getFloor('f'))?.report || {};
  assert.equal(Object.hasOwn(report, 'boardBefore'), false); assert.deepEqual(report.boardAfter, { fallback: true });
  assert.notEqual(report.commitToken, 'forged');
});
