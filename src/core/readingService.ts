import type { ReadingStorage } from './storage.ts';
import type { CommentAuthor } from './types.ts';

const MAX_CHAPTERS = 30;
const MAX_COMMENTS = 100;
const MAX_COMMENT_CHARS = 2000;
const MAX_READ_CHARS = 30000;

function naturalCompare(left: string, right: string): number {
  const segments = (value: string) => value.match(/\d+|\D+/g) || [];
  const a = segments(left);
  const b = segments(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const aNumber = /^\d+$/.test(a[index]);
    const bNumber = /^\d+$/.test(b[index]);
    if (aNumber && bNumber) {
      const difference = Number(a[index]) - Number(b[index]);
      if (difference) return difference;
    } else if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function limit(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(Math.max(value, 1), maximum)
    : fallback;
}

export class ReadingService {
  private readonly storage: ReadingStorage;

  constructor(storage: ReadingStorage) {
    this.storage = storage;
  }

  async createDraft(input: { project?: string; chapterNo?: string; title?: string; content?: string; summary?: string }): Promise<any> {
    if (!input || typeof input.project !== 'string' || !input.project.trim() || input.project.length > 100) return { success: false, error: 'project must contain 1-100 characters.' };
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) return { success: false, error: 'title must contain 1-200 characters.' };
    if (input.chapterNo !== undefined && (typeof input.chapterNo !== 'string' || input.chapterNo.length > 100)) return { success: false, error: 'chapterNo must not exceed 100 characters.' };
    if (input.content !== undefined && (typeof input.content !== 'string' || input.content.length > 500000)) return { success: false, error: 'content must not exceed 500000 characters.' };
    if (input.summary !== undefined && (typeof input.summary !== 'string' || input.summary.length > 50000)) return { success: false, error: 'summary must not exceed 50000 characters.' };
    const now = new Date().toISOString();
    const chapter = { id: `chapter_${crypto.randomUUID()}`, project: input.project.trim(), chapterNo: input.chapterNo || '', title: input.title.trim(), content: input.content || '', summary: input.summary || '', status: 'draft' as const, createdAt: now, updatedAt: now, publishedAt: null };
    await this.storage.createChapter(chapter);
    return { success: true, chapter };
  }

  async publish(id: string): Promise<any> {
    if (typeof id !== 'string' || !id.trim()) return { success: false, error: 'id is required.' };
    const chapter = await this.storage.publishChapter(id, new Date().toISOString());
    if (!chapter) return { success: false, error: 'Draft chapter not found or already published.' };
    return { success: true, chapter };
  }

  async listPublished(input: { project?: string; limit?: number } = {}): Promise<any> {
    const rows = await this.storage.listPublishedChapters(input.project);
    rows.sort((a, b) => {
      if (!a.chapterNo && !b.chapterNo) return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      if (!a.chapterNo) return 1;
      if (!b.chapterNo) return -1;
      return naturalCompare(a.chapterNo, b.chapterNo) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    });
    const chapters = rows.slice(0, limit(input.limit, 10, MAX_CHAPTERS)).map((chapter) => ({
      id: chapter.id,
      project: chapter.project,
      chapter_no: chapter.chapterNo,
      title: chapter.title,
      summary: chapter.summary,
      status: chapter.status,
      created_at: chapter.createdAt,
      updated_at: chapter.updatedAt,
      published_at: chapter.publishedAt,
      comment_count: chapter.commentCount,
      preview: chapter.content.replace(/[\r\n]+/g, ' ').slice(0, 120),
    }));
    return { success: true, count: chapters.length, chapters };
  }

  async readPublished(id: string): Promise<any> {
    const chapter = await this.storage.getPublishedChapter(id);
    if (!chapter) return { success: false, error: 'Chapter not found or not published.' };
    const extra = Math.max(0, chapter.content.length - MAX_READ_CHARS);
    const content = extra ? `${chapter.content.slice(0, MAX_READ_CHARS)}\n…(${extra} more characters)` : chapter.content;
    return {
      success: true, id: chapter.id, project: chapter.project, chapter_no: chapter.chapterNo,
      title: chapter.title, content, summary: chapter.summary, status: chapter.status,
      created_at: chapter.createdAt, updated_at: chapter.updatedAt, published_at: chapter.publishedAt,
    };
  }

  async listComments(chapterId: string, requestedLimit?: number): Promise<any> {
    const comments = await this.storage.listPublishedComments(chapterId, limit(requestedLimit, 50, MAX_COMMENTS));
    if (!comments) return { success: false, error: 'Chapter not found or not published.' };
    return {
      success: true,
      count: comments.length,
      comments: comments.map((comment) => ({
        id: comment.id, chapter_id: comment.chapterId, reply_to: comment.replyTo,
        author_id: comment.author.id, author_type: comment.author.type,
        display_name: comment.author.displayName, content: comment.content, created_at: comment.createdAt,
      })),
    };
  }

  async createComment(input: { chapterId: string; content: string; replyTo?: string; author: CommentAuthor }): Promise<any> {
    const content = input.content.trim();
    if (!content || content.length > MAX_COMMENT_CHARS) return { success: false, error: 'Comment must contain 1-2000 characters.' };
    const comment = await this.storage.createPublishedComment({
      id: `cm_${crypto.randomUUID()}`,
      chapterId: input.chapterId,
      replyTo: input.replyTo || null,
      author: input.author,
      content,
      createdAt: new Date().toISOString(),
    });
    if (!comment) return { success: false, error: 'Chapter is unavailable or reply target is invalid.' };
    return { success: true, id: comment.id, chapter_id: comment.chapterId, content: comment.content };
  }
}
