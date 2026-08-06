import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/adapters/memoryStorage.ts';
import { ReadingService } from '../src/core/readingService.ts';
import type { Chapter } from '../src/core/types.ts';

function chapter(id: string, chapterNo: string, status: Chapter['status'] = 'published'): Chapter {
  return {
    id, project: 'project-1', chapterNo, title: `Chapter ${chapterNo}`,
    content: `Body ${chapterNo}`, summary: '', status,
    createdAt: `2026-01-${id.slice(-2).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: null, publishedAt: status === 'published' ? '2026-01-01T00:00:00.000Z' : null,
  };
}

test('runs published reading and comments without Cloudflare or a database', async () => {
  const storage = createMemoryStorage({ chapters: [chapter('ch_10', '第10章'), chapter('ch_02', '第2章'), chapter('ch_03', '第3章', 'draft')] });
  const service = new ReadingService(storage.reading);

  const list = await service.listPublished();
  assert.deepEqual(list.chapters.map((item: any) => item.id), ['ch_02', 'ch_10']);
  assert.equal((await service.readPublished('ch_03')).success, false);

  const created = await service.createComment({
    chapterId: 'ch_02', content: '  hello  ',
    author: { id: 'companion', type: 'ai', displayName: 'Companion' },
  });
  assert.equal(created.success, true);
  const comments = await service.listComments('ch_02');
  assert.equal(comments.count, 1);
  assert.equal(comments.comments[0].content, 'hello');
  assert.equal(comments.comments[0].author_id, 'companion');
});

test('rejects cross-chapter replies in the adapter contract', async () => {
  const storage = createMemoryStorage({ chapters: [chapter('ch_01', '1'), chapter('ch_02', '2')] });
  const service = new ReadingService(storage.reading);
  const first = await service.createComment({
    chapterId: 'ch_01', content: 'first', author: { id: 'owner', type: 'owner', displayName: 'Owner' },
  });
  const reply = await service.createComment({
    chapterId: 'ch_02', content: 'wrong room', replyTo: first.id,
    author: { id: 'companion', type: 'ai', displayName: 'Companion' },
  });
  assert.equal(reply.success, false);
});

test('newly published memory chapters are immediately visible to desk story assembly', async () => {
  const storage = createMemoryStorage(); const service = new ReadingService(storage.reading);
  const draft = await service.createDraft({ project: 'p', title: 'Fresh', content: 'New canon.' });
  assert.equal((await service.publish(draft.chapter.id)).success, true);
  assert.deepEqual((await storage.deskStory.listPublishedChapters('p')).map((chapter) => chapter.id), [draft.chapter.id]);
});
