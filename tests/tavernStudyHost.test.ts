import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/adapters/memoryStorage.ts';
import { FakeModelBackend } from '../src/adapters/fakeModelBackend.ts';
import { TavernStudyHost } from '../src/core/tavernStudyHost.ts';
import { TavernStudyMcpServer } from '../src/mcp/server.ts';
import type { AuthContext } from '../src/auth.ts';
import type { ModelBackend, StreamChatArgs } from '../src/core/modelBackend.ts';

test('runs the core study, reading, and generated desk turn in a memory-only host', async () => {
  const storage = createMemoryStorage({
    deskRecipes: [{ id: 'light', presetId: 'unused', weight: 'light', overrides: {}, regexIds: [], lightSystem: 'Write the next scene.' }],
    deskPresetIds: ['unused'],
    chapters: [{ id: 'chapter-1', project: 'demo', chapterNo: '1', title: 'Arrival', content: 'The door opened.', summary: '', status: 'published', createdAt: '2026-01-01', updatedAt: null, publishedAt: '2026-01-01' }],
  });
  const model = new FakeModelBackend({
    ok: true, terminal: 'clean', text: 'A warm room answered.\n```stateboard\n{"place":"study"}\n```', thinking: '',
    usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0 },
  });
  const host = new TavernStudyHost({ storage, model, defaultModel: 'fixture' });

  const study = await host.study.create({ project: 'demo', category: 'world', title: 'Key', content: 'Brass.' });
  assert.equal(study.success, true);
  const windowResult = await host.desk.createWindow({ project: 'demo', title: 'Desk', recipeId: 'light' });
  assert.equal(windowResult.success, true);
  if (!windowResult.success) return;
  const generated = await host.generateDeskTurn({ windowId: windowResult.window.id, content: 'I enter.' });
  assert.equal(generated.success, true);
  const desk = await host.desk.getWindow(windowResult.window.id);
  assert.deepEqual(desk.success && desk.floors.map((floor) => floor.role), ['user', 'assistant']);
  assert.deepEqual(desk.success && desk.window.stateBoard, { place: 'study' });
  assert.equal(model.calls[0].model, 'fixture');

  const published = await host.reading.readPublished('chapter-1');
  assert.equal(published.success, true);
  const comment = await host.reading.createComment({ chapterId: 'chapter-1', content: 'I saw it.', author: { id: 'reader', type: 'ai', displayName: 'Reader' } });
  assert.equal(comment.success, true);
  assert.equal((await host.reading.listComments('chapter-1')).count, 1);
});

test('serializes same-window turns and includes the current input only once', async () => {
  const storage = createMemoryStorage({ deskRecipes: [{ id: 'r', presetId: 'p', weight: 'light', overrides: {}, regexIds: [], lightSystem: 'Continue.' }], deskPresetIds: ['p'] });
  const prompts: string[] = [];
  const model: ModelBackend = { async streamChat(args: StreamChatArgs) {
    prompts.push(args.prompt);
    const current = args.prompt.endsWith('TWO') ? 'two' : 'one';
    if (current === 'one') await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, terminal: 'clean', text: `${current}\n\`\`\`stateboard\n{"last":"${current}"}\n\`\`\``, thinking: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  } };
  const host = new TavernStudyHost({ storage, model });
  const made = await host.desk.createWindow({ project: 'p', title: 'w', recipeId: 'r' });
  if (!made.success) return;
  const [one, two] = await Promise.all([
    host.generateDeskTurn({ windowId: made.window.id, content: 'UNIQUE_ONE', requestId: '1' }),
    host.generateDeskTurn({ windowId: made.window.id, content: 'TWO', requestId: '2' }),
  ]);
  assert.equal(one.success && two.success, true);
  assert.equal(prompts[0].split('UNIQUE_ONE').length - 1, 1);
  const final = await host.desk.getWindow(made.window.id);
  assert.deepEqual(final.success && final.window.stateBoard, { last: 'two' });
  assert.deepEqual(final.success && final.floors.map((floor) => floor.content), ['UNIQUE_ONE', 'one', 'TWO', 'two']);
});

test('does not append on assembly failure and deduplicates a failed model request with a safe receipt', async () => {
  const storage = createMemoryStorage();
  const model = new FakeModelBackend({ ok: false, kind: 'fetch', detail: 'private endpoint detail' });
  const host = new TavernStudyHost({ storage, model });
  const made = await host.desk.createWindow({ project: 'p', title: 'w', recipeId: 'missing' });
  if (!made.success) return;
  assert.equal((await host.generateDeskTurn({ windowId: made.window.id, content: 'x' })).success, false);
  assert.equal((await host.desk.getWindow(made.window.id)).floors.length, 0);

  const seeded = createMemoryStorage({ deskRecipes: [{ id: 'r', presetId: 'p', weight: 'light', overrides: {}, regexIds: [], lightSystem: 'Continue.' }], deskPresetIds: ['p'] });
  const failedHost = new TavernStudyHost({ storage: seeded, model });
  const valid = await failedHost.desk.createWindow({ project: 'p', title: 'w', recipeId: 'r' });
  if (!valid.success) return;
  const first = await failedHost.generateDeskTurn({ windowId: valid.window.id, content: 'x', requestId: 'same' });
  const retry = await failedHost.generateDeskTurn({ windowId: valid.window.id, content: 'x', requestId: 'same' });
  assert.deepEqual(retry, first);
  assert.equal('detail' in first, false);
  assert.equal((await failedHost.desk.getWindow(valid.window.id)).floors.length, 1);
  const mismatch = await failedHost.generateDeskTurn({ windowId: valid.window.id, content: 'different', requestId: 'same' });
  assert.equal(mismatch.error, 'idempotency_conflict');
});

test('timeline folding replaces cutoff floors with its summary in the next prompt', async () => {
  const storage = createMemoryStorage({ deskRecipes: [{ id: 'r', presetId: 'p', weight: 'light', overrides: {}, regexIds: [], lightSystem: 'Continue.' }], deskPresetIds: ['p'] });
  const calls: string[] = []; const model: ModelBackend = { async streamChat(args) { calls.push(args.prompt); return { ok: true, terminal: 'clean', text: args.system[0]?.text.startsWith('Summarize') ? 'SUMMARY' : 'answer', thinking: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }; } };
  const host = new TavernStudyHost({ storage, model }); const made = await host.desk.createWindow({ project: 'p', title: 'w', recipeId: 'r' }); if (!made.success) return;
  // Auto-fold only kicks in once the un-folded tail exceeds the production trigger (20 floors);
  // below that a fold attempt is a no-op, matching production's "not enough yet" behavior.
  for (let index = 0; index < 4; index++) await host.generateDeskTurn({ windowId: made.window.id, content: index === 0 ? 'OLDEST_UNIQUE' : `turn-${index}` });
  assert.equal((await host.foldDeskTimeline({ windowId: made.window.id })).acted, false);
  for (let index = 4; index < 12; index++) await host.generateDeskTurn({ windowId: made.window.id, content: `turn-${index}` });
  assert.equal((await host.foldDeskTimeline({ windowId: made.window.id })).acted, true);
  await host.generateDeskTurn({ windowId: made.window.id, content: 'after-fold' });
  const prompt = calls.at(-1)!; assert.match(prompt, /SUMMARY/); assert.doesNotMatch(prompt, /OLDEST_UNIQUE/);
});

test('foldDeskTimeline can be forced below the trigger and respects a custom keep', async () => {
  const storage = createMemoryStorage({ deskRecipes: [{ id: 'r', presetId: 'p', weight: 'light', overrides: {}, regexIds: [], lightSystem: 'Continue.' }], deskPresetIds: ['p'] });
  const model: ModelBackend = { async streamChat(args) { return { ok: true, terminal: 'clean', text: args.system[0]?.text.startsWith('Summarize') ? 'SUMMARY' : 'answer', thinking: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }; } };
  const host = new TavernStudyHost({ storage, model }); const made = await host.desk.createWindow({ project: 'p', title: 'w', recipeId: 'r' }); if (!made.success) return;
  for (let index = 0; index < 4; index++) await host.generateDeskTurn({ windowId: made.window.id, content: `turn-${index}` });
  const untouched = await host.foldDeskTimeline({ windowId: made.window.id, keep: 20 });
  assert.equal(untouched.acted, false);
  const forced = await host.foldDeskTimeline({ windowId: made.window.id, force: true, keep: 2 });
  assert.equal(forced.acted, true);
  assert.equal((forced as any).folded, 6);
});

test('refreshDeskBoard returns a draft without persisting and rejects a non-assistant last floor', async () => {
  const storage = createMemoryStorage({ deskRecipes: [{ id: 'r', presetId: 'p', weight: 'light', overrides: {}, regexIds: [], lightSystem: 'Continue.' }], deskPresetIds: ['p'] });
  const model: ModelBackend = { async streamChat(args) { if (args.system[0]?.text.includes('state board')) return { ok: true, terminal: 'clean', text: '```stateboard\n{"place":"garden"}\n```', thinking: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }; return { ok: true, terminal: 'clean', text: 'reply\n```stateboard\n{"place":"study"}\n```', thinking: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }; } };
  const host = new TavernStudyHost({ storage, model }); const made = await host.desk.createWindow({ project: 'p', title: 'w', recipeId: 'r' }); if (!made.success) return;
  await host.generateDeskTurn({ windowId: made.window.id, content: 'hello' });
  const refreshed = await host.refreshDeskBoard({ windowId: made.window.id });
  assert.equal(refreshed.success, true);
  assert.deepEqual((refreshed as any).board, { place: 'garden' });
  // Draft only: the window's own board is untouched until the caller explicitly saves it.
  const stillOriginal = await host.desk.getWindow(made.window.id);
  assert.deepEqual(stillOriginal.success && stillOriginal.window.stateBoard, { place: 'study' });
});

test('refreshDeskBoard rejects a window whose last floor has not been answered yet', async () => {
  const storage = createMemoryStorage({ deskWindows: [{ id: 'w1', project: 'p', title: 'w', recipeId: 'r', note: '', noteDepth: 3, stateBoard: { place: 'study' }, timelineState: {}, vars: {}, createdAt: 't0', updatedAt: 't0' }], deskFloors: [{ id: 'f1', windowId: 'w1', role: 'user', content: 'just asked', variants: ['just asked'], activeVariant: 0, thinking: null, report: null, createdAt: 't1' }] });
  const model: ModelBackend = { async streamChat() { throw new Error('must not be called'); } };
  const host = new TavernStudyHost({ storage, model });
  const refreshed = await host.refreshDeskBoard({ windowId: 'w1' });
  assert.equal(refreshed.success, false);
});

test('roll regenerates the last assistant floor as a new variant using its original board snapshot', async () => {
  const storage = createMemoryStorage({ deskRecipes: [{ id: 'r', presetId: 'p', weight: 'light', overrides: {}, regexIds: [], lightSystem: 'Continue.' }], deskPresetIds: ['p'] });
  let call = 0;
  const model: ModelBackend = { async streamChat(args) {
    call++;
    if (call === 1) return { ok: true, terminal: 'clean', text: 'first reply\n```stateboard\n{"place":"garden"}\n```', thinking: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    return { ok: true, terminal: 'clean', text: `rerolled saw: ${args.prompt.includes('hello') ? 'hello' : 'missing'}\n\`\`\`stateboard\n{"place":"rerolled"}\n\`\`\``, thinking: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  } };
  const host = new TavernStudyHost({ storage, model });
  const made = await host.desk.createWindow({ project: 'p', title: 'w', recipeId: 'r' });
  if (!made.success) return;
  // Reject a roll before there is anything to reroll.
  const tooEarly = await host.generateDeskTurn({ windowId: made.window.id, roll: true });
  assert.equal(tooEarly.success, false);

  const first = await host.generateDeskTurn({ windowId: made.window.id, content: 'hello' });
  assert.equal(first.success, true);
  const beforeRoll = await host.desk.getWindow(made.window.id);
  assert.equal(beforeRoll.success && beforeRoll.floors.length, 2);
  assert.deepEqual(beforeRoll.success && beforeRoll.window.stateBoard, { place: 'garden' });

  const rolled = await host.generateDeskTurn({ windowId: made.window.id, roll: true });
  assert.equal(rolled.success, true);
  const afterRoll = await host.desk.getWindow(made.window.id);
  // Roll must not create a new floor — it appends a variant to the same assistant floor.
  assert.equal(afterRoll.success && afterRoll.floors.length, 2);
  const assistantFloor = afterRoll.success ? afterRoll.floors[1] : null;
  assert.equal(assistantFloor?.variants.length, 2);
  assert.equal(assistantFloor?.activeVariant, 1);
  assert.match(assistantFloor?.content || '', /rerolled saw: hello/);
  assert.deepEqual(afterRoll.success && afterRoll.window.stateBoard, { place: 'rerolled' });
});

test('full desk lifecycle in the memory host: import, generate, roll, switch, edit, truncate, fold, refresh, publish, and read back through MCP', async () => {
  const storage = createMemoryStorage();
  const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const model: ModelBackend = { async streamChat(args) {
    const system = args.system[0]?.text || '';
    if (system.startsWith('Summarize')) return { ok: true, terminal: 'clean', text: 'Everything up to now, tidied into one paragraph.', thinking: '', usage: ZERO_USAGE };
    if (system.includes('state board')) return { ok: true, terminal: 'clean', text: '```stateboard\n{"place":"refreshed"}\n```', thinking: '', usage: ZERO_USAGE };
    const tail = args.prompt.length > 40 ? args.prompt.slice(-40) : args.prompt;
    return { ok: true, terminal: 'clean', text: `reply to: ${tail}\n\`\`\`stateboard\n{"place":"scene"}\n\`\`\``, thinking: '', usage: ZERO_USAGE };
  } };
  const host = new TavernStudyHost({ storage, model });

  // 1) import a desk asset pack (fresh recipe, no pre-seeded fixture).
  const imported = await host.importDeskAssetPack({
    project: 'novella', name: 'Starter pack',
    recipe: { id: 'recipe-1', presetId: 'preset-1', weight: 'light', overrides: {}, regexIds: [], lightSystem: 'Continue the scene faithfully.' },
    blocks: [], regex: [],
  });
  assert.equal(imported.success, true);

  // 2) build a writing window on the imported recipe.
  const made = await host.desk.createWindow({ project: 'novella', title: 'Chapter draft', recipeId: 'recipe-1' });
  assert.equal(made.success, true);
  if (!made.success) return;
  const windowId = made.window.id;

  // 3) generate: two normal turns.
  const turn1 = await host.generateDeskTurn({ windowId, content: 'The door creaked open.' });
  assert.equal(turn1.success, true);
  const turn2 = await host.generateDeskTurn({ windowId, content: 'Someone stepped inside.' });
  assert.equal(turn2.success, true);
  const afterTwoTurns = await host.desk.getWindow(windowId);
  assert.equal(afterTwoTurns.success && afterTwoTurns.floors.length, 4);
  const secondAssistantFloor = afterTwoTurns.success ? afterTwoTurns.floors[3] : null;
  assert.equal(secondAssistantFloor?.role, 'assistant');

  // 4) roll: regenerate the last assistant floor as a new candidate variant.
  const rolled = await host.generateDeskTurn({ windowId, roll: true });
  assert.equal(rolled.success, true);
  const afterRoll = await host.desk.getWindow(windowId);
  assert.equal(afterRoll.success && afterRoll.floors.length, 4); // roll never adds a floor
  const rolledFloor = afterRoll.success ? afterRoll.floors[3] : null;
  assert.equal(rolledFloor?.variants.length, 2);
  assert.equal(rolledFloor?.activeVariant, 1);

  // 5) switch back to the original candidate.
  const switched = await host.desk.switchVariant(rolledFloor!.id, 0);
  assert.equal(switched.success, true);
  assert.equal(switched.success && switched.floor.activeVariant, 0);

  // 6) floor edit: hand-fix the opening line in place.
  const firstUserFloor = afterTwoTurns.success ? afterTwoTurns.floors[0] : null;
  const edited = await host.desk.editFloor(firstUserFloor!.id, 'The heavy door creaked open at last.');
  assert.equal(edited.success, true);
  assert.equal(edited.success && edited.floor.content, 'The heavy door creaked open at last.');

  // 7) one more turn, then truncate it back off — a common "discard this reply" flow that must
  // not disturb the earlier floors (edit/roll/switch all survive it).
  const turn3 = await host.generateDeskTurn({ windowId, content: 'A third voice answered.' });
  assert.equal(turn3.success, true);
  const beforeTruncate = await host.desk.getWindow(windowId);
  assert.equal(beforeTruncate.success && beforeTruncate.floors.length, 6);
  const thirdUserFloor = beforeTruncate.success ? beforeTruncate.floors[4] : null;
  const truncated = await host.desk.truncate(windowId, thirdUserFloor!.id, true);
  assert.equal(truncated.success, true);
  assert.equal(truncated.success && truncated.deleted, 2);
  const afterTruncate = await host.desk.getWindow(windowId);
  assert.equal(afterTruncate.success && afterTruncate.floors.length, 4);
  assert.equal(afterTruncate.success && afterTruncate.floors[0].content, 'The heavy door creaked open at last.');

  // 8) fold the timeline (forced, since four floors are well under the automatic trigger).
  const folded = await host.foldDeskTimeline({ windowId, force: true, keep: 0 });
  assert.equal(folded.acted, true);
  assert.equal((folded as any).folded, 4);
  const afterFold = await host.desk.getWindow(windowId);
  assert.equal(afterFold.success && (afterFold.window.timelineState as any).segs.length, 1);

  // 9) manual state-board refresh: recomputed from the current last floor, returned as a draft
  // (the window's own board is untouched until the caller saves it — see refreshDeskBoard).
  const refreshed = await host.refreshDeskBoard({ windowId });
  assert.equal(refreshed.success, true);
  assert.deepEqual((refreshed as any).board, { place: 'refreshed' });
  const stillUnsaved = await host.desk.getWindow(windowId);
  assert.deepEqual(stillUnsaved.success && stillUnsaved.window.stateBoard, { place: 'scene' });

  // 10) publish a chapter and add a study (shelf) entry for the read-back leg below.
  const draft = await host.reading.createDraft({ project: 'novella', chapterNo: '1', title: 'The Door', content: 'The heavy door creaked open at last.' });
  assert.equal(draft.success, true);
  const chapterId = draft.success ? draft.chapter.id : '';
  const published = await host.reading.publish(chapterId);
  assert.equal(published.success, true);
  const shelfEntry = await host.study.create({ project: 'novella', category: 'world', title: 'The house', content: 'An old house with a heavy door.' });
  assert.equal(shelfEntry.success, true);

  // 11) read it all back the way an outside caller would: through the MCP shelf/bookclub tools,
  // ending with a posted comment.
  const owner: AuthContext = { actorId: 'owner', actorType: 'owner', displayName: 'Owner', scopes: new Set(['study:read', 'published:read', 'comments:read', 'comments:write']) };
  const mcp = new TavernStudyMcpServer(host, owner);
  await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  const shelfList = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shelf', arguments: { project: 'novella' } } });
  assert.equal(shelfList.result.structuredContent.count, 1);
  const bookclubChapters = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bookclub', arguments: { project: 'novella' } } });
  assert.equal(bookclubChapters.result.structuredContent.count, 1);
  const bookclubRead = await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bookclub', arguments: { action: 'read', id: chapterId } } });
  assert.equal(bookclubRead.result.structuredContent.content, 'The heavy door creaked open at last.');
  const commented = await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bookclub', arguments: { action: 'comment', chapter_id: chapterId, content: 'Great opening line.' } } });
  assert.equal(commented.result.structuredContent.success, true);
  const comments = await mcp.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'bookclub', arguments: { action: 'comments', chapter_id: chapterId } } });
  assert.equal(comments.result.structuredContent.count, 1);
  assert.equal(comments.result.structuredContent.comments[0].content, 'Great opening line.');
});
