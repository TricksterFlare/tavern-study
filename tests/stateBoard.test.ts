import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStateBoard, stateBoardGateErrors } from '../src/core/stateBoard.ts';

test('accepts a correctly closed stateboard', () => {
  const result = parseStateBoard('Story\n```stateboard\n{"time":"night"}\n```');
  assert.equal(result.content, 'Story');
  assert.deepEqual(result.board, { time: 'night' });
});

test('replays the real tagged closing-fence failure shape', () => {
  const result = parseStateBoard('Story\n```stateboard\n{"time":"戌时四刻","place":"study"}\n```stateboard');
  assert.equal(result.content, 'Story');
  assert.deepEqual(result.board, { time: '戌时四刻', place: 'study' });
});

test('does not consume ordinary prose after a valid fence', () => {
  const input = 'Story\n```stateboard\n{"time":"night"}\n```stateboard is a plain trailing word';
  assert.deepEqual(parseStateBoard(input), {
    content: 'Story\n```stateboard\n{"time":"night"}',
    board: null,
  });
});

test('does not let a truncated second opening fence escape', () => {
  const input = 'Story\n```stateboard\n{"time":"night"}\n```\n```stateboard';
  assert.deepEqual(parseStateBoard(input), { content: 'Story\n```stateboard\n{"time":"night"}\n```', board: null });
});

test('strips a truncated stateboard payload from reader content', () => {
  assert.deepEqual(parseStateBoard('Story\n```stateboard\n{"time":'), { content: 'Story', board: null });
});

// ===== stateBoardGateErrors: write-path protocol gate =====

const GOOD = {
  在场角色: ['寻', '露'],
  衣装: { 寻: '白衬衫', 露: '长裙' },
  位置: '书房',
  关系: { '寻↔露': '互相试探' },
  时间地点: '傍晚·宅邸',
};

test('gate passes a well-shaped board', () => {
  assert.deepEqual(stateBoardGateErrors(GOOD, GOOD), []);
});

test('gate passes a bootstrap board on an empty baseline', () => {
  assert.deepEqual(stateBoardGateErrors({}, GOOD), []);
});

test('gate rejects an empty board even on an empty baseline', () => {
  assert.equal(stateBoardGateErrors({}, {}).length, 5);
});

test('gate rejects dropping a custom key from the input board', () => {
  const errs = stateBoardGateErrors({ ...GOOD, 恶魔契约: 'x' }, GOOD);
  assert.deepEqual(errs, ['缺键「恶魔契约」']);
});

test('gate leaves custom-key shapes unchecked', () => {
  assert.deepEqual(stateBoardGateErrors({ ...GOOD, 恶魔契约: 'x' }, { ...GOOD, 恶魔契约: { 甲: 1 } }), []);
});

test('gate allows extra keys the model added', () => {
  assert.deepEqual(stateBoardGateErrors(GOOD, { ...GOOD, 新键: 'x' }), []);
});

test('gate rejects 在场角色 as a flat string', () => {
  assert.equal(stateBoardGateErrors(GOOD, { ...GOOD, 在场角色: '寻、露' }).length, 1);
});

test('gate rejects non-string elements inside 在场角色', () => {
  assert.equal(stateBoardGateErrors(GOOD, { ...GOOD, 在场角色: [null, {}] }).length, 1);
});

test('gate rejects 衣装 as one flat sentence', () => {
  assert.equal(stateBoardGateErrors(GOOD, { ...GOOD, 衣装: '寻白衬衫露长裙' }).length, 1);
});

test('gate rejects null sub-values inside 衣装', () => {
  assert.equal(stateBoardGateErrors(GOOD, { ...GOOD, 衣装: { 甲: null } }).length, 1);
});

test('gate rejects array sub-values inside 关系', () => {
  assert.equal(stateBoardGateErrors(GOOD, { ...GOOD, 关系: { 甲: [] } }).length, 1);
});

test('gate rejects 位置 as an object', () => {
  assert.equal(stateBoardGateErrors(GOOD, { ...GOOD, 位置: { 寻: '书房' } }).length, 1);
});

test('gate rejects 时间地点 as a number', () => {
  assert.equal(stateBoardGateErrors(GOOD, { ...GOOD, 时间地点: 3 }).length, 1);
});

test('gate rejects an output that silently drops 未收伏笔', () => {
  const errs = stateBoardGateErrors({ ...GOOD, 未收伏笔: { 金簪: '下落不明' } }, GOOD);
  assert.deepEqual(errs, ['缺键「未收伏笔」']);
});

test('gate passes the legacy array → keyed-object migration of 未收伏笔', () => {
  assert.deepEqual(
    stateBoardGateErrors({ ...GOOD, 未收伏笔: ['金簪下落不明'] }, { ...GOOD, 未收伏笔: { 金簪: '下落不明' } }),
    [],
  );
});

test('gate rejects 未收伏笔 kept in the legacy array shape', () => {
  assert.equal(
    stateBoardGateErrors({ ...GOOD, 未收伏笔: ['金簪下落不明'] }, { ...GOOD, 未收伏笔: ['金簪下落不明'] }).length,
    1,
  );
});

test('gate only checks shape when the model invents 未收伏笔 (the instruction forbids inventing it)', () => {
  assert.deepEqual(stateBoardGateErrors(GOOD, { ...GOOD, 未收伏笔: { 金簪: '下落不明' } }), []);
});

test('gate passes the full legacy flat board converted to the target shapes', () => {
  const legacy = { 在场角色: '寻、露', 衣装: '寻白衬衫', 位置: '书房', 关系: '试探', 时间地点: '傍晚' };
  assert.deepEqual(stateBoardGateErrors(legacy, GOOD), []);
});

test('gate rejects a legacy flat board echoed back unconverted', () => {
  const legacy = { 在场角色: '寻、露', 衣装: '寻白衬衫', 位置: '书房', 关系: '试探', 时间地点: '傍晚' };
  assert.equal(stateBoardGateErrors(legacy, legacy).length, 3);
});
