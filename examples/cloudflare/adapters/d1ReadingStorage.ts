import type { ReadingStorage } from '../../../src/core/storage.ts';
import type { Chapter, ChapterComment } from '../../../src/core/types.ts';

function chapter(row: any): Chapter {
  return {
    id: row.id,
    project: row.project || '',
    chapterNo: row.chapter_no || '',
    title: row.title || '',
    content: row.content || '',
    summary: row.summary || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
    publishedAt: row.published_at || null,
  };
}

function comment(row: any): ChapterComment {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    replyTo: row.reply_to || null,
    author: { id: row.author_id, type: row.author_type, displayName: row.display_name },
    content: row.content,
    createdAt: row.created_at,
  };
}

export class D1ReadingStorage implements ReadingStorage {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async createChapter(input: Chapter): Promise<void> {
    await this.db.prepare(`INSERT INTO oc_chapters (id, project, chapter_no, title, content, summary, status, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.id, input.project, input.chapterNo, input.title, input.content, input.summary, input.status, input.publishedAt, input.createdAt, input.updatedAt || input.createdAt).run();
  }

  async getChapter(id: string): Promise<Chapter | null> { const row = await this.db.prepare(`SELECT * FROM oc_chapters WHERE id = ?`).bind(id).first<any>(); return row ? chapter(row) : null; }

  async publishChapter(id: string, publishedAt: string): Promise<Chapter | null> {
    const result = await this.db.prepare(`UPDATE oc_chapters SET status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND status = 'draft' RETURNING *`).bind(publishedAt, publishedAt, id).first<any>();
    return result ? chapter(result) : null;
  }

  async listPublishedChapters(project?: string): Promise<Array<Chapter & { commentCount: number }>> {
    const filter = project ? 'AND c.project = ?' : '';
    const statement = this.db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM oc_comments cm WHERE cm.chapter_id = c.id) AS comment_count
       FROM oc_chapters c WHERE c.status = 'published' ${filter}
       ORDER BY c.created_at ASC, c.id ASC LIMIT 200`,
    );
    const result = project ? await statement.bind(project).all<any>() : await statement.all<any>();
    return (result.results || []).map((row: any) => ({ ...chapter(row), commentCount: Number(row.comment_count) || 0 }));
  }

  async getPublishedChapter(id: string): Promise<Chapter | null> {
    const row = await this.db.prepare(`SELECT * FROM oc_chapters WHERE id = ? AND status = 'published'`).bind(id).first<any>();
    return row ? chapter(row) : null;
  }

  async listPublishedComments(chapterId: string, limit: number): Promise<ChapterComment[] | null> {
    const published = await this.db.prepare(`SELECT 1 FROM oc_chapters WHERE id = ? AND status = 'published'`).bind(chapterId).first();
    if (!published) return null;
    const result = await this.db.prepare(
      `SELECT id, chapter_id, reply_to, author_id, author_type, display_name, content, created_at
       FROM oc_comments WHERE chapter_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).bind(chapterId, limit).all<any>();
    return (result.results || []).map(comment);
  }

  async createPublishedComment(input: ChapterComment): Promise<ChapterComment | null> {
    const result = await this.db.prepare(
      `INSERT INTO oc_comments (id, chapter_id, reply_to, author_id, author_type, display_name, content, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM oc_chapters WHERE id = ? AND status = 'published')
         AND (? IS NULL OR EXISTS (SELECT 1 FROM oc_comments WHERE id = ? AND chapter_id = ?))`,
    ).bind(
      input.id, input.chapterId, input.replyTo, input.author.id, input.author.type,
      input.author.displayName, input.content, input.createdAt,
      input.chapterId, input.replyTo, input.replyTo, input.chapterId,
    ).run();
    return result.meta?.changes ? structuredClone(input) : null;
  }
}
