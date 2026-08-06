import type { DeskStoryStorage } from '../../../src/core/storage.ts';
import type { Chapter } from '../../../src/core/types.ts';

function chapter(row: any): Chapter {
  return { id: row.id, project: row.project || '', chapterNo: row.chapter_no || '', title: row.title || '',
    content: row.content || '', summary: row.summary || '', status: row.status, createdAt: row.created_at,
    updatedAt: row.updated_at || null, publishedAt: row.published_at || null };
}

export class D1DeskStoryStorage implements DeskStoryStorage {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async getState(key: string) { const row = await this.db.prepare(`SELECT value FROM oc_state WHERE key = ?`).bind(key).first<any>(); return row ? String(row.value) : null; }
  async listPublishedChapters(project: string) {
    const result = await this.db.prepare(`SELECT * FROM oc_chapters WHERE project = ? AND status = 'published'`).bind(project).all<any>();
    return (result.results || []).map(chapter);
  }
  async getPublishedChapters(ids: string[], project: string) {
    if (!ids.length) return [];
    const result = await this.db.prepare(`SELECT * FROM oc_chapters WHERE id IN (${ids.map(() => '?').join(', ')}) AND project = ? AND status = 'published' AND (TRIM(content) != '' OR TRIM(summary) != '')`).bind(...ids, project).all<any>();
    return (result.results || []).map(chapter);
  }
}
