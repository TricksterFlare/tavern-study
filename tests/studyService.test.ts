import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/adapters/memoryStorage.ts';
import { StudyService } from '../src/core/studyService.ts';
import type { SemanticDocument, SemanticSearchAdapter } from '../src/core/storage.ts';

class FakeSemantic implements SemanticSearchAdapter {
  documents = new Map<string, SemanticDocument>();
  deleted: string[] = [];
  async upsert(document: SemanticDocument): Promise<void> { this.documents.set(document.id, structuredClone(document)); }
  async delete(id: string): Promise<void> { this.documents.delete(id); this.deleted.push(id); }
  async search(query: string): Promise<Array<{ id: string; score: number }>> {
    return [...this.documents.values()].filter((document) => document.text.includes(query)).map((document) => ({ id: document.id, score: 0.9 }));
  }
}

test('runs study CRUD without Cloudflare or a database', async () => {
  const storage = createMemoryStorage();
  const service = new StudyService(storage.study);
  const created = await service.create({
    project: '\u200B Project 1 ', category: 'world', title: 'Map',
    tags: ['place'], chapter: '第10日', content: 'A city map.',
  });
  assert.equal(created.success, true);
  assert.equal(created.project, 'Project 1');

  const fetched = await service.get(created.id);
  assert.equal(fetched.content, 'A city map.');
  const updated = await service.update(created.id, { chapter: '第2日', content: 'Updated map.' });
  assert.equal(updated.chapter, '第2日');
  assert.equal((await service.list({ tag: 'place' })).count, 1);
  assert.equal((await service.delete(created.id)).success, true);
  assert.equal((await service.get(created.id)).success, false);
});

test('naturally sorts chapter labels and validates categories', async () => {
  const storage = createMemoryStorage();
  const service = new StudyService(storage.study);
  const ten = await service.create({ project: 'P', category: 'session', chapter: '第10日', title: 'ten' });
  const two = await service.create({ project: 'P', category: 'session', chapter: '第2日', title: 'two' });
  const list = await service.list({ project: 'P', order: 'chapter' });
  assert.deepEqual(list.memories.map((entry: any) => entry.id), [two.id, ten.id]);
  assert.equal((await service.create({ project: 'P', category: 'invalid' })).success, false);
});

test('keeps lore fields and semantic index lifecycle behind optional adapters', async () => {
  const storage = createMemoryStorage();
  const semantic = new FakeSemantic();
  const service = new StudyService(storage.study, semantic);
  const created = await service.create({
    project: 'P', category: 'world', title: 'Harbor', content: 'Silver harbor',
    lore: { keys: ['harbor'], position: 'after', constant: true, enabled: true, isCharacter: false, triggerMode: 'scan', fields: { description: 'A port' } },
  });
  assert.equal(created.semantic_ok, true);
  assert.equal(created.lore.position, 'after');
  assert.equal(semantic.documents.has(created.id), true);
  assert.equal((await service.search({ q: 'Silver' })).count, 1);

  const updated = await service.update(created.id, { title: 'New Harbor', lore: { enabled: false } });
  assert.equal(updated.lore.enabled, false);
  assert.equal(updated.lore.position, 'after');
  await service.delete(created.id);
  assert.deepEqual(semantic.deleted, [created.id]);

  const noSemantic = new StudyService(createMemoryStorage().study);
  assert.deepEqual(await noSemantic.search({ q: 'anything' }), {
    success: false, error: 'semantic_search_unavailable', capability: 'disabled',
  });
});
