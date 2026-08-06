import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMentionedCharactersToPresence,
  buildLoreScanCorpus,
  extractAtMentions,
  presenceHasName,
  resolveAtMentionIds,
} from '../src/core/loreTrigger.ts';

test('scans the current input and only the latest six floors', () => {
  const floors = Array.from({ length: 8 }, (_, index) => ({ content: `floor-${index + 1}` }));
  const corpus = buildLoreScanCorpus('current', floors);
  assert.equal(corpus.includes('floor-1'), false);
  assert.equal(corpus.includes('floor-2'), false);
  assert.equal(corpus.includes('floor-3'), true);
  assert.equal(corpus.startsWith('current\n'), true);
});

test('extracts explicit mentions but ignores email-like text', () => {
  assert.deepEqual(extractAtMentions('准了@张淮深进来，@露。someone@pyrite.com'), ['张淮深进来', '露']);
});

test('uses exact or longest CJK-friendly prefix without summoning shorter cards', () => {
  const lore = [
    { id: 'short', name: '张', keys: [] },
    { id: 'long', name: '张淮深', keys: ['小张校尉'] },
    { id: 'pyrite', name: 'Pyrite', keys: [] },
  ];
  assert.deepEqual([...resolveAtMentionIds('@张淮深进来', lore)], ['long']);
  assert.deepEqual([...resolveAtMentionIds('@小张校尉', lore)], ['long']);
  assert.equal(resolveAtMentionIds('@pyrites', lore).has('pyrite'), false);
  assert.equal(resolveAtMentionIds('@Pyrite', lore).has('pyrite'), true);
});

test('does not mistake a longer name for a present single-character role', () => {
  assert.equal(presenceHasName('露西、寻', ['露']), false);
  assert.equal(presenceHasName('露（受伤）、寻', ['露']), true);
});

test('explicitly mentioned characters join the presence board once', () => {
  const board: Record<string, unknown> = { 在场角色: ['露西'] };
  const role = { id: 'lu', name: '露', keys: [] };
  addMentionedCharactersToPresence(board, [role, role]);
  assert.deepEqual(board.在场角色, ['露西', '露']);
});
