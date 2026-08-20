const STATEBOARD_FENCE_RE = /```stateboard\s*\n?([\s\S]*?)```/g;

export const STATEBOARD_MAX_BYTES = 8192;

// Protocol keys pinned by STATEBOARD_INSTRUCTION (chat/deskAssemble.ts) and mirrored by the
// frontend board editor's placeholder list — the three lists must stay identical.
export const STATE_BOARD_PROTOCOL_KEYS = ['在场角色', '衣装', '位置', '关系', '时间地点'];

// Write-path protocol gate, called before a generated board is committed (chat/desk.ts
// finalizeDeskTurn and core/deskGenerationService.ts). It validates the TARGET shape the
// instruction demands — never old-vs-new consistency — so it does not block the legacy
// flat-string → keyed-object migration; it forces it. Division of labor with the refresh
// gate (tavernStudyHost.refreshDeskBoard / chat/deskBoardRefresh.ts): that one guards the
// refresh button (same-shape-as-before), this one guards floor commits (target shape).
//
// Rejection rules, any hit discards the whole board (caller keeps the old board + stale flag):
//   - missing keys: the five protocol keys ∪ every key of the input board. Losing an input key
//     is the one silently-irreversible failure ("未收伏笔" can never come back once dropped,
//     because the instruction forbids inventing it). Requiring the protocol five even on an
//     empty baseline closes the `{}`-passes-`{}` bootstrap hole.
//   - target shapes, checked down to sub-values (a well-shaped container full of null/nested
//     junk would poison the baseline just the same): 在场角色 = array of strings; 衣装/关系 and,
//     when present, 未收伏笔 = plain objects whose own values are all strings; 位置/时间地点 =
//     strings.
//   - extra keys are allowed and unchecked: user-added custom keys are a legitimate feature.
//   - the 7-entry cap on 未收伏笔 is deliberately NOT enforced here: an oversized board is a
//     curation problem, not a broken shape — rejecting it would discard good data.
export function stateBoardGateErrors(input: Record<string, unknown>, out: Record<string, unknown>): string[] {
  const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const isPlainObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const errs: string[] = [];
  const required = new Set<string>([...STATE_BOARD_PROTOCOL_KEYS, ...Object.keys(input)]);
  for (const k of required) if (!has(out, k)) errs.push(`缺键「${k}」`);
  if (has(out, '在场角色')) {
    const v = out['在场角色'];
    if (!Array.isArray(v)) errs.push('「在场角色」不是数组');
    else if (!v.every((x) => typeof x === 'string')) errs.push('「在场角色」里混了非字符串元素');
  }
  for (const k of ['衣装', '关系', '未收伏笔']) {
    if (!has(out, k)) continue;
    const v = out[k];
    const label = k === '未收伏笔' ? '按线索分键的对象' : '按人分键的对象';
    if (!isPlainObj(v)) errs.push(`「${k}」不是${label}`);
    else if (!Object.keys(v).every((sk) => typeof v[sk] === 'string')) errs.push(`「${k}」里有子值不是一句话字符串`);
  }
  for (const k of ['位置', '时间地点']) if (has(out, k) && typeof out[k] !== 'string') errs.push(`「${k}」不是单句字符串`);
  return errs;
}

export interface ParsedStateBoard {
  content: string;
  board: Record<string, unknown> | null;
}

export function parseStateBoard(fullText: string): ParsedStateBoard {
  const text = String(fullText || '');
  STATEBOARD_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = STATEBOARD_FENCE_RE.exec(text))) last = match;

  const lastOpen = text.lastIndexOf('```stateboard');
  const afterLastOpen = text.slice(lastOpen + '```stateboard'.length);
  const taggedClose = !!last
    && lastOpen === last.index + last[0].length - 3
    && afterLastOpen.trim() === '';

  if (lastOpen >= 0 && !afterLastOpen.includes('```') && !taggedClose) {
    return { content: text.slice(0, lastOpen).trimEnd(), board: null };
  }
  if (!last) return { content: text, board: null };

  const afterFence = text.slice(last.index + last[0].length);
  if (afterFence.trim() !== '' && !taggedClose) return { content: text, board: null };

  const content = text.slice(0, last.index).trimEnd();
  try {
    const parsed: unknown = JSON.parse(last[1].trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { content, board: null };
    const bytes = new TextEncoder().encode(JSON.stringify(parsed)).length;
    return { content, board: bytes <= STATEBOARD_MAX_BYTES ? parsed as Record<string, unknown> : null };
  } catch {
    return { content, board: null };
  }
}
