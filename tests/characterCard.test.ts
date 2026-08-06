import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCharacterCard } from '../src/core/characterCard.ts';

test('parses a V1 flat character card', () => {
  const result = parseCharacterCard({
    name: '露',
    description: '沉默寡言的书记官。',
    personality: '冷静',
    scenario: '书房',
    first_mes: '你来了。',
    mes_example: '<START>\n{{user}}: 你好\n{{char}}: 嗯。',
    creatorcomment: '老卡常见字段,不该被算进"不认识"',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.card.name, '露');
  assert.equal(result.card.description, '沉默寡言的书记官。');
  assert.equal(result.card.personality, '冷静');
  assert.equal(result.card.scenario, '书房');
  assert.equal(result.card.firstMes, '你来了。');
  assert.equal(result.card.mesExample, '<START>\n{{user}}: 你好\n{{char}}: 嗯。');
  assert.equal(result.card.systemPrompt, '');
  assert.equal(result.card.characterBook, null);
  assert.deepEqual(result.card.alternateGreetings, []);
  assert.equal(result.warnings.length, 0);
});

test('parses a V2 wrapped character card with system_prompt/post_history_instructions', () => {
  const result = parseCharacterCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '寻',
      description: '游方医师。',
      personality: '',
      scenario: '',
      first_mes: '有人受伤了吗？',
      mes_example: '',
      system_prompt: '你扮演寻,一名游方医师。',
      post_history_instructions: '保持医者口吻。',
      alternate_greetings: ['你怎么了？', '让我看看伤口。'],
      creator_notes: '测试用',
      tags: ['医师'],
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.card.name, '寻');
  assert.equal(result.card.systemPrompt, '你扮演寻,一名游方医师。');
  assert.equal(result.card.postHistoryInstructions, '保持医者口吻。');
  assert.deepEqual(result.card.alternateGreetings, ['你怎么了？', '让我看看伤口。']);
  assert.equal(result.warnings.length, 0);
});

test('parses a V3 wrapped character card with an embedded character_book', () => {
  const result = parseCharacterCard({
    spec: 'chara_card_v3',
    data: {
      name: '雾隐',
      description: '山中隐士。',
      character_book: {
        name: '雾隐的设定集',
        entries: [
          { keys: ['雾隐山'], content: '云雾常年不散的山脉。', enabled: true, constant: false, comment: '雾隐山' },
          { keys: ['隐居小屋'], content: '藏在竹林深处。', disable: true, comment: '隐居小屋' },
        ],
      },
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.card.name, '雾隐');
  assert.ok(result.card.characterBook);
  assert.equal(Array.isArray(result.card.characterBook!.entries), true);
  assert.equal(result.card.characterBook!.entries.length, 2);
  assert.equal(result.warnings.length, 0);
});

test('rejects a card missing name as a hard error', () => {
  const result = parseCharacterCard({ description: '没有名字的卡' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /name/);
});

test('rejects a card whose name is the wrong type', () => {
  const result = parseCharacterCard({ name: 12345, description: 'x' });
  assert.equal(result.ok, false);
});

test('rejects a non-object top-level value', () => {
  const result = parseCharacterCard('not an object');
  assert.equal(result.ok, false);
});

test('rejects a v2/v3 wrapper whose data is not an object', () => {
  const result = parseCharacterCard({ spec: 'chara_card_v2', data: 'nope' });
  assert.equal(result.ok, false);
});

test('rejects an unrecognized spec value', () => {
  const result = parseCharacterCard({ spec: 'chara_card_v9', data: { name: '露' } });
  assert.equal(result.ok, false);
});

test('tolerates a malformed character_book by dropping it and warning, not failing the whole card', () => {
  const badShape = parseCharacterCard({ name: '露', character_book: 'not an object' });
  assert.equal(badShape.ok, true);
  if (badShape.ok) {
    assert.equal(badShape.card.characterBook, null);
    assert.ok(badShape.warnings.some((w) => w.includes('character_book')));
  }

  const badEntries = parseCharacterCard({ name: '露', character_book: { entries: 'not an array or object' } });
  assert.equal(badEntries.ok, true);
  if (badEntries.ok) {
    assert.equal(badEntries.card.characterBook, null);
    assert.ok(badEntries.warnings.some((w) => w.includes('entries')));
  }

  // character_book 存在但没带 entries——静默当没带世界书,不是 warning
  const noEntries = parseCharacterCard({ name: '露', character_book: { name: '空壳' } });
  assert.equal(noEntries.ok, true);
  if (noEntries.ok) {
    assert.equal(noEntries.card.characterBook, null);
    assert.equal(noEntries.warnings.length, 0);
  }
});

test('ignores unrecognized fields with a single summary warning, not one per field', () => {
  const result = parseCharacterCard({
    name: '露',
    totally_custom_field_one: 1,
    totally_custom_field_two: 2,
    totally_custom_field_three: 3,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const summaryWarnings = result.warnings.filter((w) => w.includes('不认识的字段'));
  assert.equal(summaryWarnings.length, 1);
  assert.match(summaryWarnings[0], /3 个/);
});

test('drops a known field with the wrong type and records one warning per bad field', () => {
  const result = parseCharacterCard({ name: '露', description: 42, alternate_greetings: 'not an array' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.card.description, '');
  assert.deepEqual(result.card.alternateGreetings, []);
  assert.ok(result.warnings.some((w) => w.startsWith('description')));
  assert.ok(result.warnings.some((w) => w.startsWith('alternate_greetings')));
});

test('drops non-string entries inside alternate_greetings but keeps the valid ones', () => {
  const result = parseCharacterCard({ name: '露', alternate_greetings: ['ok', 42, 'also ok'] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.card.alternateGreetings, ['ok', 'also ok']);
  assert.ok(result.warnings.some((w) => w.includes('非字符串项')));
});
