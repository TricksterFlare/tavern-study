import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/adapters/memoryStorage.ts';
import { DeskService } from '../src/core/deskService.ts';

test('runs desk window and floor flow without Cloudflare', async () => {
  const storage = createMemoryStorage(); const service = new DeskService(storage.desk);
  const made: any = await service.createWindow({ project: 'P', title: 'Window', recipeId: 'recipe' });
  const user: any = await service.appendFloor(made.window.id, { role: 'user', content: 'guide' });
  const ai: any = await service.appendFloor(made.window.id, { role: 'assistant', content: 'v1', variants: ['v1', 'v2'] });
  await service.switchVariant(ai.floor.id, 1);
  let view: any = await service.getWindow(made.window.id);
  let aiFloor = view.floors.find((floor: any) => floor.id === ai.floor.id);
  assert.equal(aiFloor.content, 'v2');
  assert.equal(aiFloor.variants[aiFloor.activeVariant], 'v2');
  await service.editFloor(ai.floor.id, 'edited');
  view = await service.getWindow(made.window.id);
  aiFloor = view.floors.find((floor: any) => floor.id === ai.floor.id);
  assert.equal(aiFloor.variants[1], 'edited');
  assert.equal((await service.truncate(made.window.id, view.floors[0].id)).deleted, 1);
});

test('orders same-time floors by id and supports inclusive truncate', async () => {
  const storage = createMemoryStorage({ deskWindows: [{ id: 'w', project: 'P', title: 'W', recipeId: 'r', note: '', noteDepth: 3, stateBoard: {}, timelineState: {}, vars: {}, createdAt: 't', updatedAt: 't' }], deskFloors: [
    { id: 'b', windowId: 'w', role: 'assistant', content: 'b', variants: ['b'], activeVariant: 0, thinking: null, report: null, createdAt: 't' },
    { id: 'a', windowId: 'w', role: 'user', content: 'a', variants: ['a'], activeVariant: 0, thinking: null, report: null, createdAt: 't' },
  ] });
  const service = new DeskService(storage.desk); const view: any = await service.getWindow('w');
  assert.deepEqual(view.floors.map((f: any) => f.id), ['a', 'b']);
  assert.equal((await service.truncate('w', 'a', true)).deleted, 2);
});

test('preserves emoji while scrubbing lone surrogate code units', async () => {
  const storage = createMemoryStorage(); const service = new DeskService(storage.desk);
  const made: any = await service.createWindow({ project: 'P', title: 'W', recipeId: 'r' });
  const result: any = await service.appendFloor(made.window.id, { role: 'user', content: `🐾${String.fromCharCode(0xD800)}x` });
  assert.equal(result.floor.content, '🐾�x');
});

test('atomically commits normal and roll turns through the turn storage contract', async () => {
  const storage = createMemoryStorage({ deskWindows: [{ id: 'w', project: 'P', title: 'W', recipeId: 'r', note: '', noteDepth: 3, stateBoard: {}, timelineState: {}, vars: {}, createdAt: 't0', updatedAt: 't0' }] });
  const expectedUser = { id: 'u', windowId: 'w', role: 'user' as const, content: 'go', variants: ['go'], activeVariant: 0, thinking: null, report: null, createdAt: 't0' };
  await storage.desk.createFloor(expectedUser);
  const base = { content: 'v1', thinking: null, report: { commitToken: 'c1' }, stateBoard: { place: 'one' }, committedAt: 't1' };
  const made = await storage.deskTurn.commitAssistantFloor('w', 'f', base);
  assert.equal(made?.content, 'v1');
  assert.deepEqual((await storage.desk.getWindow('w'))?.stateBoard, { place: 'one' });
  const stale = { ...made!, content: 'stale' };
  assert.equal(await storage.deskTurn.rollAssistantFloor({ windowId: 'w', floorId: 'f', expected: stale, commit: { ...base, content: 'bad', committedAt: 't2' } }), null);
  const rolled = await storage.deskTurn.rollAssistantFloor({ windowId: 'w', floorId: 'f', expected: made!, commit: { content: 'v2', thinking: 'thought', report: { commitToken: 'c2' }, stateBoard: { place: 'two' }, committedAt: 't2' } });
  assert.equal(rolled?.content, 'v2');
  assert.deepEqual(rolled?.variants, ['v1', 'v2']);
  assert.deepEqual((await storage.desk.getWindow('w'))?.stateBoard, { place: 'two' });
});
