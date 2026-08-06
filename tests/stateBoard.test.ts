import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStateBoard } from '../src/core/stateBoard.ts';

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
