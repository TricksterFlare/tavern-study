import type { Chapter, ChapterComment, CommentAuthor, DeskFloor, DeskLore, DeskPromptBlock, DeskRecipe, DeskRegex, DeskWindow, StudyEntry } from './types.ts';

export interface StudyListQuery {
  project?: string;
  category?: StudyEntry['category'];
  keyword?: string;
  tag?: string;
}

export interface StudyStats {
  byCategory: Record<string, number>;
  byProject: Record<string, number>;
  total: number;
}

export interface StudyStorage {
  listEntries(query: StudyListQuery): Promise<StudyEntry[]>;
  getEntry(id: string): Promise<StudyEntry | null>;
  createEntry(entry: StudyEntry): Promise<void>;
  updateEntry(id: string, patch: Partial<Omit<StudyEntry, 'id' | 'createdAt'>>): Promise<StudyEntry | null>;
  deleteEntry(id: string): Promise<boolean>;
  stats(): Promise<StudyStats>;
}

export interface ReadingStorage {
  createChapter(chapter: Chapter): Promise<void>;
  getChapter(id: string): Promise<Chapter | null>;
  publishChapter(id: string, publishedAt: string): Promise<Chapter | null>;
  listPublishedChapters(project?: string): Promise<Array<Chapter & { commentCount: number }>>;
  getPublishedChapter(id: string): Promise<Chapter | null>;
  listPublishedComments(chapterId: string, limit: number): Promise<ChapterComment[] | null>;
  createPublishedComment(input: {
    id: string;
    chapterId: string;
    replyTo: string | null;
    author: CommentAuthor;
    content: string;
    createdAt: string;
  }): Promise<ChapterComment | null>;
}

export interface DeskStorage {
  listWindows(project?: string): Promise<DeskWindow[]>;
  getWindow(id: string): Promise<DeskWindow | null>;
  createWindow(window: DeskWindow): Promise<void>;
  updateWindow(id: string, patch: Partial<Omit<DeskWindow, 'id' | 'createdAt'>>): Promise<DeskWindow | null>;
  updateTimelineState(id: string, expectedUpdatedAt: string, timelineState: Record<string, unknown>, updatedAt: string): Promise<DeskWindow | null>;
  deleteWindow(id: string): Promise<boolean>;
  listFloors(windowId: string): Promise<DeskFloor[]>;
  getFloor(id: string): Promise<DeskFloor | null>;
  createFloor(floor: DeskFloor): Promise<void>;
  updateFloor(id: string, patch: Partial<Omit<DeskFloor, 'id' | 'windowId' | 'createdAt'>>): Promise<DeskFloor | null>;
  truncateFloors(windowId: string, anchorId: string, inclusive: boolean): Promise<number | null>;
}

export interface DeskAssetStorage {
  getRecipe(id: string): Promise<DeskRecipe | null>;
  hasPreset(id: string): Promise<boolean>;
  listRegex(ids: string[]): Promise<DeskRegex[]>;
  listQueueBlocks(presetId: string): Promise<DeskPromptBlock[]>;
  listLore(project: string): Promise<DeskLore[]>;
  importPack(pack: DeskAssetPack): Promise<void>;
}

export interface DeskAssetPack {
  project: string;
  name: string;
  recipe: DeskRecipe;
  blocks: DeskPromptBlock[];
  regex: DeskRegex[];
}

export interface DeskStoryStorage {
  getState(key: string): Promise<string | null>;
  listPublishedChapters(project: string): Promise<Chapter[]>;
  getPublishedChapters(ids: string[], project: string): Promise<Chapter[]>;
}

export interface DeskTurnCommit {
  content: string;
  thinking: string | null;
  report: Record<string, unknown>;
  stateBoard: Record<string, unknown>;
  committedAt: string;
}

export interface DeskTurnStorage {
  commitAssistantFloor(windowId: string, floorId: string, commit: DeskTurnCommit): Promise<DeskFloor | null>;
  rollAssistantFloor(input: {
    windowId: string;
    floorId: string;
    expected: Pick<DeskFloor, 'content' | 'variants' | 'activeVariant' | 'thinking' | 'report'>;
    commit: DeskTurnCommit;
  }): Promise<DeskFloor | null>;
}

export interface StorageAdapter {
  reading: ReadingStorage;
  study: StudyStorage;
  desk: DeskStorage;
  deskAssets: DeskAssetStorage;
  deskStory: DeskStoryStorage;
  deskTurn: DeskTurnStorage;
}

export interface SemanticDocument {
  id: string;
  text: string;
  metadata: Record<string, string>;
}

export interface SemanticHit {
  id: string;
  score: number;
}

export interface SemanticSearchAdapter {
  upsert(document: SemanticDocument): Promise<void>;
  delete(id: string): Promise<void>;
  search(query: string, options: { limit: number; filter?: Record<string, string> }): Promise<SemanticHit[]>;
}
