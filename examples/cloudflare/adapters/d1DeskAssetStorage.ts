import type { DeskAssetPack, DeskAssetStorage } from '../../../src/core/storage.ts';
import type { DeskLore, DeskPromptBlock, DeskRecipe, DeskRegex } from '../../../src/core/types.ts';

function array(raw: unknown): string[] {
  try { const value = JSON.parse(String(raw || '[]')); return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []; }
  catch { return []; }
}
function object(raw: unknown): Record<string, any> {
  try { const value = JSON.parse(String(raw || '{}')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}

export class D1DeskAssetStorage implements DeskAssetStorage {
  private readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async getRecipe(id: string): Promise<DeskRecipe | null> {
    const row = await this.db.prepare(`SELECT id, preset_id, weight, overrides, regex_ids, light_system FROM desk_recipes WHERE id = ?`).bind(id).first<any>();
    return row ? { id: row.id, presetId: row.preset_id, weight: row.weight === 'light' ? 'light' : 'heavy', overrides: object(row.overrides), regexIds: array(row.regex_ids), lightSystem: row.light_system || '' } : null;
  }
  async hasPreset(id: string): Promise<boolean> { return !!await this.db.prepare(`SELECT 1 FROM desk_presets WHERE id = ?`).bind(id).first(); }
  async listRegex(ids: string[]): Promise<DeskRegex[]> {
    if (!ids.length) return [];
    const result = await this.db.prepare(`SELECT id, find, flags, replace, direction, meta FROM desk_regex WHERE id IN (${ids.map(() => '?').join(', ')}) AND enabled = 1 ORDER BY sort_order, id`).bind(...ids).all<any>();
    return (result.results || []).filter((row: any) => ['up', 'down', 'both'].includes(row.direction))
      .map((row: any) => ({ id: row.id, find: row.find, flags: row.flags, replace: row.replace, direction: row.direction, meta: object(row.meta) }));
  }
  async listQueueBlocks(presetId: string): Promise<DeskPromptBlock[]> {
    const result = await this.db.prepare(`SELECT identifier, name, role, content, marker, queue_pos, enabled_default FROM desk_blocks WHERE preset_id = ? AND in_queue = 1`).bind(presetId).all<any>();
    return (result.results || []).map((row: any) => ({ identifier: row.identifier, name: row.name, role: ['user', 'assistant'].includes(row.role) ? row.role : 'system', content: row.content || '', marker: !!row.marker, queuePos: row.queue_pos == null ? null : Number(row.queue_pos), enabledDefault: !!row.enabled_default }));
  }
  async listLore(project: string): Promise<DeskLore[]> {
    const result = await this.db.prepare(
      `SELECT id, title, content, lore_keys, lore_position, is_char, lore_constant, trigger_mode, lore_fields
       FROM memories WHERE project = ? AND category IN ('world', 'outline') AND lore_enabled = 1 ORDER BY id`,
    ).bind(project).all<any>();
    return (result.results || []).map((row: any) => ({
      id: row.id, name: row.title || '', content: row.content || '', keys: array(row.lore_keys),
      position: String(row.lore_position || ''), isCharacter: !!row.is_char, constant: !!row.lore_constant,
      triggerMode: row.trigger_mode === 'presence' ? 'presence' : 'scan', fields: object(row.lore_fields),
    }));
  }
  async importPack(pack: DeskAssetPack): Promise<void> {
    const now = new Date().toISOString();
    const statements = [
      this.db.prepare(`INSERT INTO desk_presets (id, name, raw_json, params, block_count, created_at) VALUES (?, ?, ?, '{}', ?, ?)`)
        .bind(pack.recipe.presetId, pack.name, JSON.stringify(pack), pack.blocks.length, now),
      ...pack.blocks.map((block) => this.db.prepare(`INSERT INTO desk_blocks (id, preset_id, identifier, name, role, content, marker, injection, in_queue, queue_pos, enabled_default) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)`)
        .bind(`block_${crypto.randomUUID()}`, pack.recipe.presetId, block.identifier, block.name, block.role, block.content, block.marker ? 1 : 0, block.queuePos, block.enabledDefault ? 1 : 0)),
      ...pack.regex.map((rule, index) => this.db.prepare(`INSERT INTO desk_regex (id, scope, preset_id, name, find, replace, flags, direction, enabled, meta, sort_order) VALUES (?, 'preset', ?, '', ?, ?, ?, ?, 1, ?, ?)`)
        .bind(rule.id, pack.recipe.presetId, rule.find, rule.replace, rule.flags, rule.direction, JSON.stringify(rule.meta), index)),
      this.db.prepare(`INSERT INTO desk_recipes (id, project, name, preset_id, weight, overrides, regex_ids, params, light_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`)
        .bind(pack.recipe.id, pack.project, pack.name, pack.recipe.presetId, pack.recipe.weight, JSON.stringify(pack.recipe.overrides), JSON.stringify(pack.recipe.regexIds), pack.recipe.lightSystem, now, now),
    ];
    await this.db.batch(statements);
  }
}
