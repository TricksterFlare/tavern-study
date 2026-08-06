import type { StudyListQuery, StudyStats, StudyStorage } from '../../../src/core/storage.ts';
import type { StudyEntry } from '../../../src/core/types.ts';

function parseTags(raw: unknown): string[] {
  try {
    const value = JSON.parse(String(raw || '[]'));
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

function parseObject(raw: unknown): Record<string, string> {
  try {
    const value = JSON.parse(String(raw || '{}'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {};
  } catch { return {}; }
}

function entry(row: any): StudyEntry {
  return {
    id: row.id, project: row.project || '', category: row.category,
    title: row.title || '', tags: parseTags(row.tags), chapter: row.chapter || '', content: row.content || '',
    lore: {
      keys: parseTags(row.lore_keys), position: row.lore_position === 'after' ? 'after' : 'before',
      isCharacter: !!row.is_char, constant: !!row.lore_constant,
      triggerMode: row.trigger_mode === 'presence' ? 'presence' : 'scan',
      enabled: !!row.lore_enabled, fields: parseObject(row.lore_fields),
    },
    createdAt: row.created_at, updatedAt: row.updated_at || null,
  };
}

export class D1StudyStorage implements StudyStorage {
  constructor(private readonly db: D1Database) {}

  async listEntries(query: StudyListQuery): Promise<StudyEntry[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.project !== undefined) { conditions.push('project = ?'); values.push(query.project); }
    if (query.category) { conditions.push('category = ?'); values.push(query.category); }
    if (query.keyword) {
      conditions.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)');
      const keyword = `%${query.keyword}%`;
      values.push(keyword, keyword, keyword);
    }
    if (query.tag) {
      conditions.push('tags LIKE ?');
      values.push(`%"${query.tag.replace(/"/g, '')}"%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.db.prepare(`SELECT * FROM memories ${where} LIMIT 200`).bind(...values).all<any>();
    return (result.results || []).map(entry);
  }

  async getEntry(id: string): Promise<StudyEntry | null> {
    const row = await this.db.prepare(`SELECT * FROM memories WHERE id = ?`).bind(id).first<any>();
    return row ? entry(row) : null;
  }

  async createEntry(value: StudyEntry): Promise<void> {
    await this.db.prepare(
      `INSERT INTO memories
       (id, project, category, title, tags, chapter, content, lore_keys, lore_position, is_char,
        lore_constant, trigger_mode, lore_enabled, lore_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      value.id, value.project, value.category, value.title, JSON.stringify(value.tags),
      value.chapter, value.content, JSON.stringify(value.lore.keys), value.lore.position,
      value.lore.isCharacter ? 1 : 0, value.lore.constant ? 1 : 0, value.lore.triggerMode,
      value.lore.enabled ? 1 : 0, JSON.stringify(value.lore.fields), value.createdAt, value.updatedAt,
    ).run();
  }

  async updateEntry(id: string, patch: Partial<Omit<StudyEntry, 'id' | 'createdAt'>>): Promise<StudyEntry | null> {
    const columns: Array<[keyof typeof patch, string, (value: any) => any]> = [
      ['project', 'project', (value) => value], ['category', 'category', (value) => value],
      ['title', 'title', (value) => value], ['tags', 'tags', (value) => JSON.stringify(value)],
      ['chapter', 'chapter', (value) => value], ['content', 'content', (value) => value],
      ['updatedAt', 'updated_at', (value) => value],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column, encode] of columns) {
      if (patch[key] !== undefined) { sets.push(`${column} = ?`); values.push(encode(patch[key])); }
    }
    if (patch.lore !== undefined) {
      sets.push('lore_keys = ?', 'lore_position = ?', 'is_char = ?', 'lore_constant = ?', 'trigger_mode = ?', 'lore_enabled = ?', 'lore_fields = ?');
      values.push(
        JSON.stringify(patch.lore.keys), patch.lore.position, patch.lore.isCharacter ? 1 : 0,
        patch.lore.constant ? 1 : 0, patch.lore.triggerMode, patch.lore.enabled ? 1 : 0,
        JSON.stringify(patch.lore.fields),
      );
    }
    if (!sets.length) return this.getEntry(id);
    const result = await this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id).run();
    return result.meta?.changes ? this.getEntry(id) : null;
  }

  async deleteEntry(id: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM memories WHERE id = ?`).bind(id).run();
    return !!result.meta?.changes;
  }

  async stats(): Promise<StudyStats> {
    const [byCategoryResult, byProjectResult] = await Promise.all([
      this.db.prepare(`SELECT category, COUNT(*) AS n FROM memories GROUP BY category`).all<any>(),
      this.db.prepare(`SELECT project, COUNT(*) AS n FROM memories GROUP BY project`).all<any>(),
    ]);
    const byCategory: Record<string, number> = {};
    for (const row of byCategoryResult.results || []) byCategory[String(row.category)] = Number(row.n) || 0;
    const byProject: Record<string, number> = {};
    for (const row of byProjectResult.results || []) byProject[String(row.project)] = Number(row.n) || 0;
    const total = Object.values(byCategory).reduce((sum, count) => sum + count, 0);
    return { byCategory, byProject, total };
  }
}
