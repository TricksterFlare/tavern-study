import type { DeskStorage } from '../../../src/core/storage.ts';
import type { DeskFloor, DeskWindow } from '../../../src/core/types.ts';

function parseObject(raw: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(raw ?? '{}'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function parseStrings(raw: unknown): string[] {
  try {
    const value = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function windowFromRow(row: any): DeskWindow {
  return {
    id: row.id,
    project: row.project || '',
    title: row.title || '',
    recipeId: row.recipe_id || '',
    note: row.note || '',
    noteDepth: Number.isInteger(row.note_depth) ? row.note_depth : 3,
    stateBoard: parseObject(row.state_board),
    timelineState: parseObject(row.timeline_state),
    vars: parseObject(row.vars),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function floorFromRow(row: any): DeskFloor {
  const content = String(row.content || '');
  const parsed = parseStrings(row.variants);
  const variants = parsed.length ? parsed : [content];
  const candidate = Number(row.active_variant);
  const activeVariant = Number.isInteger(candidate) && candidate >= 0 && candidate < variants.length
    ? candidate
    : 0;
  variants[activeVariant] = content;
  return {
    id: row.id,
    windowId: row.window_id,
    role: row.role,
    content,
    variants,
    activeVariant,
    thinking: row.thinking ?? null,
    report: row.report == null ? null : parseObject(row.report),
    createdAt: row.created_at,
  };
}

export class D1DeskStorage implements DeskStorage {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }

  async listWindows(project?: string): Promise<DeskWindow[]> {
    const statement = this.db.prepare(
      `SELECT * FROM desk_windows ${project === undefined ? '' : 'WHERE project = ?'}
       ORDER BY updated_at DESC, id DESC LIMIT 200`,
    );
    const result = project === undefined ? await statement.all<any>() : await statement.bind(project).all<any>();
    return (result.results || []).map(windowFromRow);
  }

  async getWindow(id: string): Promise<DeskWindow | null> {
    const row = await this.db.prepare(`SELECT * FROM desk_windows WHERE id = ?`).bind(id).first<any>();
    return row ? windowFromRow(row) : null;
  }

  async createWindow(value: DeskWindow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO desk_windows
       (id, project, title, recipe_id, note, note_depth, state_board, timeline_state, vars, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      value.id, value.project, value.title, value.recipeId, value.note, value.noteDepth,
      JSON.stringify(value.stateBoard), JSON.stringify(value.timelineState), JSON.stringify(value.vars),
      value.createdAt, value.updatedAt,
    ).run();
  }

  async updateWindow(id: string, patch: Partial<Omit<DeskWindow, 'id' | 'createdAt'>>): Promise<DeskWindow | null> {
    const columns: Array<[keyof typeof patch, string, (value: any) => unknown]> = [
      ['project', 'project', (value) => value], ['title', 'title', (value) => value],
      ['recipeId', 'recipe_id', (value) => value], ['note', 'note', (value) => value],
      ['noteDepth', 'note_depth', (value) => value], ['stateBoard', 'state_board', JSON.stringify],
      ['timelineState', 'timeline_state', JSON.stringify], ['vars', 'vars', JSON.stringify],
      ['updatedAt', 'updated_at', (value) => value],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column, encode] of columns) {
      if (patch[key] !== undefined) { sets.push(`${column} = ?`); values.push(encode(patch[key])); }
    }
    if (!sets.length) return this.getWindow(id);
    const result = await this.db.prepare(`UPDATE desk_windows SET ${sets.join(', ')} WHERE id = ?`).bind(...values, id).run();
    return result.meta?.changes ? this.getWindow(id) : null;
  }

  async updateTimelineState(id: string, expectedUpdatedAt: string, timelineState: Record<string, unknown>, updatedAt: string): Promise<DeskWindow | null> {
    const result = await this.db.prepare(`UPDATE desk_windows SET timeline_state = ?, updated_at = ? WHERE id = ? AND updated_at = ?`)
      .bind(JSON.stringify(timelineState), updatedAt, id, expectedUpdatedAt).run();
    return result.meta?.changes ? this.getWindow(id) : null;
  }

  async deleteWindow(id: string): Promise<boolean> {
    const results = await this.db.batch([
      this.db.prepare(`DELETE FROM desk_floors WHERE window_id = ?`).bind(id),
      this.db.prepare(`DELETE FROM desk_windows WHERE id = ?`).bind(id),
    ]);
    return !!results[1]?.meta?.changes;
  }

  async listFloors(windowId: string): Promise<DeskFloor[]> {
    const result = await this.db.prepare(
      `SELECT * FROM desk_floors WHERE window_id = ? ORDER BY created_at ASC, id ASC`,
    ).bind(windowId).all<any>();
    return (result.results || []).map(floorFromRow);
  }

  async getFloor(id: string): Promise<DeskFloor | null> {
    const row = await this.db.prepare(`SELECT * FROM desk_floors WHERE id = ?`).bind(id).first<any>();
    return row ? floorFromRow(row) : null;
  }

  async createFloor(value: DeskFloor): Promise<void> {
    if (!value.variants.length || value.activeVariant < 0 || value.activeVariant >= value.variants.length
      || value.content !== value.variants[value.activeVariant]) {
      throw new Error('desk floor content must match its active variant');
    }
    await this.db.prepare(
      `INSERT INTO desk_floors
       (id, window_id, role, content, variants, active_variant, thinking, report, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM desk_windows WHERE id = ?)`,
    ).bind(
      value.id, value.windowId, value.role, value.content, JSON.stringify(value.variants),
      value.activeVariant, value.thinking, value.report == null ? null : JSON.stringify(value.report),
      value.createdAt, value.windowId,
    ).run().then((result) => {
      if (!result.meta?.changes) throw new Error('desk window not found');
    });
  }

  async updateFloor(id: string, patch: Partial<Omit<DeskFloor, 'id' | 'windowId' | 'createdAt'>>): Promise<DeskFloor | null> {
    const snapshot = await this.db.prepare(
      `SELECT * FROM desk_floors WHERE id = ?`,
    ).bind(id).first<any>();
    if (!snapshot) return null;

    const current = floorFromRow(snapshot);
    const next = { ...current, ...patch };
    if (!next.variants.length || next.activeVariant < 0 || next.activeVariant >= next.variants.length) return null;
    if (next.content !== next.variants[next.activeVariant]) return null;

    const columns: Array<[keyof typeof patch, string, (value: any) => unknown]> = [
      ['role', 'role', (value) => value], ['content', 'content', (value) => value],
      ['variants', 'variants', JSON.stringify], ['activeVariant', 'active_variant', (value) => value],
      ['thinking', 'thinking', (value) => value],
      ['report', 'report', (value) => value == null ? null : JSON.stringify(value)],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column, encode] of columns) {
      if (patch[key] !== undefined) { sets.push(`${column} = ?`); values.push(encode(patch[key])); }
    }
    if (!sets.length) return this.getFloor(id);
    const result = await this.db.prepare(
      `UPDATE desk_floors SET ${sets.join(', ')}
       WHERE id = ? AND role = ? AND content = ? AND variants = ? AND active_variant = ?
         AND thinking IS ? AND report IS ?`,
    ).bind(
      ...values, id, snapshot.role, snapshot.content, snapshot.variants, snapshot.active_variant,
      snapshot.thinking, snapshot.report,
    ).run();
    return result.meta?.changes ? this.getFloor(id) : null;
  }

  async truncateFloors(windowId: string, anchorId: string, inclusive: boolean): Promise<number | null> {
    const comparison = inclusive
      ? `(created_at > anchor_at OR (created_at = anchor_at AND id >= ?))`
      : `(created_at > anchor_at OR (created_at = anchor_at AND id > ?))`;
    const results = await this.db.batch([
      this.db.prepare(`SELECT 1 FROM desk_floors WHERE id = ? AND window_id = ?`).bind(anchorId, windowId),
      this.db.prepare(
        `DELETE FROM desk_floors
         WHERE window_id = ?
           AND EXISTS (SELECT 1 FROM desk_floors anchor WHERE anchor.id = ? AND anchor.window_id = ?)
           AND ${comparison.replaceAll('anchor_at', `(SELECT created_at FROM desk_floors WHERE id = ? AND window_id = ?)`)} `,
      ).bind(windowId, anchorId, windowId, anchorId, windowId, anchorId, windowId, anchorId),
    ]);
    const exists = Array.isArray((results[0] as any)?.results) && (results[0] as any).results.length > 0;
    return exists ? Number(results[1]?.meta?.changes || 0) : null;
  }
}
