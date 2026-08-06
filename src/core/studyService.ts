import type { SemanticSearchAdapter, StudyListQuery, StudyStorage } from './storage.ts';
import type { LoreConfig, StudyCategory, StudyEntry } from './types.ts';

const CATEGORIES = new Set<StudyCategory>(['world', 'plot', 'outline', 'session']);
const INVISIBLE_PROJECT_CHARS = new RegExp('[' + String.fromCharCode(0x200B, 0x200E, 0x200F, 0x2060, 0xFEFF) + ']', 'g');

export function normalizeProject(value: string): string {
  return value.replace(INVISIBLE_PROJECT_CHARS, '').trim();
}

function naturalCompare(left: string, right: string): number {
  const split = (value: string) => value.match(/\d+|\D+/g) || [];
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (/^\d+$/.test(a[index]) && /^\d+$/.test(b[index])) {
      const difference = Number(a[index]) - Number(b[index]);
      if (difference) return difference;
    } else if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function validate(input: any, creating: boolean): string | null {
  if (creating || input.category !== undefined) {
    if (!CATEGORIES.has(input.category)) return 'category must be world, plot, outline, or session.';
  }
  if (creating || input.project !== undefined) {
    if (typeof input.project !== 'string' || !normalizeProject(input.project) || input.project.length > 100) return 'project must contain 1-100 characters.';
  }
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 200)) return 'title must not exceed 200 characters.';
  if (input.chapter !== undefined && (typeof input.chapter !== 'string' || input.chapter.length > 100)) return 'chapter must not exceed 100 characters.';
  if (input.content !== undefined && (typeof input.content !== 'string' || input.content.length > 200000)) return 'content must not exceed 200000 characters.';
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some((tag: unknown) => typeof tag !== 'string' || tag.length > 50))) return 'tags must contain at most 20 strings of at most 50 characters.';
  if (input.lore !== undefined) {
    if (!input.lore || typeof input.lore !== 'object' || Array.isArray(input.lore)) return 'lore must be an object.';
    if (input.lore.keys !== undefined && (!Array.isArray(input.lore.keys) || input.lore.keys.some((key: unknown) => typeof key !== 'string' || key.length > 100))) return 'lore.keys must contain strings of at most 100 characters.';
    if (input.lore.position !== undefined && !['before', 'after'].includes(input.lore.position)) return 'invalid lore.position.';
    if (input.lore.triggerMode !== undefined && !['scan', 'presence'].includes(input.lore.triggerMode)) return 'invalid lore.triggerMode.';
    for (const key of ['isCharacter', 'constant', 'enabled']) if (input.lore[key] !== undefined && typeof input.lore[key] !== 'boolean') return `lore.${key} must be boolean.`;
    if (input.lore.fields !== undefined && (!input.lore.fields || typeof input.lore.fields !== 'object' || Array.isArray(input.lore.fields) || Object.values(input.lore.fields).some((value) => typeof value !== 'string'))) return 'lore.fields must contain string values.';
  }
  return null;
}

function lore(input: Partial<LoreConfig> | undefined, base?: LoreConfig): LoreConfig {
  return {
    keys: input?.keys ? [...input.keys] : [...(base?.keys || [])],
    position: input?.position || base?.position || 'before',
    isCharacter: input?.isCharacter ?? base?.isCharacter ?? false,
    constant: input?.constant ?? base?.constant ?? false,
    triggerMode: input?.triggerMode || base?.triggerMode || 'scan',
    enabled: input?.enabled ?? base?.enabled ?? true,
    fields: { ...(base?.fields || {}), ...(input?.fields || {}) },
  };
}

export class StudyService {
  private readonly storage: StudyStorage;
  private readonly semantic?: SemanticSearchAdapter;

  constructor(storage: StudyStorage, semantic?: SemanticSearchAdapter) {
    this.storage = storage;
    this.semantic = semantic;
  }

  async list(input: StudyListQuery & { order?: 'time' | 'chapter' | 'title'; limit?: number } = {}): Promise<any> {
    if (input.project !== undefined && typeof input.project !== 'string') return { success: false, error: 'project must be a string.' };
    if (input.category !== undefined && !CATEGORIES.has(input.category)) return { success: false, error: 'invalid category.' };
    if (input.keyword !== undefined && typeof input.keyword !== 'string') return { success: false, error: 'keyword must be a string.' };
    if (input.tag !== undefined && typeof input.tag !== 'string') return { success: false, error: 'tag must be a string.' };
    if (input.order !== undefined && !['time', 'chapter', 'title'].includes(input.order)) return { success: false, error: 'invalid order.' };
    if (input.limit !== undefined && (typeof input.limit !== 'number' || !Number.isInteger(input.limit))) return { success: false, error: 'limit must be an integer.' };
    const project = input.project === undefined ? undefined : normalizeProject(input.project);
    const rows = await this.storage.listEntries({ ...input, project });
    const order = input.order || 'time';
    rows.sort((a, b) => {
      if (order === 'title') return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
      if (order === 'chapter') {
        if (!a.chapter && !b.chapter) return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
        if (!a.chapter) return 1;
        if (!b.chapter) return -1;
        return naturalCompare(a.chapter, b.chapter) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      }
      return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
    });
    const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 200) : 50;
    const memories = rows.slice(0, limit).map((entry) => ({
      id: entry.id, project: entry.project, category: entry.category, title: entry.title,
      tags: entry.tags, chapter: entry.chapter, created_at: entry.createdAt,
      updated_at: entry.updatedAt, preview: entry.content.replace(/[\r\n]+/g, ' ').slice(0, 200),
    }));
    return { success: true, count: memories.length, memories };
  }

  async get(id: string): Promise<any> {
    const entry = await this.storage.getEntry(id);
    if (!entry) return { success: false, error: 'Study entry not found.' };
    return { success: true, ...this.output(entry) };
  }

  async create(input: any): Promise<any> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { success: false, error: 'Invalid input.' };
    const error = validate(input, true);
    if (error) return { success: false, error };
    const now = new Date().toISOString();
    const entry: StudyEntry = {
      id: `mem_${crypto.randomUUID()}`,
      project: normalizeProject(input.project), category: input.category,
      title: input.title || '', tags: input.tags || [], chapter: input.chapter || '', content: input.content || '',
      lore: lore(input.lore),
      createdAt: now, updatedAt: now,
    };
    await this.storage.createEntry(entry);
    const semanticOk = await this.index(entry);
    return { success: true, semantic_ok: semanticOk, ...this.output(entry) };
  }

  async update(id: string, input: any): Promise<any> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { success: false, error: 'Invalid input.' };
    const error = validate(input, false);
    if (error) return { success: false, error };
    const allowed = ['project', 'category', 'title', 'tags', 'chapter', 'content'] as const;
    const patch: any = {};
    for (const key of allowed) if (input[key] !== undefined) patch[key] = key === 'project' ? normalizeProject(input[key]) : input[key];
    if (input.lore !== undefined) {
      const current = await this.storage.getEntry(id);
      if (!current) return { success: false, error: 'Study entry not found.' };
      patch.lore = lore(input.lore, current.lore);
    }
    if (!Object.keys(patch).length) return { success: false, error: 'No fields to update.' };
    patch.updatedAt = new Date().toISOString();
    const entry = await this.storage.updateEntry(id, patch);
    if (!entry) return { success: false, error: 'Study entry not found.' };
    const semanticOk = await this.index(entry);
    return { success: true, semantic_ok: semanticOk, ...this.output(entry) };
  }

  async delete(id: string): Promise<any> {
    if (!(await this.storage.deleteEntry(id))) return { success: false, error: 'Study entry not found.' };
    let semanticOk: boolean | null = this.semantic ? true : null;
    if (this.semantic) {
      try { await this.semantic.delete(id); }
      catch { semanticOk = false; }
    }
    return { success: true, semantic_ok: semanticOk, id };
  }

  async search(input: { q?: string; project?: string; category?: StudyCategory; limit?: number }): Promise<any> {
    if (!this.semantic) return { success: false, error: 'semantic_search_unavailable', capability: 'disabled' };
    if (typeof input.q !== 'string' || !input.q.trim()) return { success: false, error: 'q is required.' };
    if (input.project !== undefined && typeof input.project !== 'string') return { success: false, error: 'project must be a string.' };
    if (input.category !== undefined && !CATEGORIES.has(input.category)) return { success: false, error: 'invalid category.' };
    const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 20) : 10;
    const filter: Record<string, string> = {};
    if (input.project) filter.project = normalizeProject(input.project);
    if (input.category) filter.category = input.category;
    const hits = await this.semantic.search(input.q.trim(), { limit, filter: Object.keys(filter).length ? filter : undefined });
    const results = [];
    for (const hit of hits) {
      const entry = await this.storage.getEntry(hit.id);
      if (entry) results.push({ id: entry.id, project: entry.project, category: entry.category, title: entry.title, chapter: entry.chapter, preview: entry.content.replace(/[\r\n]+/g, ' ').slice(0, 200), score: hit.score });
    }
    return { success: true, capability: 'enabled', count: results.length, results };
  }

  async stats(): Promise<any> {
    const { byCategory, byProject, total } = await this.storage.stats();
    return { success: true, by_category: byCategory, by_project: byProject, total };
  }

  private output(entry: StudyEntry): any {
    return {
      id: entry.id, project: entry.project, category: entry.category, title: entry.title,
      tags: entry.tags, chapter: entry.chapter, content: entry.content, lore: entry.lore,
      created_at: entry.createdAt, updated_at: entry.updatedAt,
    };
  }

  private async index(entry: StudyEntry): Promise<boolean | null> {
    if (!this.semantic) return null;
    try {
      await this.semantic.upsert({
        id: entry.id,
        text: `${entry.title}\n${entry.content.slice(0, 8000)}`,
        metadata: { project: entry.project, category: entry.category, title: entry.title.slice(0, 100), created_at: entry.createdAt },
      });
      return true;
    } catch {
      return false;
    }
  }
}
