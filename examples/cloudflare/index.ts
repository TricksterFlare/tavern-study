import { authenticate, equalSecret, hasScope, type AuthContext, type AuthEnv, type Scope } from '../../src/auth';
import { ReadingService } from '../../src/core/readingService.ts';
import { D1ReadingStorage } from './adapters/d1ReadingStorage.ts';
import { D1DeskStorage } from './adapters/d1DeskStorage.ts';
import { D1DeskTurnStorage } from './adapters/d1DeskTurnStorage.ts';
import { D1DeskAssetStorage } from './adapters/d1DeskAssetStorage.ts';
import { D1DeskStoryStorage } from './adapters/d1DeskStoryStorage.ts';
import { VectorizeSemanticSearch } from './adapters/vectorizeSemanticSearch.ts';
import type { Ai, VectorizeIndex } from '../../src/storage/vectorize';
import type { SemanticSearchAdapter } from '../../src/core/storage.ts';
import {
  deskImportPreset, deskImportSettings, deskImportWorlds, deskImportRegexBundle, importCharacterCard,
  deskListPresets, deskPresetDelete, deskListRegex, deskBackfillChapterVectors,
} from '../../src/tools/desk';
import { parseCharacterCard } from '../../src/core/characterCard.ts';
import {
  deskPresetBlocks, deskBlockUpdate, deskLoreList, deskLoreCreate, deskLoreUpdate, deskLoreDelete,
  deskRegexUpdate, deskRegexDelete, deskRegexReorder, deskCoreGet, deskCoreUpdate, deskRecallGet, deskRecallUpdate,
} from '../../src/tools/deskPanels';
import { deskRecipeList, deskRecipeExport, deskRecipeCreate, deskRecipeUpdate, deskRecipeDelete } from '../../src/tools/deskRecipes';
import {
  deskWindowCreate, deskWindowList, deskWindowGet, deskWindowUpdate, deskWindowDelete,
  deskFloorEdit, deskWindowTruncate, deskFloorVariant,
} from '../../src/tools/deskWindows';
import { studyList, studyGet, studyCreate, studyUpdate, studyDelete, studySearch, studyBackfill } from '../../src/tools/study';
import { StudyService } from '../../src/core/studyService.ts';
import { D1StudyStorage } from './adapters/d1StudyStorage.ts';
import {
  chaptersList, chapterGet, chapterCreate, chapterUpdate, chapterDelete, chapterPublish, chapterUnpublish,
  commentsList, commentPost, commentDelete,
} from '../../src/tools/reading';
import { deskDryrun } from '../../src/chat/deskAssemble';
import { maybeFoldDeskTimeline } from '../../src/chat/deskTimeline';
import { deskBoardRefresh } from '../../src/chat/deskBoardRefresh';
import { handleDeskChat, type DeskChatStorage } from '../../src/chat/desk';

interface Env extends AuthEnv {
  OC_DB: D1Database;
  OC_VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  ANTHROPIC_API_KEY?: string;
  // Optional plain var: full Messages endpoint URL of an Anthropic-compatible gateway
  // (e.g. "https://gateway.example.com/v1/messages"). Protocol stays Anthropic Messages;
  // https-only, credentials-in-URL rejected. Unset = api.anthropic.com.
  ANTHROPIC_BASE_URL?: string;
  ALLOWED_ORIGINS?: string;
  // Path-token gate for the writer's-desk admin surface (/{AUTH_TOKEN}/api/oc/...) — a secret
  // distinct from the Bearer owner/companion tokens above, matching production's own separate
  // AUTH_TOKEN for this namespace.
  AUTH_TOKEN?: string;
}

const JSON_LIMIT = 32 * 1024;
// Prose-bearing admin routes (study entries, chapters, blocks, lore, core memory, floor edits)
// carry long free text; 256KiB keeps DoS bounded without rejecting legitimate saves.
const PROSE_LIMIT = 256 * 1024;
// Desk preset/settings/world/regex imports can be sizeable ST export files; the tiny-body cap
// below is for parameter-only writes where a legitimate body should never approach it.
const DESK_BODY_MAX = 10 * 1024 * 1024;
const DESK_TINY_BODY_MAX = 1024;

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const allowed = new Set((env.ALLOWED_ORIGINS || '').split(',').map((v) => v.trim()).filter(Boolean));
  if (!allowed.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(request: Request, env: Env, body: unknown, status = 200): Response {
  const headers = new Headers(corsHeaders(request, env));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJson(request: Request): Promise<any> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > JSON_LIMIT) throw new Error('REQUEST_TOO_LARGE');
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > JSON_LIMIT) throw new Error('REQUEST_TOO_LARGE');
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('INVALID_JSON');
  }
}

// Streaming body-size gate shared by the desk import/dryrun endpoints: counts bytes as they
// arrive instead of trusting Content-Length alone, so a chunked request can't sneak past the
// cap. opts.emptyBody lets parameter-only endpoints treat a zero-length body as `{}` instead of
// rejecting it, without loosening the cap for anyone else.
async function deskReadJsonLimited(
  request: Request,
  opts: { maxBytes?: number; emptyBody?: 'reject' | 'as-empty-object' } = {},
): Promise<{ body: any } | { resp: Response }> {
  const max = opts.maxBytes ?? DESK_BODY_MAX;
  const overLabel = max >= 1024 * 1024 ? `${Math.round(max / (1024 * 1024))}MB` : `${max} bytes`;
  const emptyOk = opts.emptyBody === 'as-empty-object';
  const lenHeader = request.headers.get('content-length');
  if (lenHeader !== null) {
    const len = Number(lenHeader);
    if (!Number.isFinite(len) || len < 0) return { resp: new Response(JSON.stringify({ success: false, error: 'invalid Content-Length' }), { status: 400 }) };
    if (len > max) return { resp: new Response(JSON.stringify({ success: false, error: `request body exceeds ${overLabel}` }), { status: 413 }) };
  }
  if (!request.body) return emptyOk ? { body: {} } : { resp: new Response(JSON.stringify({ success: false, error: 'request body is empty' }), { status: 400 }) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* cancel failing does not change the rejection */ }
      return { resp: new Response(JSON.stringify({ success: false, error: `request body exceeds ${overLabel}` }), { status: 413 }) };
    }
    chunks.push(value);
  }
  if (total === 0 && emptyOk) return { body: {} };
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { body: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { resp: new Response(JSON.stringify({ success: false, error: 'request body is not valid JSON' }), { status: 400 }) };
  }
}

function requireScope(
  request: Request,
  env: Env,
  auth: AuthContext | null,
  scope: Scope,
): Response | null {
  if (!auth) {
    const response = json(request, env, { error: 'unauthorized' }, 401);
    response.headers.set('WWW-Authenticate', 'Bearer');
    return response;
  }
  if (!hasScope(auth, scope)) return json(request, env, { error: 'forbidden' }, 403);
  return null;
}

function readingService(env: Env): ReadingService {
  return new ReadingService(new D1ReadingStorage(env.OC_DB));
}

// Shared by /api/oc/desk/chat and /api/oc/desk/dryrun — both feed assembleDesk (chat/deskAssemble.ts),
// which only accepts already-constructed storage adapters (no reverse import into this directory).
function deskAssemblyStorage(env: Env): { deskAssets: D1DeskAssetStorage; deskStory: D1DeskStoryStorage; semantic?: SemanticSearchAdapter } {
  return {
    deskAssets: new D1DeskAssetStorage(env.OC_DB),
    deskStory: new D1DeskStoryStorage(env.OC_DB),
    semantic: env.OC_VECTORIZE && env.AI ? new VectorizeSemanticSearch(env.OC_VECTORIZE, env.AI) : undefined,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function enforceCommentRate(request: Request, env: Env, auth: AuthContext): Promise<boolean> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256(`${auth.actorId}:${ip}:${env.OWNER_TOKEN}`);
  const now = new Date();
  const bucket = now.toISOString().slice(0, 16);
  const updatedAt = now.toISOString();
  const claim = (dimension: 'actor' | 'ip', subject: string) => env.OC_DB.prepare(
    `INSERT INTO comment_rate_buckets (dimension, subject, minute_bucket, request_count, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(dimension, subject, minute_bucket) DO UPDATE SET
       request_count = request_count + 1,
       updated_at = excluded.updated_at`,
  ).bind(dimension, subject, bucket, updatedAt);
  try {
    await env.OC_DB.batch([
      claim('actor', auth.actorId),
      claim('ip', ipHash),
      env.OC_DB.prepare(`DELETE FROM comment_rate_buckets WHERE minute_bucket < ?`).bind(
        new Date(now.getTime() - 10 * 60_000).toISOString().slice(0, 16),
      ),
    ]);
    return true;
  } catch (error) {
    if (String(error).includes('comment_rate_limited')) return false;
    throw error;
  }
}

async function createComment(request: Request, env: Env, auth: AuthContext, input: any): Promise<Response> {
  const content = boundedString(input?.content, 2000);
  const replyTo = input?.reply_to === undefined ? undefined : boundedString(input.reply_to, 80);
  if (!content?.trim() || (input?.reply_to !== undefined && replyTo === undefined)) {
    return json(request, env, { error: 'invalid_arguments' }, 400);
  }
  if (!(await enforceCommentRate(request, env, auth))) {
    return json(request, env, { error: 'rate_limited' }, 429);
  }
  const result = await readingService(env).createComment({
    chapterId: input.chapter_id,
    content,
    replyTo,
    author: { id: auth.actorId, type: auth.actorType, displayName: auth.displayName },
  });
  return json(request, env, result, result.success ? 201 : 400);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

// Writer's-desk admin surface (project 1's /api/oc/* namespace). Gated by the single path-token
// check in handle() below, not by the Bearer/scope system (that system stays reserved for the
// MCP face and the companion-facing published/comments routes, untouched by this function).
// This mirrors production's own shape: the whole surface is one owner's private portal, so
// there is no per-route scope split once the token has been verified — same as production
// hardcoding the comment author rather than deriving it from a per-request identity.
async function handleDeskAdmin(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response | null> {
  // ----- study entries (the writer's private shelf; distinct from the read-only MCP shelf tool) -----
  if (url.pathname === '/api/oc/memories' && request.method === 'GET') {
    const params = {
      project: url.searchParams.has('project') ? url.searchParams.get('project') : undefined,
      category: url.searchParams.get('category') || undefined,
      tag: url.searchParams.get('tag') || undefined,
      keyword: url.searchParams.get('keyword') || undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      order: url.searchParams.get('order') || undefined,
    };
    const r = await studyList(env as any, params);
    return json(request, env, r, r.success ? 200 : 500);
  }
  if (url.pathname === '/api/oc/memories' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request, { maxBytes: PROSE_LIMIT });
    if ('resp' in read) return read.resp;
    const body = read.body;
    const r = await studyCreate(env as any, body);
    return json(request, env, r, r.success ? 200 : 400);
  }
  if (url.pathname.startsWith('/api/oc/memories/')) {
    const id = url.pathname.slice('/api/oc/memories/'.length);
    if (!id) return json(request, env, { success: false, error: 'missing id' }, 400);
    if (request.method === 'GET') {
      const r = await studyGet(env as any, id);
      return json(request, env, r, r.success ? 200 : 404);
    }
    if (request.method === 'PUT') {
      const read = await deskReadJsonLimited(request, { maxBytes: PROSE_LIMIT });
      if ('resp' in read) return read.resp;
      const body = read.body;
      const r = await studyUpdate(env as any, id, body);
      return json(request, env, r, r.success ? 200 : (r.error === 'Study entry not found.' ? 404 : 400));
    }
    if (request.method === 'DELETE') {
      const r = await studyDelete(env as any, id);
      return json(request, env, r, r.success ? 200 : (r.error === 'Study entry not found.' ? 404 : 400));
    }
    return json(request, env, { success: false, error: 'not_found' }, 404);
  }
  if (url.pathname === '/api/oc/search' && request.method === 'GET') {
    const q = url.searchParams.get('q');
    if (!q) return json(request, env, { success: false, error: 'q is required' }, 400);
    const r = await studySearch(env as any, {
      q, project: url.searchParams.get('project') || undefined,
      category: url.searchParams.get('category') || undefined,
      limit: url.searchParams.get('topK') ? Number(url.searchParams.get('topK')) : undefined,
    });
    return json(request, env, r, r.success ? 200 : 500);
  }
  if (url.pathname === '/api/oc/stats' && request.method === 'GET') {
    // One read-path implementation: StudyService.stats() is the same aggregate the MCP shelf
    // tool's stats action serves (src/mcp/server.ts), not a second copy of the grouping logic.
    const r = await new StudyService(new D1StudyStorage(env.OC_DB)).stats();
    return json(request, env, r, r.success ? 200 : 500);
  }
  if (url.pathname === '/api/oc/backfill-vectors' && request.method === 'POST') {
    const r = await studyBackfill(env as any);
    return json(request, env, r, r.success ? 200 : 500);
  }

  // ----- chapters and comments -----
  if (url.pathname === '/api/oc/chapters' && request.method === 'GET') {
    const r = await chaptersList(env as any, {
      project: url.searchParams.get('project') || undefined,
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
    });
    return json(request, env, r, r.success ? 200 : 500);
  }
  if (url.pathname === '/api/oc/chapters' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request, { maxBytes: PROSE_LIMIT });
    if ('resp' in read) return read.resp;
    const body = read.body;
    const r = await chapterCreate(env as any, body);
    return json(request, env, r, r.success ? 200 : 400);
  }
  if (url.pathname.startsWith('/api/oc/chapters/')) {
    const rest = url.pathname.slice('/api/oc/chapters/'.length);
    const [id, action] = rest.split('/');
    if (!id) return json(request, env, { success: false, error: 'missing id' }, 400);
    if (action === 'publish' && request.method === 'POST') {
      const r = await chapterPublish(env as any, id);
      return json(request, env, r, r.success ? 200 : 404);
    }
    if (action === 'unpublish' && request.method === 'POST') {
      const r = await chapterUnpublish(env as any, id);
      return json(request, env, r, r.success ? 200 : 404);
    }
    if (action) return json(request, env, { success: false, error: 'not_found' }, 404);
    if (request.method === 'GET') {
      const r = await chapterGet(env as any, id);
      return json(request, env, r, r.success ? 200 : 404);
    }
    if (request.method === 'PUT') {
      const read = await deskReadJsonLimited(request, { maxBytes: PROSE_LIMIT });
      if ('resp' in read) return read.resp;
      const body = read.body;
      const r = await chapterUpdate(env as any, id, body);
      return json(request, env, r, r.success ? 200 : (r.error === 'Chapter not found.' ? 404 : 400));
    }
    if (request.method === 'DELETE') {
      const r = await chapterDelete(env as any, id);
      return json(request, env, r, r.success ? 200 : 404);
    }
    return json(request, env, { success: false, error: 'not_found' }, 404);
  }
  if (url.pathname === '/api/oc/comments' && request.method === 'GET') {
    const chapterId = url.searchParams.get('chapter_id');
    if (!chapterId) return json(request, env, { success: false, error: 'chapter_id is required' }, 400);
    const r = await commentsList(env as any, { chapter_id: chapterId, limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined });
    return json(request, env, r, r.success ? 200 : 500);
  }
  if (url.pathname === '/api/oc/comments' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT });
    if ('resp' in read) return read.resp;
    const body = read.body;
    // This whole surface is the owner's own portal (see handleDeskAdmin's header comment) — the
    // author is hardcoded, not derived from a per-request identity, exactly like production
    // hardcoding its REST comment author. Request-body author fields (if any) are ignored.
    const r = await commentPost(env as any, { chapter_id: body.chapter_id, content: body.content, reply_to: body.reply_to }, { authorId: 'owner', authorType: 'owner', displayName: 'Owner' });
    return json(request, env, r, r.success ? 200 : 400);
  }
  if (url.pathname.startsWith('/api/oc/comments/') && request.method === 'DELETE') {
    const id = url.pathname.slice('/api/oc/comments/'.length);
    if (!id) return json(request, env, { success: false, error: 'missing id' }, 400);
    const r = await commentDelete(env as any, id);
    return json(request, env, r, r.success ? 200 : 404);
  }

  // ----- desk import (preset / settings / worlds / regex bundle) -----
  if (url.pathname === '/api/oc/desk/import/preset' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request);
    if ('resp' in read) return read.resp;
    const name = url.searchParams.get('name') || undefined;
    const r = await deskImportPreset(env as any, read.body, name);
    return json(request, env, r, r.success ? 200 : (r.server === true ? 500 : 400));
  }
  if (url.pathname === '/api/oc/desk/import/settings' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request);
    if ('resp' in read) return read.resp;
    const r = await deskImportSettings(env as any, read.body);
    return json(request, env, r, r.success ? 200 : (r.server === true ? 500 : 400));
  }
  if (url.pathname === '/api/oc/desk/import/worlds' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request);
    if ('resp' in read) return read.resp;
    const r = await deskImportWorlds(env as any, read.body);
    return json(request, env, r, r.success ? 200 : (r.server === true ? 500 : 400));
  }
  if (url.pathname === '/api/oc/desk/import/regex' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request);
    if ('resp' in read) return read.resp;
    const targetPresetId = url.searchParams.get('target_preset_id') || undefined;
    const r = await deskImportRegexBundle(env as any, read.body, targetPresetId);
    return json(request, env, r, r.success ? 200 : (r.server === true ? 500 : 400));
  }
  if (url.pathname === '/api/oc/desk/import/card' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request);
    if ('resp' in read) return read.resp;
    const body = read.body;
    // 只吃JSON——PNG里挑出内嵌角色卡数据是前端的事(读tEXt chunk),这个端点收到的永远是解出来
    // 之后的卡JSON对象,跟其余三口"整份ST导出文件"同一个身位(JSON进JSON出,不碰二进制)。
    const parsed = parseCharacterCard(body && typeof body === 'object' ? (body as any).card : undefined);
    if (!parsed.ok) return json(request, env, { success: false, error: parsed.error }, 400);
    const projectRaw = body && typeof body === 'object' ? (body as any).project : undefined;
    const r = await importCharacterCard(env as any, parsed.card, projectRaw);
    if (r.success) r.warnings = [...parsed.warnings, ...(Array.isArray(r.warnings) ? r.warnings : [])];
    return json(request, env, r, r.success ? 200 : (r.server === true ? 500 : 400));
  }

  // ----- preset packs and their blocks -----
  if (url.pathname === '/api/oc/desk/presets' && request.method === 'GET') {
    const r = await deskListPresets(env as any);
    return json(request, env, r, r.success ? 200 : 500);
  }
  if (url.pathname.startsWith('/api/oc/desk/presets/') && url.pathname.endsWith('/blocks') && request.method === 'GET') {
    const rest = url.pathname.slice('/api/oc/desk/presets/'.length);
    const id = rest.slice(0, -'/blocks'.length);
    const r = await deskPresetBlocks(env as any, id, url.searchParams.get('full') === '1');
    return json(request, env, r, r.success ? 200 : (r.error === 'Preset pack not found.' ? 404 : 400));
  }
  if (url.pathname.startsWith('/api/oc/desk/blocks/') && request.method === 'PUT') {
    let id = '';
    try { id = decodeURIComponent(url.pathname.slice('/api/oc/desk/blocks/'.length)); }
    catch { return json(request, env, { success: false, error: 'block id is not valid URL encoding' }, 400); }
    const read = await deskReadJsonLimited(request, { maxBytes: PROSE_LIMIT });
    if ('resp' in read) return read.resp;
    const body = read.body;
    const r = await deskBlockUpdate(env as any, id, body);
    return json(request, env, r, r.success ? 200 : (r.error === 'Block not found.' ? 404 : (r.server ? 500 : 400)));
  }
  if (url.pathname.startsWith('/api/oc/desk/presets/') && request.method === 'DELETE') {
    const id = url.pathname.slice('/api/oc/desk/presets/'.length);
    if (!id) return json(request, env, { success: false, error: 'missing id' }, 400);
    const r = await deskPresetDelete(env as any, id);
    return json(request, env, r, r.success ? 200 : (r.error === 'Preset pack not found.' ? 404 : (r.server === true ? 500 : 400)));
  }

  // ----- global/preset regex -----
  if (url.pathname === '/api/oc/desk/regex' && request.method === 'GET') {
    const r = await deskListRegex(env as any, { scope: url.searchParams.get('scope') || undefined, preset_id: url.searchParams.get('preset_id') || undefined });
    return json(request, env, r, r.success ? 200 : 500);
  }
  if (url.pathname === '/api/oc/desk/regex/reorder' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT });
    if ('resp' in read) return read.resp;
    const body = read.body;
    const r = await deskRegexReorder(env as any, body);
    return json(request, env, r, r.success ? 200 : 400);
  }
  if (url.pathname.startsWith('/api/oc/desk/regex/')) {
    const id = url.pathname.slice('/api/oc/desk/regex/'.length);
    if (!id) return json(request, env, { success: false, error: 'missing id' }, 400);
    if (request.method === 'PUT') {
      const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT });
      if ('resp' in read) return read.resp;
      const body = read.body;
      const r = await deskRegexUpdate(env as any, id, body);
      return json(request, env, r, r.success ? 200 : (r.error === 'Regex rule not found.' ? 404 : 400));
    }
    if (request.method === 'DELETE') {
      const r = await deskRegexDelete(env as any, id);
      return json(request, env, r, r.success ? 200 : 404);
    }
    return json(request, env, { success: false, error: 'not_found' }, 404);
  }

  // ----- world/character lore -----
  if (url.pathname === '/api/oc/desk/lore' && request.method === 'GET') {
    const r = await deskLoreList(env as any, { project: url.searchParams.get('project') || undefined });
    return json(request, env, r, r.success ? 200 : (r.error === 'project is required.' ? 400 : 500));
  }
  if (url.pathname === '/api/oc/desk/lore' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request, { maxBytes: PROSE_LIMIT });
    if ('resp' in read) return read.resp;
    const body = read.body;
    const r = await deskLoreCreate(env as any, body);
    return json(request, env, r, r.success ? 200 : 400);
  }
  if (url.pathname.startsWith('/api/oc/desk/lore/')) {
    const id = url.pathname.slice('/api/oc/desk/lore/'.length);
    if (!id) return json(request, env, { success: false, error: 'missing id' }, 400);
    if (request.method === 'PUT') {
      const read = await deskReadJsonLimited(request, { maxBytes: PROSE_LIMIT });
      if ('resp' in read) return read.resp;
      const body = read.body;
      const r = await deskLoreUpdate(env as any, id, body);
      return json(request, env, r, r.success ? 200 : (r.error === 'Lore entry not found.' ? 404 : 400));
    }
    if (request.method === 'DELETE') {
      const r = await deskLoreDelete(env as any, id);
      return json(request, env, r, r.success ? 200 : 400);
    }
    return json(request, env, { success: false, error: 'not_found' }, 404);
  }

  // ----- per-project core memory and recall settings -----
  if (url.pathname === '/api/oc/desk/core' && request.method === 'GET') {
    const r = await deskCoreGet(env as any, (url.searchParams.get('project') || '').trim());
    return json(request, env, r, r.success ? 200 : (r.error === 'project is required.' ? 400 : 500));
  }
  if (url.pathname === '/api/oc/desk/core' && request.method === 'PUT') {
    const read = await deskReadJsonLimited(request, { maxBytes: PROSE_LIMIT });
    if ('resp' in read) return read.resp;
    const body = read.body;
    const r = await deskCoreUpdate(env as any, body);
    return json(request, env, r, r.success ? 200 : 400);
  }
  if (url.pathname === '/api/oc/desk/recall' && request.method === 'GET') {
    const r = await deskRecallGet(env as any, (url.searchParams.get('project') || '').trim());
    return json(request, env, r, r.success ? 200 : (r.error === 'project is required.' ? 400 : 500));
  }
  if (url.pathname === '/api/oc/desk/recall' && request.method === 'PUT') {
    const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT });
    if ('resp' in read) return read.resp;
    const body = read.body;
    const r = await deskRecallUpdate(env as any, body);
    return json(request, env, r, r.success ? 200 : 400);
  }

  // ----- recipes (preset + overrides + regex selection bound to a project) -----
  if (url.pathname === '/api/oc/desk/recipes' && request.method === 'GET') {
    const r = await deskRecipeList(env as any);
    return json(request, env, r, r.success ? 200 : 500);
  }
  if (url.pathname === '/api/oc/desk/recipes' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT });
    if ('resp' in read) return read.resp;
    const body = read.body;
    const r = await deskRecipeCreate(env as any, body);
    return json(request, env, r, r.success ? 200 : 400);
  }
  if (url.pathname.startsWith('/api/oc/desk/recipes/')) {
    const rest = url.pathname.slice('/api/oc/desk/recipes/'.length);
    const exportSuffix = '/export';
    const isExport = rest.endsWith(exportSuffix);
    const id = isExport ? rest.slice(0, -exportSuffix.length) : rest;
    if (!id) return json(request, env, { success: false, error: 'missing id' }, 400);
    if (isExport && request.method === 'GET') {
      const r = await deskRecipeExport(env as any, id);
      if (!r.success) return json(request, env, r, r.error === 'Recipe not found.' ? 404 : (r.server ? 500 : 400));
      const safeName = String(r.name || 'recipe').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80) || 'recipe';
      const headers = new Headers(corsHeaders(request, env));
      headers.set('Content-Type', 'application/json; charset=utf-8');
      headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.json`);
      return new Response(JSON.stringify(r.data, null, 2), { headers });
    }
    if (request.method === 'PUT') {
      const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT });
      if ('resp' in read) return read.resp;
      const body = read.body;
      const r = await deskRecipeUpdate(env as any, id, body);
      return json(request, env, r, r.success ? 200 : (r.error === 'Recipe not found.' ? 404 : 400));
    }
    if (request.method === 'DELETE') {
      const r = await deskRecipeDelete(env as any, id);
      return json(request, env, r, r.success ? 200 : (r.error === 'Recipe not found.' ? 404 : (r.server === true ? 500 : 400)));
    }
    return json(request, env, { success: false, error: 'not_found' }, 404);
  }
  if (url.pathname === '/api/oc/desk/backfill-chapter-vectors' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT, emptyBody: 'as-empty-object' });
    if ('resp' in read) return read.resp;
    const r = await deskBackfillChapterVectors(env as any, read.body || {});
    return json(request, env, r, r.success ? 200 : 500);
  }
  if (url.pathname === '/api/oc/desk/dryrun' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request);
    if ('resp' in read) return read.resp;
    const r = await deskDryrun(deskAssemblyStorage(env), read.body);
    return json(request, env, r, r.success ? 200 : 400);
  }

  // ----- writing-desk windows and floors -----
  if (url.pathname === '/api/oc/desk/windows' && request.method === 'GET') {
    const r = await deskWindowList(env as any, { project: url.searchParams.get('project') || undefined });
    return json(request, env, r, r.success ? 200 : 500);
  }
  if (url.pathname === '/api/oc/desk/windows' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT });
    if ('resp' in read) return read.resp;
    const body = read.body;
    const r = await deskWindowCreate(env as any, body);
    return json(request, env, r, r.success ? 200 : (r.server === true ? 500 : 400));
  }
  if (url.pathname.startsWith('/api/oc/desk/windows/')) {
    const rest = url.pathname.slice('/api/oc/desk/windows/'.length);
    if (rest.endsWith('/truncate')) {
      const id = rest.slice(0, -'/truncate'.length);
      if (request.method === 'POST' && id) {
        const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT });
        if ('resp' in read) return read.resp;
        const body = read.body;
        if (!body || typeof body.floor_id !== 'string') return json(request, env, { success: false, error: 'floor_id is required' }, 400);
        const r = await deskWindowTruncate(env as any, id, body.floor_id, body.inclusive === true);
        return json(request, env, r, r.success ? 200 : (r.error && r.error.includes('not found') ? 404 : 400));
      }
      return json(request, env, { success: false, error: 'not_found' }, 404);
    }
    // State board refresh: read-only recompute from the last (assistant) floor's current text —
    // it returns a draft, it never writes. Persisting it is still PUT /windows/:id (the caller
    // saves it explicitly), see chat/deskBoardRefresh.ts's header for why.
    if (rest.endsWith('/board-refresh')) {
      const id = rest.slice(0, -'/board-refresh'.length);
      if (request.method === 'POST' && id) {
        const r = await deskBoardRefresh(env as any, id);
        return json(request, env, r, r.success ? 200 : (r.error === 'This desk window does not exist.' ? 404 : 400));
      }
      return json(request, env, { success: false, error: 'not_found' }, 404);
    }
    // Manual timeline fold: force skips the auto-fold trigger threshold; keep defaults to the
    // same DESK_TIMELINE_KEEP the automatic path uses. Awaited synchronously (not waitUntil) —
    // the caller pressed a button and wants to see the result now; the fold itself is bounded.
    if (rest.endsWith('/compress')) {
      const id = rest.slice(0, -'/compress'.length);
      if (request.method === 'POST' && id) {
        const read = await deskReadJsonLimited(request, { maxBytes: DESK_TINY_BODY_MAX, emptyBody: 'as-empty-object' });
        if ('resp' in read) return read.resp;
        const body: any = read.body;
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return json(request, env, { success: false, error: 'request body must be a JSON object' }, 400);
        }
        let keep: number | undefined;
        if (body.keep !== undefined) {
          const k = body.keep;
          if (typeof k !== 'number' || !Number.isSafeInteger(k) || k < 0) {
            return json(request, env, { success: false, error: 'keep must be an integer >= 0' }, 400);
          }
          keep = k;
        }
        const r: any = await maybeFoldDeskTimeline(env as any, id, undefined, { force: true, keep });
        if (r && r.skip === 'window_gone') return json(request, env, { success: false, error: 'Desk window not found.' }, 404);
        return json(request, env, r, r.success ? 200 : 500);
      }
      return json(request, env, { success: false, error: 'not_found' }, 404);
    }
    const id = rest;
    if (!id) return json(request, env, { success: false, error: 'missing id' }, 400);
    if (request.method === 'GET') {
      const r = await deskWindowGet(env as any, id);
      return json(request, env, r, r.success ? 200 : (r.error === 'Desk window not found.' ? 404 : 400));
    }
    if (request.method === 'PUT') {
      const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT });
      if ('resp' in read) return read.resp;
      const body = read.body;
      const r = await deskWindowUpdate(env as any, id, body);
      return json(request, env, r, r.success ? 200 : (r.error === 'Desk window not found.' ? 404 : 400));
    }
    if (request.method === 'DELETE') {
      const r = await deskWindowDelete(env as any, id);
      return json(request, env, r, r.success ? 200 : (r.error === 'Desk window not found.' ? 404 : 400));
    }
    return json(request, env, { success: false, error: 'not_found' }, 404);
  }
  if (url.pathname.startsWith('/api/oc/desk/floors/')) {
    const rest = url.pathname.slice('/api/oc/desk/floors/'.length);
    if (rest.endsWith('/variant')) {
      const id = rest.slice(0, -'/variant'.length);
      if (request.method === 'POST' && id) {
        const read = await deskReadJsonLimited(request, { maxBytes: JSON_LIMIT });
        if ('resp' in read) return read.resp;
        const body = read.body;
        if (!body || typeof body.index !== 'number') return json(request, env, { success: false, error: 'index is required (number)' }, 400);
        const r = await deskFloorVariant(env as any, id, body.index);
        return json(request, env, r, r.success ? 200 : (r.error === 'Floor not found.' ? 404 : 400));
      }
      return json(request, env, { success: false, error: 'not_found' }, 404);
    }
    const id = rest;
    if (!id) return json(request, env, { success: false, error: 'missing id' }, 400);
    if (request.method === 'PUT') {
      const read = await deskReadJsonLimited(request, { maxBytes: PROSE_LIMIT });
      if ('resp' in read) return read.resp;
      const body = read.body;
      if (!body || typeof body.content !== 'string') return json(request, env, { success: false, error: 'content is required (string)' }, 400);
      const r = await deskFloorEdit(env as any, id, body.content);
      return json(request, env, r, r.success ? 200 : (r.error === 'Floor not found.' ? 404 : 400));
    }
    return json(request, env, { success: false, error: 'not_found' }, 404);
  }

  // Desk chat: SSE generation (normal turn or roll), state-board protocol handling, and the
  // atomic floor/window commit all live in chat/desk.ts; this route only wires the D1 storage
  // and the background waitUntil hooks (usage logging, auto-fold) into it.
  if (url.pathname === '/api/oc/desk/chat' && request.method === 'POST') {
    const read = await deskReadJsonLimited(request);
    if ('resp' in read) return read.resp;
    const storage: DeskChatStorage = { deskStorage: new D1DeskStorage(env.OC_DB), turnStorage: new D1DeskTurnStorage(env.OC_DB), ...deskAssemblyStorage(env) };
    return handleDeskChat(env as any, read.body, storage, request.signal, (promise) => ctx.waitUntil(promise));
  }

  return null;
}

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    const headers = corsHeaders(request, env);
    return Object.keys(headers).length ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 });
  }
  if (url.pathname === '/health' && request.method === 'GET') return json(request, env, { ok: true, service: 'tavern-study' });

  // Writer's-desk admin surface: URL-path token gate, shape /{AUTH_TOKEN}/api/oc/..., mirroring
  // the reference deployment's single `pathParts[0] === AUTH_TOKEN` judgement for this
  // namespace. Scoped to just this prefix — every other route below keeps the existing
  // Bearer/scope system (MCP, published reading, comments); this is not a second general auth
  // mode, just this one namespace's own gate.
  const pathParts = url.pathname.split('/').filter((part) => part.length > 0);
  if (pathParts.length >= 3 && pathParts[1] === 'api' && pathParts[2] === 'oc') {
    if (!env.AUTH_TOKEN || !(await equalSecret(pathParts[0], env.AUTH_TOKEN))) {
      return json(request, env, { error: 'unauthorized' }, 401);
    }
    const remainingUrl = new URL(url.toString());
    remainingUrl.pathname = '/' + pathParts.slice(1).join('/');
    const admin = await handleDeskAdmin(request, env, remainingUrl, ctx);
    if (admin) return admin;
    return json(request, env, { error: 'not_found' }, 404);
  }

  const auth = await authenticate(request, env);
  const readGate = requireScope(request, env, auth, 'published:read');
  if (readGate) return readGate;
  const actor = auth as AuthContext;

  if (url.pathname === '/mcp') return json(request, env, {
    error: 'mcp_transport_not_configured',
    message: 'Embed TavernStudyMcpServer in a host-managed MCP transport and session store.',
  }, 501);
  if (url.pathname === '/api/v1/published' && request.method === 'GET') {
    const rawLimit = url.searchParams.get('limit');
    return json(request, env, await readingService(env).listPublished({
      project: url.searchParams.get('project') || undefined,
      limit: rawLimit ? Number(rawLimit) : undefined,
    }));
  }
  const chapter = url.pathname.match(/^\/api\/v1\/published\/([^/]+)$/);
  if (chapter && request.method === 'GET') return json(request, env, await readingService(env).readPublished(decodeURIComponent(chapter[1])));
  const comments = url.pathname.match(/^\/api\/v1\/published\/([^/]+)\/comments$/);
  if (comments && request.method === 'GET') {
    const commentGate = requireScope(request, env, actor, 'comments:read');
    if (commentGate) return commentGate;
    const rawLimit = url.searchParams.get('limit');
    return json(request, env, await readingService(env).listComments(
      decodeURIComponent(comments[1]), rawLimit ? Number(rawLimit) : undefined,
    ));
  }
  if (comments && request.method === 'POST') {
    const writeGate = requireScope(request, env, actor, 'comments:write');
    if (writeGate) return writeGate;
    let body: any;
    try { body = await readJson(request); }
    catch (error: any) {
      const tooLarge = error.message === 'REQUEST_TOO_LARGE';
      return json(request, env, { error: tooLarge ? 'request_too_large' : 'invalid_json' }, tooLarge ? 413 : 400);
    }
    return createComment(request, env, actor, { ...body, chapter_id: decodeURIComponent(comments[1]) });
  }
  return json(request, env, { error: 'not_found' }, 404);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error('[worker] Unhandled request error:', error);
      return json(request, env, { error: 'internal_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
