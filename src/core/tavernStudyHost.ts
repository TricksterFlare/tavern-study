import type { ModelBackend } from './modelBackend.ts';
import type { SemanticSearchAdapter, StorageAdapter } from './storage.ts';
import { ReadingService } from './readingService.ts';
import { StudyService } from './studyService.ts';
import { DeskService } from './deskService.ts';
import { DeskGenerationService } from './deskGenerationService.ts';
import { assembleDesk } from '../chat/deskAssemble.ts';
import type { DeskAssetPack } from './storage.ts';
import { parseStateBoard } from './stateBoard.ts';
import { extractAssistantFoldBody, selectDeskTimelineFoldBatch } from './deskTimelineFold.ts';
import { DESK_TIMELINE_KEEP } from './deskLimits.ts';

// Auto-fold only kicks in once the un-folded tail grows past this many floors; a single call
// folds at most BATCH_MAX of them, always leaving DESK_TIMELINE_KEEP floors of raw text behind.
const DESK_TIMELINE_TRIGGER = 20;
const DESK_TIMELINE_BATCH_MAX = 16;
const DESK_TIMELINE_SEG_CAP = 20;

// State board manual refresh: recompute the board from the last (assistant) floor's final text.
// Draft only — the caller decides whether to persist it via updateWindow.
const BOARD_REFRESH_SYSTEM =
  `You maintain the "state board" for a serialized story: your output is JSON recording objective facts only, not prose.

The input has two parts:
[Current state board] the state saved on the last turn
[Latest text] the final text of this floor; if it was hand-edited, that edited text is authoritative.

Regenerate the state board, following these rules strictly:
1. Only change fields the [Latest text] explicitly supports. Fields it does not mention keep their [Current state board] value exactly — never clear, delete, or invent a value for them.
2. The set of fields is fixed: do not add keys the current board does not have, do not drop any existing key, and do not change a field's data type.
3. "Present characters" lists only who is physically in the scene this floor; someone merely mentioned, recalled, or quoted does not count.
4. If an "open threads" field exists: add new threads planted this floor, remove threads that are resolved or no longer relevant, never re-add a thread already present, cap it at 7 entries (merge similar ones and keep the most important when over the cap, even if the latest text says nothing about threads). Distinguish a planned-but-unexecuted action from something that already happened. If this field does not exist, do not create it.
5. Record facts only — no speculation, no guessing at future plot, no details the text does not support. When information can't be confirmed, keep the current board's value.

Output format:
Wrap the JSON in a \`\`\`stateboard fence. The fence must be the very end of the reply — no text before or after it.`;

function boardShapeOf(value: unknown): 'array' | 'object' | 'scalar' {
  return Array.isArray(value) ? 'array' : value !== null && typeof value === 'object' ? 'object' : 'scalar';
}

export interface TavernStudyHostOptions {
  storage: StorageAdapter;
  model: ModelBackend;
  semantic?: SemanticSearchAdapter;
  defaultModel?: string;
}

export class TavernStudyHost {
  readonly reading: ReadingService;
  readonly study: StudyService;
  readonly desk: DeskService;
  private readonly storage: StorageAdapter;
  private readonly generation: DeskGenerationService;
  private readonly model: ModelBackend;
  private readonly semantic?: SemanticSearchAdapter;
  private readonly defaultModel: string;
  private readonly windowQueues = new Map<string, Promise<void>>();
  private readonly requestResults = new Map<string, { fingerprint: string; result: Promise<any> }>();
  private readonly timelineResults = new Map<string, { fingerprint: string; result: Promise<any> }>();

  constructor(options: TavernStudyHostOptions) {
    this.storage = options.storage;
    this.semantic = options.semantic;
    this.defaultModel = options.defaultModel || 'default';
    this.model = options.model;
    this.reading = new ReadingService(options.storage.reading);
    this.study = new StudyService(options.storage.study, options.semantic);
    this.desk = new DeskService(options.storage.desk);
    this.generation = new DeskGenerationService(options.model, options.storage.deskTurn);
  }

  async importDeskAssetPack(pack: DeskAssetPack) {
    if (!pack || typeof pack !== 'object' || typeof pack.project !== 'string' || !pack.project.trim() || pack.project.length > 100 || typeof pack.name !== 'string' || !pack.name.trim() || pack.name.length > 200) return { success: false, error: 'project and name are required.' };
    const recipe = pack.recipe;
    if (!recipe || typeof recipe.id !== 'string' || !recipe.id.trim() || recipe.id.length > 100 || typeof recipe.presetId !== 'string' || !recipe.presetId.trim() || recipe.presetId.length > 100 || !['light', 'heavy'].includes(recipe.weight)
      || !recipe.overrides || typeof recipe.overrides !== 'object' || Array.isArray(recipe.overrides) || !Array.isArray(recipe.regexIds) || recipe.regexIds.some((id) => typeof id !== 'string') || typeof recipe.lightSystem !== 'string' || recipe.lightSystem.length > 200000) return { success: false, error: 'invalid recipe.' };
    if (!Array.isArray(pack.blocks) || !Array.isArray(pack.regex) || pack.blocks.length > 500 || pack.regex.length > 500) return { success: false, error: 'invalid asset arrays.' };
    const blockIds = pack.blocks.map((block) => block?.identifier);
    if (blockIds.some((id) => typeof id !== 'string' || !id || id.length > 100) || new Set(blockIds).size !== blockIds.length
      || pack.blocks.some((block) => typeof block.name !== 'string' || block.name.length > 200 || !['system', 'user', 'assistant'].includes(block.role) || typeof block.content !== 'string' || block.content.length > 200000 || typeof block.marker !== 'boolean' || (block.queuePos !== null && !Number.isInteger(block.queuePos)) || typeof block.enabledDefault !== 'boolean')) return { success: false, error: 'block identifiers must be unique.' };
    const regexIds = pack.regex.map((rule) => rule?.id);
    if (regexIds.some((id) => typeof id !== 'string' || !id || id.length > 100) || new Set(regexIds).size !== regexIds.length || recipe.regexIds.some((id) => !regexIds.includes(id))
      || pack.regex.some((rule) => typeof rule.find !== 'string' || rule.find.length > 10000 || typeof rule.replace !== 'string' || rule.replace.length > 10000 || typeof rule.flags !== 'string' || rule.flags.length > 20 || !['up', 'down', 'both'].includes(rule.direction) || !rule.meta || typeof rule.meta !== 'object' || Array.isArray(rule.meta))) return { success: false, error: 'regex ids are invalid.' };
    try { await this.storage.deskAssets.importPack(structuredClone({ ...pack, project: pack.project.trim(), name: pack.name.trim() })); }
    catch { return { success: false, error: 'asset_import_conflict' }; }
    return { success: true, recipe_id: recipe.id, preset_id: recipe.presetId, blocks: pack.blocks.length, regex: pack.regex.length };
  }

  async foldDeskTimeline(input: { windowId: string; model?: string; force?: boolean; keep?: number; requestId?: string; requestScope?: string; signal?: AbortSignal }) {
    const key = input.requestId ? `${input.requestScope || ''}\u0000${input.windowId}\u0000${input.requestId}` : '';
    const fingerprint = JSON.stringify([input.model || this.defaultModel, !!input.force, input.keep ?? null]); const cached = key ? this.timelineResults.get(key) : undefined;
    if (cached) return cached.fingerprint === fingerprint ? cached.result : { success: false, error: 'idempotency_conflict' };
    const result = this.withWindowLock(input.windowId, async () => {
      const window = await this.storage.desk.getWindow(input.windowId); if (!window) return { success: false, error: 'Desk window not found.' };
      const keep = Number.isInteger(input.keep) && (input.keep as number) >= 0 ? (input.keep as number) : DESK_TIMELINE_KEEP;
      const floors = await this.storage.desk.listFloors(window.id);
      const raw = window.timelineState && typeof window.timelineState === 'object' ? window.timelineState as any : {};
      const cutoff = typeof raw.cutoff === 'string' ? raw.cutoff : null;
      const afterCutoff = floors.filter((floor) => !cutoff || `${floor.createdAt}|${floor.id}` > cutoff);
      if (!input.force && afterCutoff.length <= DESK_TIMELINE_TRIGGER) return { success: true, acted: false, reason: 'not_enough_floors' };
      const candidate = afterCutoff.slice(0, Math.min(Math.max(0, afterCutoff.length - keep), DESK_TIMELINE_BATCH_MAX));
      if (candidate.length === 0) return { success: true, acted: false, reason: 'nothing_to_fold' };
      const toFold = selectDeskTimelineFoldBatch(candidate);
      if (toFold.length === 0) return { success: true, acted: false, reason: 'unpaired_user' };
      const lines = toFold
        .filter((floor) => floor.role === 'assistant')
        .map((floor) => extractAssistantFoldBody(floor.content))
        .filter((text) => text.trim())
        .join('\n\n');
      if (!lines.trim()) return { success: false, error: 'no_assistant_text' };
      const snapshot = JSON.stringify(floors.map((floor) => [floor.id, floor.content, floor.activeVariant, floor.createdAt]));
      const priorSeg = Array.isArray(raw.segs) && raw.segs.length ? raw.segs[raw.segs.length - 1] : null;
      const prompt = (priorSeg && typeof priorSeg.text === 'string'
        ? `[Prior timeline segment | reference only, do not restate]\n${priorSeg.text}\n\n`
        : '') + `[This batch's floors | sole source for the summary]\n${lines}`;
      const generated = await this.model.streamChat({ system: [{ text: 'Summarize the supplied story floors faithfully as flowing prose, distinguishing objective fact from character perception. Keep it to roughly 500 words. Return summary prose only.', cache: false }], prompt, model: input.model || this.defaultModel, signal: input.signal });
      if (!generated.ok || !generated.text.trim()) return { success: false, error: generated.ok ? 'empty' : generated.kind };
      const current = await this.storage.desk.listFloors(window.id);
      if (JSON.stringify(current.map((floor) => [floor.id, floor.content, floor.activeVariant, floor.createdAt])) !== snapshot) return { success: false, error: 'conflict' };
      const lastFold = toFold[toFold.length - 1];
      const upto = `${lastFold.createdAt}|${lastFold.id}`;
      const segs = Array.isArray(raw.segs) ? raw.segs.filter((seg: any) => seg && typeof seg.text === 'string' && typeof seg.upto === 'string').slice(-(DESK_TIMELINE_SEG_CAP - 1)) : [];
      segs.push({ text: generated.text.trim().slice(0, 10000), upto });
      const previousTime = Date.parse(window.updatedAt);
      const updatedAt = new Date(Math.max(Date.now(), (Number.isFinite(previousTime) ? previousTime : 0) + 1)).toISOString();
      const updated = await this.storage.desk.updateTimelineState(window.id, window.updatedAt, { segs, cutoff: upto, rev: (Number.isInteger(raw.rev) ? raw.rev : 0) + 1 }, updatedAt);
      if (!updated) return { success: false, error: 'conflict' };
      const remaining = afterCutoff.length - toFold.length;
      return { success: true, acted: true, folded: toFold.length, remaining, more: remaining > keep, timelineState: updated.timelineState, usage: generated.usage };
    });
    if (key) this.timelineResults.set(key, { fingerprint, result });
    return result;
  }

  // Manual state-board refresh: recompute the board from the last (assistant) floor's final
  // text. Returns a draft only — it never writes to storage. The caller decides whether to
  // persist it (e.g. via desk.updateWindow), matching the "no save button, no write" house rule.
  async refreshDeskBoard(input: { windowId: string; model?: string; signal?: AbortSignal }) {
    const window = await this.storage.desk.getWindow(input.windowId);
    if (!window) return { success: false, error: 'Desk window not found.' };
    const floors = await this.storage.desk.listFloors(window.id);
    const floor = floors.at(-1);
    if (!floor) return { success: false, error: 'Desk window has no floors yet.' };
    if (floor.role !== 'assistant') return { success: false, error: 'Last floor was not written by the assistant; refresh only recomputes from a generated floor.' };
    const content = String(floor.content || '').trim();
    if (!content) return { success: false, error: 'Last floor is empty; nothing to refresh from.' };
    const board = window.stateBoard;
    if (!board || typeof board !== 'object' || Array.isArray(board)) return { success: false, error: 'Current state board is not an object; fix it before refreshing.' };
    const beforeKeys = Object.keys(board);
    if (beforeKeys.length === 0) return { success: false, error: 'Current state board is empty; refresh only updates existing keys.' };
    // Structural anti-spoofing only (this is the writer's own text, not untrusted input): swap
    // any literal occurrence of the delimiter tag for its full-width lookalike so story text
    // cannot pretend to close the wrapper early.
    const safeContent = content.replace(/<latest_text>/g, '＜latest_text＞').replace(/<\/latest_text>/g, '＜/latest_text＞');
    const prompt = `[Current state board]\n${JSON.stringify(board, null, 2)}\n\n[Latest text]\n<latest_text>\n${safeContent}\n</latest_text>`;
    const generated = await this.model.streamChat({ system: [{ text: BOARD_REFRESH_SYSTEM, cache: false }], prompt, model: input.model || this.defaultModel, signal: input.signal });
    if (!generated.ok) return { success: false, error: generated.kind, usage: generated.usage };
    const { board: nextBoard } = parseStateBoard(generated.text);
    if (!nextBoard) return { success: false, error: 'model_did_not_return_stateboard', usage: generated.usage };
    // parseStateBoard only guarantees object shape and the byte cap; the field-protocol
    // constraints from the system prompt above are enforced here, not trusted from the model.
    const afterKeys = Object.keys(nextBoard);
    const missing = beforeKeys.filter((k) => !Object.prototype.hasOwnProperty.call(nextBoard, k));
    if (missing.length) return { success: false, error: `missing_keys:${missing.join(',')}`, usage: generated.usage };
    const added = afterKeys.filter((k) => !Object.prototype.hasOwnProperty.call(board, k));
    if (added.length) return { success: false, error: `added_keys:${added.join(',')}`, usage: generated.usage };
    const drifted = beforeKeys.filter((k) => boardShapeOf((board as any)[k]) !== boardShapeOf((nextBoard as any)[k]));
    if (drifted.length) return { success: false, error: `drifted_keys:${drifted.join(',')}`, usage: generated.usage };
    return { success: true, board: nextBoard, floorId: floor.id, usage: generated.usage };
  }

  async generateDeskTurn(input: { windowId: string; content?: string; roll?: boolean; model?: string; requestId?: string; requestScope?: string; signal?: AbortSignal }) {
    if (input.requestId && (typeof input.requestId !== 'string' || input.requestId.length > 100)) return { success: false, error: 'requestId must contain at most 100 characters.' };
    const key = input.requestId ? `${input.requestScope || ''}\u0000${input.windowId}\u0000${input.requestId}` : '';
    const fingerprint = JSON.stringify([input.content ?? null, !!input.roll, input.model || this.defaultModel]);
    const cached = key ? this.requestResults.get(key) : undefined;
    if (cached) return cached.fingerprint === fingerprint ? cached.result : { success: false, error: 'idempotency_conflict' };
    const operation = this.withWindowLock(input.windowId, () => this.generateDeskTurnLocked(input));
    if (key) {
      this.requestResults.set(key, { fingerprint, result: operation });
      if (this.requestResults.size > 1000) this.requestResults.delete(this.requestResults.keys().next().value!);
    }
    return operation;
  }

  private async generateDeskTurnLocked(input: { windowId: string; content?: string; roll?: boolean; model?: string; signal?: AbortSignal }) {
    const window = await this.storage.desk.getWindow(input.windowId);
    if (!window) return { success: false, error: 'Desk window not found.' };
    const roll = !!input.roll;
    if (!roll && (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 200000)) return { success: false, error: 'content must contain 1-200000 characters.' };
    const recipe = await this.storage.deskAssets.getRecipe(window.recipeId);
    if (!recipe || !await this.storage.deskAssets.hasPreset(recipe.presetId)) return { success: false, error: 'Desk recipe or preset was not found.' };
    const floors = await this.storage.desk.listFloors(window.id);
    const timeline = window.timelineState && typeof window.timelineState === 'object' ? window.timelineState as any : {};
    const cutoff = typeof timeline.cutoff === 'string' ? timeline.cutoff : null;
    const visibleFloors = cutoff ? floors.filter((floor) => `${floor.createdAt}|${floor.id}` > cutoff) : floors;
    const timelineText = Array.isArray(timeline.segs) ? timeline.segs.filter((seg: any) => seg && typeof seg.text === 'string' && typeof seg.upto === 'string').map((seg: any) => seg.text).join('\n\n') : '';
    const after = (timestamp?: string) => { const parsed = timestamp ? Date.parse(timestamp) : 0; return new Date(Math.max(Date.now(), (Number.isFinite(parsed) ? parsed : 0) + 1)).toISOString(); };

    if (!roll) {
      const content = input.content as string;
      const userFloor = { id: `floor_${crypto.randomUUID()}`, windowId: window.id, role: 'user' as const, content, variants: [content], activeVariant: 0, thinking: null, report: null, createdAt: after(floors.at(-1)?.createdAt) };
      await this.storage.desk.createFloor(userFloor);
      const assembled = await assembleDesk({
        deskAssets: this.storage.deskAssets,
        deskStory: this.storage.deskStory,
        semantic: this.semantic,
      }, {
        project: window.project,
        recipeId: window.recipeId,
        input: content,
        floors: visibleFloors.map((floor) => ({ role: floor.role, content: floor.content })),
        note: window.note,
        noteDepth: window.noteDepth,
        stateBoard: window.stateBoard,
        vars: Object.fromEntries(Object.entries(window.vars).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        timeline: timelineText,
      });
      if (!assembled.success) return { ...assembled, userFloorCommitted: userFloor };
      let generated: any;
      try { generated = await this.generation.generate({
        windowId: window.id,
        mode: 'normal',
        floorId: `floor_${crypto.randomUUID()}`,
        userFloor,
        system: assembled.system,
        prompt: assembled.tail,
        model: input.model || this.defaultModel,
        report: assembled.report,
        stateBoard: window.stateBoard,
        boardBeforeTrusted: true,
        committedAt: after(userFloor.createdAt),
        signal: input.signal,
      }); } catch { return { success: false, error: 'model_failure', userFloorCommitted: userFloor }; }
      if (generated.success) return { ...generated, userFloor };
      const { detail: _privateDetail, ...publicFailure } = generated;
      return { ...publicFailure, userFloorCommitted: userFloor };
    }

    // Roll: re-generate the last floor in place. It must be the assistant's own reply — a
    // fresh reader message has nothing to reroll yet.
    const target = floors.at(-1);
    if (!target || target.role !== 'assistant') return { success: false, error: 'Roll target must be the last assistant floor.' };
    const beforeTarget = visibleFloors.filter((floor) => floor.id !== target.id);

    // The board actually in effect when the target floor was first assembled is the only
    // trustworthy snapshot to regenerate from — the window's current board would silently
    // replay whatever has happened *since* that floor. Prefer the floor's own recorded
    // boardBefore; older floors that predate that field fall back to scanning backwards for
    // the nearest assistant floor's boardAfter, stopping at the first floor missing the field.
    let rollStateBoard: Record<string, unknown> | null = null;
    let foundRollBoard = false;
    const targetReport = target.report;
    const targetBoardBefore = targetReport && typeof targetReport === 'object' && !Array.isArray(targetReport) ? (targetReport as any).boardBefore : undefined;
    if (targetBoardBefore && typeof targetBoardBefore === 'object' && !Array.isArray(targetBoardBefore)) {
      rollStateBoard = targetBoardBefore; foundRollBoard = true;
    } else {
      for (let index = beforeTarget.length - 1; index >= 0; index--) {
        const floor = beforeTarget[index];
        if (floor.role !== 'assistant') continue;
        const report = floor.report;
        if (!report || typeof report !== 'object' || Array.isArray(report) || !Object.prototype.hasOwnProperty.call(report, 'boardAfter')) break;
        const boardAfter = (report as any).boardAfter;
        if (boardAfter && typeof boardAfter === 'object' && !Array.isArray(boardAfter)) { rollStateBoard = boardAfter; foundRollBoard = true; break; }
      }
    }
    let history = beforeTarget;
    let rollInput = '';
    if (beforeTarget.length && beforeTarget[beforeTarget.length - 1].role === 'user') {
      rollInput = beforeTarget[beforeTarget.length - 1].content;
      history = beforeTarget.slice(0, -1);
    }
    const effectiveStateBoard: Record<string, unknown> = foundRollBoard ? (rollStateBoard as Record<string, unknown>) : window.stateBoard;

    const assembled = await assembleDesk({
      deskAssets: this.storage.deskAssets,
      deskStory: this.storage.deskStory,
      semantic: this.semantic,
    }, {
      project: window.project,
      recipeId: window.recipeId,
      input: rollInput,
      floors: history.map((floor) => ({ role: floor.role, content: floor.content })),
      note: window.note,
      noteDepth: window.noteDepth,
      stateBoard: effectiveStateBoard,
      vars: Object.fromEntries(Object.entries(window.vars).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      timeline: timelineText,
    });
    if (!assembled.success) return assembled;
    let rolled: any;
    try { rolled = await this.generation.generate({
      windowId: window.id,
      mode: 'roll',
      floorId: target.id,
      expectedFloor: target,
      system: assembled.system,
      prompt: assembled.tail,
      model: input.model || this.defaultModel,
      report: assembled.report,
      stateBoard: effectiveStateBoard,
      boardBeforeTrusted: foundRollBoard,
      committedAt: after(target.createdAt),
      signal: input.signal,
    }); } catch { return { success: false, error: 'model_failure' }; }
    if (rolled.success) return rolled;
    const { detail: _rollPrivateDetail, ...rollPublicFailure } = rolled;
    return rollPublicFailure;
  }

  private async withWindowLock<T>(windowId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.windowQueues.get(windowId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.windowQueues.set(windowId, queued);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.windowQueues.get(windowId) === queued) this.windowQueues.delete(windowId);
    }
  }
}
