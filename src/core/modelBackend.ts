export interface ModelUsage { input: number; output: number; cacheRead: number; cacheWrite: number }

export type ModelStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'usage'; usage: Partial<ModelUsage> }
  | { type: 'ping' };

export interface StreamChatArgs {
  system: Array<{ text: string; cache: boolean }>;
  prompt: string;
  model: string;
  signal?: AbortSignal;
  onEvent?: (event: ModelStreamEvent) => void | Promise<void>;
}

export type StreamChatResult =
  // Backends may return this variant only after their protocol-specific clean terminal was observed.
  | { ok: true; terminal: 'clean'; text: string; thinking: string; usage: ModelUsage; stopReason?: string }
  | { ok: false; kind: 'config' | 'http' | 'timeout' | 'aborted' | 'protocol' | 'limit' | 'empty' | 'fetch'; detail?: string; usage?: ModelUsage };

export interface ModelBackend {
  // An aborted request must never resolve to the successful clean-terminal variant.
  streamChat(args: StreamChatArgs): Promise<StreamChatResult>;
}
