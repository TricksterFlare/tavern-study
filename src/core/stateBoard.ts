const STATEBOARD_FENCE_RE = /```stateboard\s*\n?([\s\S]*?)```/g;

export const STATEBOARD_MAX_BYTES = 8192;

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
