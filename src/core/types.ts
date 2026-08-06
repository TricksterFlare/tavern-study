export type ChapterStatus = 'draft' | 'published';

export interface Chapter {
  id: string;
  project: string;
  chapterNo: string;
  title: string;
  content: string;
  summary: string;
  status: ChapterStatus;
  createdAt: string;
  updatedAt: string | null;
  publishedAt: string | null;
}

export interface CommentAuthor {
  id: string;
  type: 'owner' | 'ai';
  displayName: string;
}

export interface ChapterComment {
  id: string;
  chapterId: string;
  replyTo: string | null;
  author: CommentAuthor;
  content: string;
  createdAt: string;
}

export type StudyCategory = 'world' | 'plot' | 'outline' | 'session';

export interface LoreConfig {
  keys: string[];
  position: 'before' | 'after';
  isCharacter: boolean;
  constant: boolean;
  triggerMode: 'scan' | 'presence';
  enabled: boolean;
  fields: Record<string, string>;
}

export interface StudyEntry {
  id: string;
  project: string;
  category: StudyCategory;
  title: string;
  tags: string[];
  chapter: string;
  content: string;
  lore: LoreConfig;
  createdAt: string;
  updatedAt: string | null;
}

export interface DeskWindow {
  id: string;
  project: string;
  title: string;
  recipeId: string;
  note: string;
  noteDepth: number;
  stateBoard: Record<string, unknown>;
  timelineState: Record<string, unknown>;
  vars: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DeskFloor {
  id: string;
  windowId: string;
  role: 'user' | 'assistant';
  content: string;
  variants: string[];
  activeVariant: number;
  thinking: string | null;
  report: Record<string, unknown> | null;
  createdAt: string;
}

export interface DeskRecipe {
  id: string;
  presetId: string;
  weight: 'light' | 'heavy';
  overrides: Record<string, { enabled?: boolean; pos?: number }>;
  regexIds: string[];
  lightSystem: string;
}

export interface DeskPromptBlock {
  identifier: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  marker: boolean;
  queuePos: number | null;
  enabledDefault: boolean;
}

export interface DeskRegex {
  id: string;
  find: string;
  flags: string;
  replace: string;
  direction: 'up' | 'down' | 'both';
  meta: Record<string, unknown>;
}

export interface DeskLore {
  id: string;
  name: string;
  content: string;
  keys: string[];
  position: string;
  isCharacter: boolean;
  constant: boolean;
  triggerMode: 'scan' | 'presence';
  fields: Record<string, string>;
}
