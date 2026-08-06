import type { DeskStorage } from './storage.ts';
import type { DeskFloor, DeskWindow } from './types.ts';

const MAX_CONTENT = 200_000;
function clean(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { output += value[index] + value[++index]; continue; }
      output += '\uFFFD'; continue;
    }
    output += unit >= 0xDC00 && unit <= 0xDFFF ? '\uFFFD' : value[index];
  }
  return output;
}

export class DeskService {
  private readonly storage: DeskStorage;
  constructor(storage: DeskStorage) { this.storage = storage; }

  async createWindow(input: { project?: string; title?: string; recipeId?: string }) {
    if (!input?.project?.trim() || !input?.title?.trim() || !input?.recipeId?.trim()) return { success: false, error: 'project, title, and recipeId are required.' };
    const now = new Date().toISOString();
    const window: DeskWindow = { id: `win_${crypto.randomUUID()}`, project: input.project.trim(), title: input.title.trim(), recipeId: input.recipeId.trim(), note: '', noteDepth: 3, stateBoard: {}, timelineState: {}, vars: {}, createdAt: now, updatedAt: now };
    await this.storage.createWindow(window);
    return { success: true, window };
  }

  async getWindow(id: string) {
    const window = await this.storage.getWindow(id);
    if (!window) return { success: false, error: 'Desk window not found.' };
    return { success: true, window, floors: await this.storage.listFloors(id) };
  }

  async appendFloor(windowId: string, input: { role?: DeskFloor['role']; content?: string; variants?: string[]; thinking?: string | null; report?: Record<string, unknown> | null; createdAt?: string }) {
    if (!await this.storage.getWindow(windowId)) return { success: false, error: 'Desk window not found.' };
    if (!['user', 'assistant'].includes(input.role || '')) return { success: false, error: 'role must be user or assistant.' };
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > MAX_CONTENT) return { success: false, error: 'content must contain 1-200000 characters.' };
    const content = clean(input.content);
    const variants = input.variants?.map(clean) || [content];
    if (!variants.length || variants.some((v) => !v.trim() || v.length > MAX_CONTENT)) return { success: false, error: 'variants must contain non-empty texts.' };
    let activeVariant = variants.indexOf(content);
    if (activeVariant < 0) { variants.push(content); activeVariant = variants.length - 1; }
    const floor: DeskFloor = { id: `floor_${crypto.randomUUID()}`, windowId, role: input.role!, content, variants, activeVariant, thinking: input.thinking ?? null, report: input.report ?? null, createdAt: input.createdAt || new Date().toISOString() };
    await this.storage.createFloor(floor);
    await this.storage.updateWindow(windowId, { updatedAt: floor.createdAt });
    return { success: true, floor };
  }

  async editFloor(id: string, contentInput: string) {
    const floor = await this.storage.getFloor(id);
    if (!floor) return { success: false, error: 'Desk floor not found.' };
    if (typeof contentInput !== 'string' || !contentInput.trim() || contentInput.length > MAX_CONTENT) return { success: false, error: 'content must contain 1-200000 characters.' };
    const content = clean(contentInput); const variants = [...floor.variants]; variants[floor.activeVariant] = content;
    const updated = await this.storage.updateFloor(id, { content, variants });
    if (!updated) return { success: false, error: 'Desk floor changed concurrently. Reload and try again.' };
    return { success: true, floor: updated };
  }

  async switchVariant(id: string, index: number) {
    const floor = await this.storage.getFloor(id);
    if (!floor) return { success: false, error: 'Desk floor not found.' };
    if (!Number.isInteger(index) || index < 0 || index >= floor.variants.length) return { success: false, error: 'Variant index is out of range.' };
    const updated = await this.storage.updateFloor(id, { activeVariant: index, content: floor.variants[index] });
    if (!updated) return { success: false, error: 'Desk floor changed concurrently. Reload and try again.' };
    return { success: true, floor: updated };
  }

  async truncate(windowId: string, anchorId: string, inclusive = false) {
    const deleted = await this.storage.truncateFloors(windowId, anchorId, inclusive);
    if (deleted === null) return { success: false, error: 'Anchor floor was not found in this window.' };
    return { success: true, deleted };
  }
}
