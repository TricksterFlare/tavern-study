// Pure helpers for the desk auto-timeline fold decision, mirrored from the production
// desk-timeline module so TavernStudyHost.foldDeskTimeline can share the exact same batch
// selection semantics without depending on any storage/model transport.

// Summarization must never end on a dangling user turn (a request the assistant has not yet
// answered): trim the candidate batch back to the last assistant floor it contains. Orphaned
// leading user floors ahead of that point still count (see production comment this mirrors) —
// they are folded together with the assistant floor that answers them.
export function selectDeskTimelineFoldBatch<T extends { role?: unknown }>(candidate: T[]): T[] {
  let lastSafe = -1;
  for (let index = 0; index < candidate.length; index++) {
    const role = candidate[index]?.role;
    if (role === 'assistant') { lastSafe = index; continue; }
    if (role === 'user') continue;
    break;
  }
  return lastSafe >= 0 ? candidate.slice(0, lastSafe + 1) : [];
}

// Timeline summaries are built only from assistant prose, not from the reader's own input
// (which reads more like a director's note than in-world narration). This strips a leading
// wrapper tag and trims a trailing standalone closing tag when present; content in the middle
// of the text is left untouched.
export function extractAssistantFoldBody(raw: unknown): string {
  let text = String(raw ?? '');
  const closes = [...text.matchAll(/^[ \t]*<\/content>[ \t]*$/gm)];
  const trailingClose = closes.filter((match) => !text.slice((match.index ?? 0) + match[0].length).trim()).at(-1);
  if (trailingClose?.index != null) text = text.slice(0, trailingClose.index);
  const leading = text.match(/^(\s*)<content>(?:\r?\n)?/);
  if (leading) text = leading[1] + text.slice(leading[0].length);
  return text.trimEnd();
}
