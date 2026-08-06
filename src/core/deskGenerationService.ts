import type { DeskTurnCommit, DeskTurnStorage } from './storage.ts';
import type { DeskFloor } from './types.ts';
import type { ModelBackend, ModelStreamEvent } from './modelBackend.ts';
import { parseStateBoard } from './stateBoard.ts';

function unwrapContentTag(text: string): string {
  let value = String(text || ''); const open = '<content>'; const close = '</content>';
  if (value.trim().startsWith(open)) { const lead = value.length - value.trimStart().length; let cut = lead + open.length; if (value.startsWith('\r\n', cut)) cut += 2; else if (value.startsWith('\n', cut)) cut++; value = value.slice(0, lead) + value.slice(cut); }
  if (value.trim().endsWith(close)) { const trail = value.length - value.trimEnd().length; const end = value.length - trail; let cut = end - close.length; if (value.slice(0, cut).endsWith('\r\n')) cut -= 2; else if (value.slice(0, cut).endsWith('\n')) cut--; value = value.slice(0, cut) + value.slice(end); }
  return value;
}

export interface GenerateDeskTurnInput {
  windowId: string;
  mode: 'normal' | 'roll';
  floorId: string;
  userFloor?: DeskFloor;
  expectedFloor?: DeskFloor;
  system: Array<{ text: string; cache: boolean }>;
  prompt: string;
  model: string;
  report: Record<string, unknown>;
  stateBoard: Record<string, unknown>;
  boardBeforeTrusted: boolean;
  committedAt: string;
  signal?: AbortSignal;
  onEvent?: (event: ModelStreamEvent) => void | Promise<void>;
}

export class DeskGenerationService {
  private readonly backend: ModelBackend; private readonly turns: DeskTurnStorage;
  constructor(backend: ModelBackend, turns: DeskTurnStorage) { this.backend = backend; this.turns = turns; }
  async generate(input: GenerateDeskTurnInput) {
    if (input.mode === 'roll' && !input.expectedFloor) return { success: false, error: 'Roll target is required.' };
    if (input.mode === 'normal' && !input.userFloor) return { success: false, error: 'User floor is required.' };
    if (input.signal?.aborted) return { success: false, error: 'aborted' };
    const generated = await this.backend.streamChat({ system: input.system, prompt: input.prompt, model: input.model, signal: input.signal, onEvent: input.onEvent });
    if (!generated.ok) return { success: false, error: generated.kind, detail: generated.detail, usage: generated.usage };
    if (input.signal?.aborted) return { success: false, error: 'aborted', usage: generated.usage };
    const parsed = parseStateBoard(generated.text);
    const stateBoard = parsed.board ?? input.stateBoard;
    const content = unwrapContentTag(parsed.content);
    if (!content.trim()) return { success: false, error: 'empty', usage: generated.usage };
    const { boardBefore: _boardBefore, boardAfter: _boardAfter, stateBoardStale: _stateBoardStale, commitToken: _commitToken, ...safeReport } = input.report;
    const commit: DeskTurnCommit = { content, thinking: generated.thinking.trim() || null,
      report: { ...safeReport, stateBoardStale: parsed.board === null,
        ...(input.boardBeforeTrusted ? { boardBefore: input.stateBoard } : {}), boardAfter: stateBoard }, stateBoard,
      committedAt: input.committedAt };
    const floor = input.mode === 'normal'
      ? await this.turns.commitAssistantFloor(input.windowId, input.floorId, commit)
      : await this.turns.rollAssistantFloor({ windowId: input.windowId, floorId: input.floorId, expected: input.expectedFloor!, commit });
    return floor ? { success: true, floor, usage: generated.usage } : { success: false, error: 'conflict', usage: generated.usage };
  }
}
