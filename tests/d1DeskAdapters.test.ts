import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { D1DeskStorage } from '../examples/cloudflare/adapters/d1DeskStorage.ts';
import { D1DeskTurnStorage } from '../examples/cloudflare/adapters/d1DeskTurnStorage.ts';
import { D1DeskAssetStorage } from '../examples/cloudflare/adapters/d1DeskAssetStorage.ts';
import { D1ReadingStorage } from '../examples/cloudflare/adapters/d1ReadingStorage.ts';

test('D1 desk adapters preserve atomic commits, conflicts, malformed JSON, and composite truncation', { timeout: 30_000 }, async () => {
  const wranglerConfigHome = resolve('.tmp-wrangler-test');
  await mkdir(wranglerConfigHome, { recursive: true });
  process.env.XDG_CONFIG_HOME = wranglerConfigHome;
  const { getPlatformProxy } = await import('wrangler');
  const platform = await getPlatformProxy<{ OC_DB: D1Database }>({ configPath: 'wrangler.test.toml', persist: false });
  try {
    const db = platform.env.OC_DB;
    await db.batch([
      db.prepare(`CREATE TABLE desk_windows (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', recipe_id TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', note_depth INTEGER NOT NULL DEFAULT 3, state_board TEXT NOT NULL DEFAULT '{}', timeline_state TEXT NOT NULL DEFAULT '{}', vars TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT)`),
      db.prepare(`CREATE TABLE desk_floors (id TEXT PRIMARY KEY, window_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL DEFAULT '', variants TEXT NOT NULL DEFAULT '[]', active_variant INTEGER NOT NULL DEFAULT 0, thinking TEXT, report TEXT, created_at TEXT NOT NULL)`),
      db.prepare(`CREATE INDEX desk_windows_project ON desk_windows(project)`),
      db.prepare(`CREATE INDEX desk_floors_window_created ON desk_floors(window_id, created_at)`),
      db.prepare(`CREATE TABLE desk_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL, raw_json TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', block_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`),
      db.prepare(`CREATE TABLE desk_blocks (id TEXT PRIMARY KEY, preset_id TEXT NOT NULL, identifier TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'system', content TEXT NOT NULL DEFAULT '', marker INTEGER NOT NULL DEFAULT 0, injection TEXT NOT NULL DEFAULT '{}', in_queue INTEGER NOT NULL DEFAULT 0, queue_pos INTEGER, enabled_default INTEGER NOT NULL DEFAULT 0, UNIQUE(preset_id, identifier))`),
      db.prepare(`CREATE TABLE desk_recipes (id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, preset_id TEXT NOT NULL, weight TEXT NOT NULL CHECK(weight IN ('light','heavy')), overrides TEXT NOT NULL DEFAULT '{}', regex_ids TEXT NOT NULL DEFAULT '[]', params TEXT NOT NULL DEFAULT '{}', light_system TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT)`),
      db.prepare(`CREATE TABLE desk_regex (id TEXT PRIMARY KEY, scope TEXT NOT NULL, preset_id TEXT, name TEXT NOT NULL DEFAULT '', find TEXT NOT NULL, replace TEXT NOT NULL DEFAULT '', flags TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL CHECK(direction IN ('up','down','both')), enabled INTEGER NOT NULL DEFAULT 1, meta TEXT NOT NULL DEFAULT '{}', sort_order INTEGER NOT NULL DEFAULT 0)`),
      db.prepare(`CREATE TABLE memories (id TEXT PRIMARY KEY, project TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, lore_keys TEXT NOT NULL DEFAULT '[]', lore_position TEXT NOT NULL DEFAULT 'before', is_char INTEGER NOT NULL DEFAULT 0, lore_constant INTEGER NOT NULL DEFAULT 0, trigger_mode TEXT NOT NULL DEFAULT 'scan', lore_enabled INTEGER NOT NULL DEFAULT 1, lore_fields TEXT NOT NULL DEFAULT '{}')`),
      db.prepare(`CREATE TABLE oc_chapters (id TEXT PRIMARY KEY, project TEXT NOT NULL, chapter_no TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
      db.prepare(`CREATE TABLE oc_comments (id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL, reply_to TEXT, author_id TEXT NOT NULL, author_type TEXT NOT NULL, display_name TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`),
    ]);
    const desk = new D1DeskStorage(db); const turns = new D1DeskTurnStorage(db);
    const t0 = '2026-01-01T00:00:00.000Z'; const t1 = '2026-01-01T00:00:01.000Z'; const t2 = '2026-01-01T00:00:02.000Z';
    const window = { id: 'w', project: 'P', title: 'W', recipeId: 'r', note: '', noteDepth: 3, stateBoard: {}, timelineState: {}, vars: {}, createdAt: t0, updatedAt: t0 };
    await desk.createWindow(window);
    const userFloor = { id: 'u', windowId: 'w', role: 'user' as const, content: 'go', variants: ['go'], activeVariant: 0, thinking: null, report: null, createdAt: t1 };
    await desk.createFloor(userFloor);
    const first = await turns.commitAssistantFloor('w', 'f', { content: 'v1', thinking: null, report: {}, stateBoard: { step: 1 }, committedAt: t2 });
    assert.equal(first?.content, 'v1'); assert.equal(first?.report?.commitToken === undefined, false);
    assert.equal(await turns.commitAssistantFloor('w', 'f', { content: 'duplicate', thinking: null, report: {}, stateBoard: { step: 99 }, committedAt: t2 }), null);
    assert.deepEqual((await desk.getWindow('w'))?.stateBoard, { step: 1 });

    await db.prepare(`UPDATE desk_floors SET thinking = 'concurrent' WHERE id = 'f'`).run();
    const conflict = await turns.rollAssistantFloor({ windowId: 'w', floorId: 'f', expected: first!, commit: { content: 'v2', thinking: null, report: {}, stateBoard: { step: 2 }, committedAt: 't2' } });
    assert.equal(conflict, null); assert.deepEqual((await desk.getWindow('w'))?.stateBoard, { step: 1 });

    await db.prepare(`UPDATE desk_floors SET variants = '{', report = '{' WHERE id = 'f'`).run();
    const repairedView = await desk.getFloor('f');
    const malformed = await turns.rollAssistantFloor({ windowId: 'w', floorId: 'f', expected: repairedView!, commit: { content: 'v3', thinking: null, report: {}, stateBoard: { step: 3 }, committedAt: 't3' } });
    assert.equal(malformed, null); assert.deepEqual((await desk.getWindow('w'))?.stateBoard, { step: 1 });

    await desk.createWindow({ ...window, id: 'w2' });
    await desk.createFloor({ id: 'a', windowId: 'w2', role: 'user', content: 'a', variants: ['a'], activeVariant: 0, thinking: null, report: null, createdAt: 'same' });
    await desk.createFloor({ id: 'b', windowId: 'w2', role: 'assistant', content: 'b', variants: ['b'], activeVariant: 0, thinking: null, report: null, createdAt: 'same' });
    assert.equal(await desk.truncateFloors('w2', 'a', false), 1);
    assert.deepEqual((await desk.listFloors('w2')).map((row) => row.id), ['a']);

    const timeline = await desk.updateTimelineState('w', t2, { segs: [{ text: 'summary', upto: 't0|u' }], cutoff: 't0|u', rev: 1 }, 't4');
    assert.equal((timeline?.timelineState as any).rev, 1);
    assert.equal(await desk.updateTimelineState('w', 't1', { rev: 2 }, 't5'), null);

    const assets = new D1DeskAssetStorage(db);
    await assets.importPack({ project: 'P', name: 'Light', recipe: { id: 'r', presetId: 'p', weight: 'light', overrides: {}, regexIds: ['rx'], lightSystem: 'Continue.' }, blocks: [{ identifier: 'main', name: 'Main', role: 'system', content: 'x', marker: false, queuePos: 0, enabledDefault: true }], regex: [{ id: 'rx', find: 'x', replace: 'y', flags: 'g', direction: 'up', meta: {} }] });
    assert.equal((await assets.getRecipe('r'))?.lightSystem, 'Continue.');
    assert.equal((await assets.listQueueBlocks('p')).length, 1);

    const reading = new D1ReadingStorage(db);
    await reading.createChapter({ id: 'ch', project: 'P', chapterNo: '1', title: 'One', content: 'Body', summary: '', status: 'draft', createdAt: 't0', updatedAt: 't0', publishedAt: null });
    assert.equal((await reading.publishChapter('ch', 't1'))?.status, 'published');
    assert.equal((await reading.getPublishedChapter('ch'))?.content, 'Body');
  } finally { await platform.dispose(); }
});
