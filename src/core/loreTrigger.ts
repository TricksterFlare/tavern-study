export interface LoreTriggerEntry {
  id: string;
  name: string;
  keys: string[];
}

export function buildLoreScanCorpus(
  input: string,
  floors: Array<{ content?: string | null }>,
  keep = 6,
): string {
  return [input, ...floors.slice(-keep).map((floor) => floor.content || '')].join('\n');
}

export function extractAtMentions(input: string): string[] {
  const mentions: string[] = [];
  const pattern = /(?<![A-Za-z0-9._%+-])@([\p{L}\p{N}_-]+)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(input || ''))) !== null) {
    const token = match[1].trim().toLowerCase();
    if (token) mentions.push(token);
  }
  return mentions;
}

export function resolveAtMentionIds(input: string, lore: LoreTriggerEntry[]): Set<string> {
  const names: Array<{ value: string; id: string }> = [];
  for (const entry of lore) {
    for (const candidate of [entry.name, ...entry.keys]) {
      const value = String(candidate || '').trim().toLowerCase();
      if (value) names.push({ value, id: entry.id });
    }
  }

  const ids = new Set<string>();
  for (const token of extractAtMentions(input)) {
    let best = '';
    let exact = false;
    for (const candidate of names) {
      if (candidate.value === token) {
        exact = true;
        best = token;
      } else if (
        !exact
        && candidate.value.length > best.length
        && token.startsWith(candidate.value)
        && !/[A-Za-z0-9]/.test(token.charAt(candidate.value.length))
      ) {
        best = candidate.value;
      }
    }
    if (best) for (const candidate of names) if (candidate.value === best) ids.add(candidate.id);
  }
  return ids;
}

export function presenceHasName(current: unknown, names: string[]): boolean {
  const items: string[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 4 || items.length >= 200) return;
    if (typeof value === 'string') {
      for (const piece of value.split(/[、,，;；/·\s]+/)) {
        const item = piece.trim();
        if (item) items.push(item);
        if (items.length >= 200) return;
      }
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        collect(key, depth + 1);
        collect(item, depth + 1);
      }
    }
  };
  collect(current, 0);

  const normalized = names.map((name) => name.trim().toLowerCase()).filter(Boolean);
  return items.some((item) => normalized.some((name) => {
    const value = item.toLowerCase();
    if (value === name) return true;
    if (!value.startsWith(name)) return false;
    const nextCodePoint = Array.from(value.slice(name.length))[0] || '';
    return !/[\p{L}\p{N}]/u.test(nextCodePoint);
  }));
}

export function addMentionedCharactersToPresence(
  stateBoard: Record<string, unknown>,
  characters: LoreTriggerEntry[],
): void {
  if (!characters.length) return;
  const key = Object.prototype.hasOwnProperty.call(stateBoard, '在场角色')
    ? '在场角色'
    : Object.prototype.hasOwnProperty.call(stateBoard, 'presence') ? 'presence' : '在场角色';
  let current = stateBoard[key];
  for (const character of characters) {
    if (presenceHasName(current, [character.name, ...character.keys])) continue;
    if (Array.isArray(current)) current.push(character.name);
    else if (typeof current === 'string') current = current.trim() ? `${current}、${character.name}` : character.name;
    else if (current && typeof current === 'object') (current as Record<string, unknown>)[character.name] = '在场';
    else current = [character.name];
  }
  stateBoard[key] = current;
}
