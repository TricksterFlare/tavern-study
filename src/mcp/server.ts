import type { TavernStudyHost } from '../core/tavernStudyHost.ts';
import type { AuthContext, Scope } from '../auth.ts';

export interface McpRequest { jsonrpc: '2.0'; id?: string | number; method: string; params?: unknown }
export interface TavernStudyMcpOptions {}

// Two tools only: shelf (read-only study shelf) and bookclub (published reading corner +
// comments). Every other capability (desk generation, chapter drafting, study writes, ...)
// stays available on the underlying services; it is simply not exposed through this MCP face.
const TOOLS = [
  ['shelf', 'Read the study shelf: list private study entries or read one in full. Read-only.'],
  ['bookclub', 'Browse published chapters, read one in full, list comments, or post a comment.'],
] as const;

const CATEGORIES = new Set(['world', 'plot', 'outline', 'session']);

const schemas: Record<string, any> = {
  shelf: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'stats'], description: 'list (default) browses entries with a preview; get (with id) reads one entry in full; stats returns counts grouped by category and project.' },
      id: { type: 'string', description: 'get: which entry.' },
      project: { type: 'string', description: 'list: filter by project.' },
      category: { type: 'string', enum: ['world', 'plot', 'outline', 'session'], description: 'list: filter by category.' },
      tag: { type: 'string', description: 'list: filter by tag.' },
      keyword: { type: 'string', description: 'list: search title, content, and tags.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'list: how many rows, default 50.' },
    },
    additionalProperties: false,
  },
  bookclub: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['chapters', 'read', 'comments', 'comment'], description: 'chapters (default) lists published chapters; read (with id) reads one in full; comments lists a chapter’s comments; comment posts one.' },
      id: { type: 'string', description: 'read: which chapter.' },
      chapter_id: { type: 'string', description: 'comments/comment: which chapter.' },
      content: { type: 'string', maxLength: 2000, description: 'comment: the comment body.' },
      reply_to: { type: 'string', description: 'comment: optional parent comment id.' },
      project: { type: 'string', description: 'chapters: optional project filter.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'chapters/comments: how many rows.' },
    },
    additionalProperties: false,
  },
};

const allowedArguments: Record<string, string[]> = {
  shelf: ['action', 'id', 'project', 'category', 'tag', 'keyword', 'limit'],
  bookclub: ['action', 'id', 'chapter_id', 'content', 'reply_to', 'project', 'limit'],
};

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const text = (value: unknown, max: number, required = false) => typeof value === 'string' && value.length <= max && (!required || !!value.trim());
const toolResult = (value: any) => ({ content: [{ type: 'text', text: value.success ? JSON.stringify(value) : String(value.error || 'Request failed') }], structuredContent: value, isError: !value.success });

export class TavernStudyMcpServer {
  private initialized = false;
  private readonly host: TavernStudyHost;
  private readonly auth: AuthContext;

  constructor(host: TavernStudyHost, auth: AuthContext, _options: TavernStudyMcpOptions = {}) { this.host = host; this.auth = auth; }

  async handle(request: McpRequest): Promise<any | null> {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || (request.id !== undefined && !(typeof request.id === 'string' || Number.isInteger(request.id)))) return request?.id === undefined ? null : this.error(undefined, -32600, 'Invalid Request');
    if (request.method === 'ping') return request.id === undefined ? null : this.ok(request.id, {});
    if (request.method === 'initialize') {
      if (request.id === undefined) return null;
      const p = request.params as any;
      if (this.initialized) return this.error(request.id, -32600, 'Already initialized');
      if (request.id === undefined || !p || typeof p !== 'object' || typeof p.protocolVersion !== 'string' || !p.clientInfo || typeof p.clientInfo.name !== 'string' || typeof p.clientInfo.version !== 'string' || !p.capabilities || typeof p.capabilities !== 'object') return this.error(request.id, -32602, 'Invalid params');
      this.initialized = true;
      return this.ok(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'tavern-study', version: '0.1.0' } });
    }
    if (request.id === undefined) return null;
    if (!this.initialized) return this.error(request.id, -32002, 'Server not initialized');
    if (request.method === 'tools/list') return this.ok(request.id, { tools: TOOLS.filter(([name]) => this.visible(name)).map(([name, description]) => ({ name, description, inputSchema: schemas[name] })) });
    if (request.method !== 'tools/call') return this.error(request.id, -32601, 'Method not found');
    const params = request.params as any; const name = params?.name; const args = params?.arguments ?? {};
    if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args) || !this.visible(name, args)) return this.error(request.id, -32602, 'Invalid params');
    const invalid = this.validate(name, args); if (invalid) return this.ok(request.id, toolResult({ success: false, error: invalid }));
    try { return this.ok(request.id, toolResult(await this.call(name, args))); }
    catch { return this.ok(request.id, toolResult({ success: false, error: 'internal_error' })); }
  }

  // shelf is gated on study:read (it has no write actions). bookclub's baseline is
  // published:read (chapters/read); its comments/comment actions additionally require
  // comments:read/comments:write respectively, checked here since one tool now covers
  // several of the old per-action scopes.
  private visible(name: string, args?: any) {
    if (name === 'shelf') return this.auth.scopes.has('study:read');
    if (name === 'bookclub') {
      const action = args?.action || 'chapters';
      if (action === 'comment') return this.auth.scopes.has('comments:write');
      if (action === 'comments') return this.auth.scopes.has('comments:read');
      return this.auth.scopes.has('published:read');
    }
    return false;
  }

  private validate(name: string, a: any): string | null {
    if (!allowedArguments[name] || Object.keys(a).some((key) => !allowedArguments[name].includes(key))) return 'invalid arguments';
    if (name === 'shelf') {
      const action = a.action || 'list';
      if (!['list', 'get', 'stats'].includes(action)) return 'invalid action';
      if (action === 'get') return text(a.id, 100, true) ? null : 'id is required';
      if (own(a, 'category') && !CATEGORIES.has(a.category)) return 'invalid category';
      return null;
    }
    if (name === 'bookclub') {
      const action = a.action || 'chapters';
      if (!['chapters', 'read', 'comments', 'comment'].includes(action)) return 'invalid action';
      if (action === 'read') return text(a.id, 100, true) ? null : 'id is required';
      if (action === 'comments') return text(a.chapter_id, 100, true) ? null : 'chapter_id is required';
      if (action === 'comment') return (!text(a.chapter_id, 100, true) || !text(a.content, 2000, true) || (own(a, 'reply_to') && !text(a.reply_to, 100))) ? 'invalid arguments' : null;
      return null;
    }
    return 'invalid arguments';
  }

  private async call(name: string, a: any): Promise<any> {
    if (name === 'shelf') {
      const action = a.action || 'list';
      if (action === 'get') return this.host.study.get(a.id);
      if (action === 'stats') return this.host.study.stats();
      return this.host.study.list({ project: a.project, category: a.category, tag: a.tag, keyword: a.keyword, limit: a.limit });
    }
    if (name === 'bookclub') {
      const action = a.action || 'chapters';
      if (action === 'read') return this.host.reading.readPublished(a.id);
      if (action === 'comments') return this.host.reading.listComments(a.chapter_id, a.limit);
      if (action === 'comment') return this.host.reading.createComment({ chapterId: a.chapter_id, content: a.content, replyTo: a.reply_to, author: { id: this.auth.actorId, type: this.auth.actorType, displayName: this.auth.displayName } });
      return this.host.reading.listPublished({ project: a.project, limit: a.limit });
    }
    return { success: false, error: 'unknown_tool' };
  }
  private ok(id: McpRequest['id'], value: unknown) { return { jsonrpc: '2.0', id, result: value }; }
  private error(id: McpRequest['id'], code: number, message: string) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
}
