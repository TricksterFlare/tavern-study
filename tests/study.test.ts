// tests/study.test.ts
// 书架 REST 数据层(src/tools/study.ts)带上触发配置(keys/position/is_char/constant/
// trigger_mode/fields)之后的落库校验——这几个字段本来只有世界书浮窗(desk/lore PUT)能改,
// 现在书架的新建/编辑表单也能配,create/update 得把它们跟 title/content 落进同一条 UPDATE/INSERT。
// 用真 D1(miniflare 本地,不落盘)起一张跟 examples/cloudflare/schema/init.sql 同形状的 memories 表,
// 手法照抄 tests/d1DeskAdapters.test.ts(同一套 getPlatformProxy 起 D1 的家法)。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { studyCreate, studyUpdate, studyGet } from '../src/tools/study.ts';

test('study REST carries trigger fields atomically and rejects out-of-range values', { timeout: 30_000 }, async () => {
  const wranglerConfigHome = resolve('.tmp-wrangler-study-test');
  await mkdir(wranglerConfigHome, { recursive: true });
  process.env.XDG_CONFIG_HOME = wranglerConfigHome;
  const { getPlatformProxy } = await import('wrangler');
  const platform = await getPlatformProxy<{ OC_DB: D1Database }>({ configPath: 'wrangler.test.toml', persist: false });
  try {
    const db = platform.env.OC_DB;
    // 跟 examples/cloudflare/schema/init.sql 的 memories 表同形状(含 lore_* 六列的 DEFAULT)。
    await db.prepare(
      `CREATE TABLE memories (
        id TEXT PRIMARY KEY, project TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL CHECK(category IN ('world','plot','outline','session')),
        title TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', chapter TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '', lore_keys TEXT NOT NULL DEFAULT '[]',
        lore_position TEXT NOT NULL DEFAULT 'before', is_char INTEGER NOT NULL DEFAULT 0 CHECK(is_char IN (0,1)),
        lore_constant INTEGER NOT NULL DEFAULT 0 CHECK(lore_constant IN (0,1)),
        trigger_mode TEXT NOT NULL DEFAULT 'scan' CHECK(trigger_mode IN ('scan','presence')),
        lore_enabled INTEGER NOT NULL DEFAULT 1 CHECK(lore_enabled IN (0,1)),
        lore_fields TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT)`,
    ).run();
    // OC_VECTORIZE/AI 没接:embedMemory 会在 create/update 里各自 try/catch 掉,vector_ok 落 false,
    // D1 落地这条主线不受影响——这份测试不管语义搜索这一半。
    const env = { OC_DB: db } as any;

    // ① 带字段创建 → 读回一致
    const created = await studyCreate(env, {
      project: 'P', category: 'world', title: '裴瑾', content: '他是……',
      keys: ['裴瑾', '瑾'], position: 'char', is_char: true, constant: false,
      trigger_mode: 'presence', fields: { description: 'desc', personality: 'kind' },
    });
    assert.equal(created.success, true);
    assert.deepEqual(created.keys, ['裴瑾', '瑾']);
    assert.equal(created.position, 'char');
    assert.equal(created.is_char, true);
    assert.equal(created.trigger_mode, 'presence');
    assert.deepEqual(created.fields, { description: 'desc', personality: 'kind' });

    const fetched = await studyGet(env, created.id);
    assert.equal(fetched.success, true);
    assert.deepEqual(fetched.keys, ['裴瑾', '瑾']);
    assert.equal(fetched.position, 'char');
    assert.equal(fetched.is_char, true);
    assert.equal(fetched.constant, false);
    assert.equal(fetched.trigger_mode, 'presence');
    assert.deepEqual(fetched.fields, { description: 'desc', personality: 'kind' });

    // 不带触发字段创建的一条——落库必须是库默认值(跟这功能之前的行为完全一样)。
    const plain = await studyCreate(env, { project: 'P', category: 'plot', title: '无触发', content: 'x' });
    assert.equal(plain.success, true);
    const plainFetched = await studyGet(env, plain.id);
    assert.deepEqual(plainFetched.keys, []);
    assert.equal(plainFetched.position, 'before');
    assert.equal(plainFetched.is_char, false);
    assert.equal(plainFetched.trigger_mode, 'scan');
    assert.deepEqual(plainFetched.fields, {});

    // ② 防回归重点:更新只带 content,不带任何触发字段——触发配置不许被清掉。
    const updated = await studyUpdate(env, created.id, { content: '他后来……' });
    assert.equal(updated.success, true);
    const afterContentOnlyUpdate = await studyGet(env, created.id);
    assert.equal(afterContentOnlyUpdate.content, '他后来……');
    assert.deepEqual(afterContentOnlyUpdate.keys, ['裴瑾', '瑾']); // 没被清空
    assert.equal(afterContentOnlyUpdate.position, 'char');
    assert.equal(afterContentOnlyUpdate.is_char, true);
    assert.equal(afterContentOnlyUpdate.trigger_mode, 'presence');
    assert.deepEqual(afterContentOnlyUpdate.fields, { description: 'desc', personality: 'kind' });

    // 单独改 keys——其余触发字段(position/is_char/trigger_mode/fields)照样原样留着。
    const keysOnlyUpdate = await studyUpdate(env, created.id, { keys: ['裴瑾'] });
    assert.equal(keysOnlyUpdate.success, true);
    const afterKeysOnlyUpdate = await studyGet(env, created.id);
    assert.deepEqual(afterKeysOnlyUpdate.keys, ['裴瑾']);
    assert.equal(afterKeysOnlyUpdate.position, 'char');
    assert.equal(afterKeysOnlyUpdate.is_char, true);

    // ③ 非法值一律拒绝,D1 不许被写歪
    assert.equal((await studyUpdate(env, created.id, { position: 'sideways' })).success, false);
    assert.equal((await studyUpdate(env, created.id, { trigger_mode: 'always' })).success, false);
    assert.equal((await studyUpdate(env, created.id, { is_char: 'true' as any })).success, false);
    assert.equal((await studyUpdate(env, created.id, { constant: 1 as any })).success, false);
    assert.equal((await studyUpdate(env, created.id, { keys: ['ok', 2 as any] })).success, false);
    assert.equal((await studyUpdate(env, created.id, { fields: { not_a_real_field: 'x' } as any })).success, false);
    assert.equal(
      (await studyCreate(env, { project: 'P', category: 'world', title: 'bad', position: 'sideways' })).success,
      false,
    );
    // 拒绝之后原值必须纹丝不动——校验必须在任何 UPDATE 落库之前挡住,不能"先写坏值再报错"。
    const afterRejectedUpdates = await studyGet(env, created.id);
    assert.deepEqual(afterRejectedUpdates.keys, ['裴瑾']);
    assert.equal(afterRejectedUpdates.position, 'char');
    assert.equal(afterRejectedUpdates.is_char, true);
    assert.equal(afterRejectedUpdates.trigger_mode, 'presence');
  } finally {
    await platform.dispose();
  }
});
