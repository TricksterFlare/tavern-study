// 打字桌聊天机：SSE、零工具、一次性无 resume，直接生成小说正文。
// 跟 editorial.ts 最大的结构性差异:editorial 用"system两块+多轮消息history"的对话式装配,
// desk 用 chat/deskAssemble.ts 产出的"system队列块+单段tail长文本"——一整窗的近景/状态板/
// 时光带/本楼输入全部揉进 tail 一段字符串里,所以这里发给模型的永远是【单条 user 消息】
// (content=tail),不维护多轮 messages 数组,也就没有"history 数组"这个概念——跟打字桌手套
// "一次性无resume,每轮全量装配"的设计是同一件事的两个说法。
//
// 两种轮次(body.roll,传或不传=普通轮):
//   普通轮:存新的 user 楼层 → 从"此楼之前"的近景重装配 → 生成 → 存新的 assistant 楼层。
//   roll:不存新楼层,找最后一楼(必须是 assistant)→ 从"此楼之前"重装配(近景到那条assistant
//     之前最近一条user为止)→ 生成 → 追加成那条楼层的新 variant,active切过去。
// continue 已退役；收到旧请求必须 400 拒绝，不能误落空 user 楼。
//
// 状态板协议、楼层/窗口原子提交和时光带折叠触发都在此收尾。

import { MODEL_PROFILES } from './models';
import { makeD1UsageSink } from '../storage/usageSink';
import { assembleDesk } from './deskAssemble';
import { loadDeskTimelineState, renderTimelineText, parseDeskTimelineCutoff, maybeFoldDeskTimeline, invalidateDeskTimelineIfFolded, fenceDeskTimelineAfterWrite } from './deskTimeline';
import type { Ai, VectorizeIndex } from '../storage/vectorize';
import { parseStateBoard as parseCoreStateBoard, STATEBOARD_MAX_BYTES as CORE_STATEBOARD_MAX_BYTES } from '../core/stateBoard.ts';
import type { DeskAssetStorage, DeskStorage, DeskStoryStorage, DeskTurnStorage, SemanticSearchAdapter } from '../core/storage.ts';
import { AnthropicStreamBackend } from '../adapters/streamModelBackends.ts';
import { validateDeskChannelConfig } from '../core/deskChannelConfig.ts';

interface DeskChatEnv {
  OC_DB: D1Database;
  OC_VECTORIZE: VectorizeIndex;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL?: string; // 可选:Anthropic 兼容网关的完整 Messages 端点 URL;校验在 AnthropicStreamBackend 的 safeEndpoint
  [k: string]: any;
}

// D1/CF-specific storage instances are the caller's job (examples/cloudflare/index.ts wires
// the D1 adapters from env.OC_DB/env.OC_VECTORIZE); this module only knows the StorageAdapter
// interfaces so it never reaches into examples/cloudflare/ itself. semantic is optional the
// same way TavernStudyHost treats it — recall simply stays empty without it.
export interface DeskChatStorage {
  deskStorage: DeskStorage;
  turnStorage: DeskTurnStorage;
  deskAssets: DeskAssetStorage;
  deskStory: DeskStoryStorage;
  semantic?: SemanticSearchAdapter;
}

interface DeskChatParams {
  window_id: string;
  message?: string;
  model?: string;
  roll?: boolean;
  continue?: boolean; // 仅识别旧客户端续写请求，收到即400拒绝
}

const DESK_DEFAULT_MODEL = 'claude-sonnet-4-5'; // 工单"model default follow editorial's"——同一个值,字面量各放一份(避免循环import)
const USER_ID = 'tavern-study-desk'; // Keep desk usage isolated from other host features.
const MESSAGE_MAX = 50000; // 同 editorial.ts message 上限口径
// 近景回喂上限独立于折叠阈值，给后台延迟/失败保留安全重叠。
const HISTORY_CAP = 40;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function errJson(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ success: false, error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// ===== 状态板 in-band 解析 =====
// ```stateboard 围栏只有锚定在全文末尾（其后仅空白）才算协议指令；
// 埋在正文中间、后面还跟着别的正文的围栏是虚构(角色在故事里写了一段长得像围栏的文字),纯粹当
// 故事正文处理——不strip不parse,content原样返回,board留null。理由:desk是小说续写场景,模型
// 完全可能在叙事里描述"一段代码块"或引用别的格式化文本,不能见到```stateboard字样就当协议吃掉。
// 终态围栏命中后即从正文剥离；JSON 失败、非对象或序列化后超 8KB 都按畸形处理，
// 处理(board=null),不截断JSON本身凑合解析——半截JSON比没有更危险。
// 导出给 deskWindows 手改路径共享，保证两处使用同一字节上限。
export const STATEBOARD_MAX_BYTES = CORE_STATEBOARD_MAX_BYTES;

// Existing desk callers now exercise the same pure parser covered by core fixtures.
export const parseStateBoard = parseCoreStateBoard;

// ===== <content>最外层包裹剥离 =====
// 只处理最外层
// 包裹】——trim 后以 <content> 开头才剥开标签(连同紧随的至多一个换行),trim 后以 </content>
// 结尾才剥闭标签(连同紧前的至多一个换行),开闭各自独立判断(max_tokens 腰斩时可能只剥出开没有
// 闭,也照剥)。正文中段出现的字面 <content>/</content>(可能是剧情引用)一律不动——判据只看
// trim 后的首尾,不做全文替换。trim 只用于"要不要剥"的判断,不 trim 落库内容本身：
// trim结果落库会啃掉Markdown尾部双空格硬换行/新段前导缩进这类有效空白),所以这里剥的是"标签+
// 紧邻的一个换行",两侧原有的其余空白原样保留。
export function unwrapContentTag(text: string): string {
  const OPEN = '<content>';
  const CLOSE = '</content>';
  let s = String(text || '');

  // 开标签:trim视图判断"要不要剥",实剥只挖掉标签本身+紧随的至多一个换行,标签前面原有的
  // 前导空白(trim时被晾在一边的那部分)原样拼回去,不陪绑一起剥。
  const trimmed = s.trim();
  if (trimmed.startsWith(OPEN)) {
    const leadWs = s.length - s.trimStart().length;
    let cut = leadWs + OPEN.length;
    if (s.startsWith('\r\n', cut)) cut += 2;
    else if (s.startsWith('\n', cut)) cut += 1;
    s = s.slice(0, leadWs) + s.slice(cut);
  }

  // 闭标签:用剥完开标签之后的最新 s 重新取 trim 视图判断(开标签那刀不会碰到尾部,这里重新
  // trim只是让两段逻辑各自独立、不用互相假设谁先跑、跑没跑过)。同理,标签后面原有的尾随空白
  // 原样保留,只挖标签本身+紧前的至多一个换行。
  const trimmed2 = s.trim();
  if (trimmed2.endsWith(CLOSE)) {
    const trailWs = s.length - s.trimEnd().length;
    const tagEnd = s.length - trailWs;
    let cut = tagEnd - CLOSE.length;
    if (s.slice(0, cut).endsWith('\r\n')) cut -= 2;
    else if (s.slice(0, cut).endsWith('\n')) cut -= 1;
    s = s.slice(0, cut) + s.slice(tagEnd);
  }

  return s;
}

// ===== handleDeskChat =====
export async function handleDeskChat(
  env: DeskChatEnv,
  params: DeskChatParams,
  storage: DeskChatStorage,
  signal?: AbortSignal,
  waitUntil?: (promise: Promise<unknown>) => void
): Promise<Response> {
  // deskReadJsonLimited(index.ts)只挡"不是合法JSON"和"超10MB",合法JSON的 null/数组/字符串
  // 照样会被当成 body 传进来——这里补一道形状闸,同 tools/desk.ts 系列 handler 的开头习惯。
  if (!params || typeof params !== 'object') return errJson('请求体不对');
  // 旧 continue 请求必须拒绝，不能按 normal 落一条空 user 楼。
  if (params.continue) return errJson('续写功能已下线', 400);
  const windowId = typeof params.window_id === 'string' ? params.window_id.trim() : '';
  if (!windowId) return errJson('window_id 必填');
  const roll = !!params.roll;

  const message = typeof params.message === 'string' ? params.message.trim() : '';
  if (!roll) {
    if (!message) return errJson('message 不能为空');
    if (message.length > MESSAGE_MAX) return errJson(`message 太长了(上限${MESSAGE_MAX}字)`);
  }
  const channelError = validateDeskChannelConfig(env);
  if (channelError) return errJson(channelError, 500);

  const usageSink = makeD1UsageSink(env);
  const { deskStorage, turnStorage, deskAssets, deskStory, semantic } = storage;
  const model = params.model && MODEL_PROFILES[params.model] ? params.model : DESK_DEFAULT_MODEL;

  // 1) 载入写作窗
  let win: any;
  try {
    win = await deskStorage.getWindow(windowId);
  } catch (e: any) {
    return errJson(e.message, 500);
  }
  if (!win) return errJson('写作窗不存在', 404);

  const project = String(win.project);
  const recipeId = String(win.recipeId);
  const note = String(win.note || '');
  const noteDepth = Number(win.noteDepth);
  const stateBoard = win.stateBoard;
  const windowVars = win.vars;

  // 2) roll 要落在"最后一楼且是assistant"上——先查清楚,不合规矩当场拒
  let lastFloor: any = null;
  if (roll) {
    try {
      const all = await deskStorage.listFloors(windowId);
      lastFloor = all.length ? all[all.length - 1] : null;
    } catch (e: any) {
      return errJson(e.message, 500);
    }
    if (!lastFloor || lastFloor.role !== 'assistant') {
      return errJson('最后一楼不是模型的回复,不能重roll');
    }
  }

  // 3) 时光带:读状态→渲染正文→算 cutoff,给下面查"未折叠楼层"用
  let timelineState: any = null;
  try {
    timelineState = await loadDeskTimelineState(env as any, windowId);
  } catch (e) {
    console.error('[desk] 读时光带状态失败,按无时光带走', e);
  }
  const timelineText = renderTimelineText(timelineState);
  const cutoff = timelineState?.cutoff ? parseDeskTimelineCutoff(timelineState.cutoff) : null;
  let afterCutoffFloors: any[] = [];
  let allFloors: any[] = [];
  try {
    // report 列也要select上:roll模式要从里头挖上一楼的 boardAfter 快照(见下方 mode==='roll' 分支)。
    allFloors = await deskStorage.listFloors(windowId);
    afterCutoffFloors = cutoff ? allFloors.filter((floor) => floor.createdAt > cutoff.t || (floor.createdAt === cutoff.t && floor.id > cutoff.id)) : allFloors;
  } catch (e: any) {
    return errJson(e.message, 500);
  }

  // 4) 普通轮存楼层，并按模式拼装 floors/input。
  let userFloorId: string | null = null;
  let assembleFloors: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let assembleInput = '';
  const mode: 'normal' | 'roll' = roll ? 'roll' : 'normal';
  // roll 优先使用目标楼当初的 boardBefore；老数据再回溯前一 assistant 的 boardAfter。
  let rollStateBoard: any = null;
  let foundRollBoard = false;

  if (mode === 'normal') {
    userFloorId = genId('fl');
    const now0 = new Date().toISOString();
    try {
      await deskStorage.createFloor({ id: userFloorId, windowId, role: 'user', content: message, variants: [message], activeVariant: 0, thinking: null, report: {}, createdAt: now0 });
    } catch (e: any) {
      return errJson(`存用户楼层失败: ${e.message}`, 500);
    }
    // afterCutoffFloors 是存这条之前查的,天然不含它——正好是"此楼之前的近景"
    assembleFloors = afterCutoffFloors.slice(-HISTORY_CAP).map((f: any) => ({ role: f.role, content: f.content }));
    assembleInput = message;
  } else if (mode === 'roll') {
    // 去掉待重roll的那条assistant自己;再往前若紧跟着一条user楼层,摘出来当input(那条assistant
    // 本来就是在回答它),没有就input留空(理论edge case:窗口首楼就是assistant,靠手改楼层造出来的)
    const beforeLast = afterCutoffFloors.filter((f: any) => f.id !== lastFloor.id);
    // 重生成必须使用目标楼当初实际装配的输入板，不能使用已被该楼推进后的窗口现状。
    // boardBefore 是权威快照；缺失时才沿旧楼 boardAfter 回溯。只接受纯对象，畸形值继续向前找。
    const lastRep = lastFloor.report;
    const bb = lastRep && typeof lastRep === 'object' && !Array.isArray(lastRep) ? (lastRep as any).boardBefore : undefined;
    if (bb && typeof bb === 'object' && !Array.isArray(bb)) {
      rollStateBoard = bb; // 空对象{}也是合法快照(首楼无预置时它就是{}),truthy 判断放得进来
      foundRollBoard = true;
    } else {
      // 老楼没有 boardBefore 时回溯前一 assistant 的 boardAfter；再无则退回窗口现状。
      for (let i = beforeLast.length - 1; i >= 0; i--) {
        const f = beforeLast[i];
        if (f.role !== 'assistant') continue;
        const rep = f.report;
        if (!rep || typeof rep !== 'object' || Array.isArray(rep) || !Object.prototype.hasOwnProperty.call(rep, 'boardAfter')) {
          break; // 旧数据没有 boardAfter 字段:回溯到此为止,老口径回退 window.state_board
        }
        const ba = rep.boardAfter;
        if (ba && typeof ba === 'object' && !Array.isArray(ba)) {
          rollStateBoard = ba;
          foundRollBoard = true;
          break; // 命中有效板
        }
        // boardAfter 键在,但值是 null/数组/字符串等畸形:这楼当时也没有有效板,继续往前找上一条assistant楼
      }
    }
    let hist = beforeLast;
    if (beforeLast.length && beforeLast[beforeLast.length - 1].role === 'user') {
      assembleInput = beforeLast[beforeLast.length - 1].content;
      hist = beforeLast.slice(0, -1);
    }
    assembleFloors = hist.slice(-HISTORY_CAP).map((f: any) => ({ role: f.role, content: f.content }));
  }

  // 5) 装配产出 system、tail 与 report。roll 使用可信快照，normal 使用窗口现状。
  const effectiveStateBoard: Record<string, any> =
    mode === 'roll' && foundRollBoard
      ? (rollStateBoard && typeof rollStateBoard === 'object' ? rollStateBoard : {})
      : stateBoard;
  const assembled = await assembleDesk({ deskAssets, deskStory, semantic }, {
    project, recipeId, input: assembleInput,
    floors: assembleFloors, note, noteDepth,
    stateBoard: effectiveStateBoard, vars: windowVars, timeline: timelineText,
  });
  if (!assembled.success) return errJson(assembled.error || '装配失败', 500);
  const systemBlocks: Array<{ text: string; cache: boolean }> = assembled.system;
  const tail: string = assembled.tail;
  const report: any = assembled.report;

  // ===== SSE 骨架(照 editorial.ts 原样克隆)=====
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let clientGone = false;

  const send = async (obj: any) => {
    if (clientGone) return;
    try { await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)); }
    catch { clientGone = true; }
  };

  if (signal) {
    if (signal.aborted) clientGone = true;
    else signal.addEventListener('abort', () => { clientGone = true; }, { once: true });
  }

  // ===== 落库收尾(状态板剥离+楼层写入,两种轮次分支)=====
  // 返回落到的 floorId；只有 roll 撞上并发改动才返回 conflict，普通提交失败按存档异常上抛。
  // 楼层变更与窗口板必须在同一 D1 batch 原子提交；roll 的窗口写还须由楼层 CAS 后置状态守卫。
  // roll 绑定请求起点的楼层快照；生成期间若被切版本、重生成或手改，整轮结果与状态板一并作废。
  // 所有楼层变更都须先 invalidate 时光带、写后再 fence；busy 直接报冲突。
  async function finalizeDeskTurn(allText: string, allThinking: string): Promise<{ floorId: string } | { conflict: true }> {
    const { content: rawContent, board } = parseStateBoard(allText);
    // 先剥状态板，再于落库前剥正文最外层 <content> 壳。
    const content = unwrapContentTag(rawContent);
    const now = new Date().toISOString();
    // appliedBoard 是本轮实际生效板：解析成功用新板，否则继承装配输入板。
    // report.boardAfter 与 window.state_board 必须使用同一值；stale 仍以 board===null 判定。
    const appliedBoard: Record<string, any> = board !== null ? board : effectiveStateBoard;
    // 每次提交生成唯一 commitToken，供 roll 窗口 UPDATE 确认是本次楼层写入。
    // boardBefore 只保存可信输入快照；老楼 roll 回退的推测板不得升格成权威档案。
    const boardBeforeTrusted = mode === 'normal' || foundRollBoard;
    const reportOut = { ...report, stateBoardStale: board === null, ...(boardBeforeTrusted ? { boardBefore: effectiveStateBoard } : {}), boardAfter: appliedBoard };
    let floorId = '';

    // 楼层写与窗口板 UPDATE 同事务；任一失败整批回滚，禁止半截态。
    if (mode === 'normal') {
      floorId = genId('fl');
      // normal的INSERT不是CAS语句(没有WHERE碰撞条件),窗口UPDATE不需要额外EXISTS守卫——只要
      // INSERT没抛错(主键冲突/瞬时故障会抛错,批内抛错整批回滚,两条都不落),批内第二条必然执行
      // 且必然命中(WHERE id=?只按主键定位,这一行在1)载入写作窗时已经查到过,请求处理期间不会
      // 被并发删除窗口)。
      const committed = await turnStorage.commitAssistantFloor(windowId, floorId, { content, thinking: allThinking.trim() || null, report: reportOut, stateBoard: appliedBoard, committedAt: now });
      if (!committed) throw new Error('写作窗已不存在或提交冲突');
    } else if (mode === 'roll') {
      floorId = String(lastFloor.id);
      const inv = await invalidateDeskTimelineIfFolded(env as any, windowId, String(lastFloor.createdAt), floorId);
      if (inv === 'busy') throw new Error('时光带正在被后台折叠,稍等几秒再试');

      // 窗口 UPDATE 的 EXISTS 必须验证楼层后置状态中的唯一 commitToken，不能只验 variant 形状；
      // 并发 roll 可能产生相同形状。冲突仍以第一条楼层 CAS 的 changes 判定。
      const committed = await turnStorage.rollAssistantFloor({ windowId, floorId, expected: lastFloor, commit: { content, thinking: allThinking.trim() || null, report: reportOut, stateBoard: appliedBoard, committedAt: now } });
      if (!committed) return { conflict: true };

      await fenceDeskTimelineAfterWrite(env as any, windowId, inv.rev, { createdAt: String(lastFloor.createdAt), id: floorId });
    }

    return { floorId };
  }

  // ===== 模型泵:直连 Anthropic,单条 user 消息(content=tail),零工具——不像
  // editorial.ts 的 pump 那样要跑 MAX_TURNS 工具回合循环,一次请求打到底,一次流读到底。=====
  const pumpBackend = async () => {
    if (mode === 'normal') await send({ type: 'user_saved', id: userFloorId });
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const backend = new AnthropicStreamBackend({ apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL, userId: USER_ID });
    let failed = false;
    const result = await backend.streamChat({ system: systemBlocks, prompt: tail, model, signal: controller.signal, onEvent: async (event) => {
      if (clientGone) { controller.abort(); return; }
      if (event.type === 'text') await send({ type: 'text', text: event.text });
      else if (event.type === 'thinking') await send({ type: 'thinking', text: event.text });
      else if (event.type === 'ping') await send({ type: 'ping' });
      else if (event.type === 'usage') await send({ type: 'usage', input: event.usage.input || 0, cache_read: event.usage.cacheRead || 0, cache_write: event.usage.cacheWrite || 0 });
    } });
    signal?.removeEventListener('abort', abort);
    if (!result.ok) {
      failed = result.kind !== 'aborted';
      if (!clientGone && result.kind !== 'aborted') await send({ type: 'error', error: `模型渠道未正常收尾(${result.kind})，这轮没有存档` });
    } else {
      try {
        const saved = await finalizeDeskTurn(result.text, result.thinking);
        if ('conflict' in saved) { failed = true; await send({ type: 'error', error: '这一楼在生成期间被改动过,本次结果已丢弃,请重试' }); }
        else await send({ type: 'done', id: saved.floorId });
      } catch (error: any) { failed = true; await send({ type: 'error', error: `存档失败: ${error.message}` }); }
    }
    const usage = result.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try { const log = () => usageSink.logUsage('desk', model, { input: usage.input, output: usage.output, cache_read: usage.cacheRead, cache_write: usage.cacheWrite }, failed ? 'failed' : 'ok'); if (waitUntil) waitUntil(log()); else await log(); } catch (error) { console.error('[desk] 记账失败(不拖垮存档)', error); }
    try { await writer.close(); } catch {}
    if (waitUntil) waitUntil(maybeFoldDeskTimeline(env as any, windowId)); else maybeFoldDeskTimeline(env as any, windowId);
  };

  const chosen = pumpBackend;
  if (waitUntil) waitUntil(chosen());
  else chosen();

  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS },
  });
}
