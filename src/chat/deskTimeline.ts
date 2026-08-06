// 打字桌时光带：采用 CAS + 双栅栏，把较早楼层压成分段场景总结：
//   desk_windows.timeline_state = {segs: [{text, upto}], cutoff: string|null, rev: number}
// segs 每段是独立的场景总结(折一次追加一段,不做 editorial 那种"增量合并重写整条 body"),
// upto=那一段折叠时的复合游标("created_at|id",跟折叠这段用掉的最后一条楼层对齐);
// cutoff=全局水位(=最新一段的 upto),折叠/装配都认它。
//
// 触发口径:TRIGGER=20(cutoff之后超过20层才动手),KEEP=6(近景留原文),BATCH_MAX=16(单批上限)。
//
// 建窗必须显式写入 SEED_TIMELINE_STATE，不能依赖 SQL DEFAULT '{}'，否则 $.rev 为 NULL、首次 CAS 永远失败。
// 读取畸形 JSON 时可条件修复；本模块不负责给不存在的窗口播种。

import { makeD1UsageSink } from '../storage/usageSink.ts';
import { completeText, type CompleteTextUsage } from './modelBackend.ts';
import { DESK_TIMELINE_KEEP } from '../core/deskLimits.ts';
export { DESK_TIMELINE_KEEP } from '../core/deskLimits.ts';

interface DeskTimelineEnv {
  OC_DB: D1Database;
  [k: string]: any;
}

export interface TimelineSeg {
  text: string;
  upto: string; // 折这一段时用掉的最后一条楼层的复合游标 "created_at|id"
}

export interface TimelineState {
  segs: TimelineSeg[];
  cutoff: string | null; // = segs 最后一段的 upto;没折过是 null
  rev: number;
}

export const SEED_TIMELINE_STATE: TimelineState = { segs: [], cutoff: null, rev: 0 };

const TRIGGER = 20;
const KEEP = DESK_TIMELINE_KEEP;
// 单批最多折 BATCH_MAX 层；积压必须分批，防止过高压缩比造成剧情断层。
const BATCH_MAX = 16;
// 手动与自动折叠共享默认留白常量，调用方不得复制字面量。
const SEG_CAP = 20; // segs 数组硬顶,超了丢最老一段(策略见 maybeFoldDeskTimeline 里的注释)

// 模型调用统一走 completeText（直连 Anthropic API）。
const SUM_MODEL = 'claude-sonnet-4-6'; // 时光带是长剧情逻辑归纳,跟客厅BP3摘要主力同档;不跟打字桌聊天默认档走

// 文学向场景总结只要求完整剧情、事实/认知区分和纯正文输出。
// 上一段仍只作承接参考，输出事实唯一来源是本轮楼层，绝不把旧段滚动重写进新段。
const SUM_SYS_DESK =
  `你正在为连载小说整理「时光带」剧情摘要。

待概括素材为 <楼层原文>。若附带【上一段时光带】，仅用于理解剧情承接；所有总结内容只能来源于 <楼层原文>，禁止复述、重写旧时光带内容。

总结时遵守以下规则：

1-以自然段落形式总结压缩剧情，字数控制在500左右。

2-注意区分客观事实和角色认知。

3-最后仅输出时光带的总结正文。

总结完再次检查字数；摘要正文不得超过500字，若超出则继续压缩后再输出。`;

// 摘要只读 assistant 楼的小说正文。打字桌预设的常见输出形状是:
//   <content>小说正文</content>\n<meow_FM>本楼小结…</meow_FM>
// finalizeDeskTurn 的 unwrapContentTag 只会剥包住“整条回复”的最外层壳；由于 </content> 后还有
// meow_FM，它落库时常变成“正文</content><meow_FM>…”。摘要侧只认独立成行、紧邻完整 meow
// 协议块的闭标签；软协议缺失或畸形时全文回退，宁可留一点噪音也不误删正文。这里只处理送摘要
// 的临时副本，D1 正本一字不动。
export function extractDeskTimelineAssistantBody(raw: unknown): string {
  let text = String(raw ?? '');
  const meowOpen = /^[ \t]*<meow_FM>[ \t]*$/m.exec(text);
  const meowClose = meowOpen
    ? /^[ \t]*<\/meow_FM>[ \t]*$/m.exec(text.slice(meowOpen.index + meowOpen[0].length))
    : null;
  let end = text.length;

  // 只认独立行协议标签。若有一对完整 meow_FM，真正的 </content> 应是它前面最后一枚、两者
  // 之间只有空白；这样正文代码块/对白里字面引用的标签不会把后文腰斩。没有完整 meow 块时，
  // 只认位于全文尾部(其后仅空白)的闭标签。畸形/漏闭协议宁可原样喂成一点噪音，也不冒险误删正文。
  const closes = [...text.matchAll(/^[ \t]*<\/content>[ \t]*$/gm)];
  if (meowOpen && meowClose) {
    const realClose = closes
      .filter((m) => (m.index ?? -1) < meowOpen.index && !text.slice((m.index ?? 0) + m[0].length, meowOpen.index).trim())
      .at(-1);
    if (realClose?.index != null) end = realClose.index;
  } else {
    const trailingClose = closes.filter((m) => !text.slice((m.index ?? 0) + m[0].length).trim()).at(-1);
    if (trailingClose?.index != null) end = trailingClose.index;
  }
  text = text.slice(0, end);

  // 某些旧楼/导入楼可能仍保留开标签；只剥正文最前面的那一枚，不碰故事中段的字面标签。
  const leading = text.match(/^(\s*)<content>(?:\r?\n)?/);
  if (leading) text = leading[1] + text.slice(leading[0].length);
  return text.trimEnd();
}

// assistant-only 摘要的水位守门。手动 keep 或生成中的瞬间可能把候选批次切在 user 后；摘要没看
// 那条尚未得到回复的尾楼，就不能让 cutoff 越过去。生成失败留下的早期孤儿 user 不构成永久路障：
// 正常 UI 的“孤儿楼重发”会先删掉它；裸 API/历史异常若形成 user/user…assistant，后面的 assistant
// 才是已经落库的剧情正本，允许连同此前输入一起越线。终点始终钉在候选范围内最后一条 assistant。
export function selectDeskTimelineFoldBatch<T extends { role?: unknown }>(candidate: T[]): T[] {
  let lastSafe = -1;
  for (let i = 0; i < candidate.length; i++) {
    const role = candidate[i]?.role;
    if (role === 'assistant') {
      lastSafe = i;
      continue;
    }
    if (role === 'user') continue;
    break;
  }
  return lastSafe >= 0 ? candidate.slice(0, lastSafe + 1) : [];
}

function parseTimelineState(raw: string | null | undefined): TimelineState | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (
      p && Array.isArray(p.segs) && p.segs.every((s: any) => s && typeof s.text === 'string' && typeof s.upto === 'string') &&
      (p.cutoff === null || typeof p.cutoff === 'string') && typeof p.rev === 'number' && Number.isFinite(p.rev)
    ) {
      return { segs: p.segs, cutoff: p.cutoff, rev: p.rev };
    }
  } catch { /* 坏形状走下面的修复路 */ }
  return null;
}

// 读某个写作窗的时光带状态。窗口行本身必须存在(desk_windows 是行存表,不是 oc_state 那种kv,
// 没有"key不存在先播种"这一步——建窗时就该把种子 JSON 存进 timeline_state,见文件顶注释)。
// 返回 null = 窗口不存在;坏 JSON/坏形状 = 尝试条件修复(同 editorialSummary 那套,绑住读到的
// 坏值再覆盖,防止误杀并发对手刚写好的有效 blob)。
export async function loadDeskTimelineState(env: DeskTimelineEnv, windowId: string): Promise<TimelineState | null> {
  const sel = () => env.OC_DB.prepare(`SELECT timeline_state FROM desk_windows WHERE id = ?`).bind(windowId).first<any>();
  const row = await sel();
  if (!row) return null;
  const raw = row.timeline_state == null ? '' : String(row.timeline_state);
  const st = parseTimelineState(raw);
  if (st) return st;
  console.error(`[desk-timeline] window ${windowId} timeline_state 坏形状,尝试重置回种子`);
  const res = await env.OC_DB.prepare(
    `UPDATE desk_windows SET timeline_state = ?, updated_at = ? WHERE id = ? AND timeline_state = ?`
  ).bind(JSON.stringify(SEED_TIMELINE_STATE), new Date().toISOString(), windowId, raw).run();
  if ((res.meta?.changes ?? 0) !== 1) {
    const again = parseTimelineState((await sel())?.timeline_state);
    if (again) return again; // 对手写入了有效值,以它为准
  }
  return { ...SEED_TIMELINE_STATE };
}

// 唯一写入口:绑旧 rev 的条件 UPDATE,单语句天然原子(同 editorialSummary casWriteState 的家法)。
async function casWriteTimeline(env: DeskTimelineEnv, windowId: string, expectRev: number, next: TimelineState): Promise<boolean> {
  const res = await env.OC_DB.prepare(
    `UPDATE desk_windows SET timeline_state = ?, updated_at = ? WHERE id = ? AND json_extract(timeline_state, '$.rev') = ?`
  ).bind(JSON.stringify(next), new Date().toISOString(), windowId, expectRev).run();
  return (res.meta?.changes ?? 0) === 1;
}

function parseCutoffComposite(raw: string | null): { t: string; id: string } | null {
  if (!raw) return null;
  const i = raw.lastIndexOf('|');
  if (i < 0) return null;
  const t = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (!t || !id) return null;
  return { t, id };
}
export { parseCutoffComposite as parseDeskTimelineCutoff };

// 复合序严格小于(同 editorial 家族一条家法:先比 created_at,同毫秒再比 id 字典序)。
function compositeLt(a: { t: string; id: string }, b: { t: string; id: string }): boolean {
  return a.t < b.t || (a.t === b.t && a.id < b.id);
}

// 第 k 段覆盖 (segs[k-1].upto, segs[k].upto]。楼层变更只作废命中段及其后续，
// 更早段保留，cutoff 回退到最后幸存段；原始楼层仍在，后续可自动重折。
// upto 坏形状(理论上进不来,parseTimelineState 已经卡住非字符串)按"从这里往后都不可信"处理,
// 保守地把它和它之后的段一起丢掉,不冒险留下一段边界不明的摘要。
function trimSegsBefore(segs: TimelineSeg[], target: { t: string; id: string }): { segs: TimelineSeg[]; cutoff: string | null } {
  const kept: TimelineSeg[] = [];
  for (const seg of segs) {
    const u = parseCutoffComposite(seg.upto);
    if (!u || !compositeLt(u, target)) break;
    kept.push(seg);
  }
  return { segs: kept, cutoff: kept.length ? kept[kept.length - 1].upto : null };
}

// 给 deskAssemble 调用方(chat/desk.ts)拼装 timeline 参数用:把 segs 渲染成一段纯文本
// (段落间空行分隔,按折叠顺序=时间顺序,天然衔接"近期章→时光带→近景"的故事水流)。
export function renderTimelineText(state: TimelineState | null): string {
  if (!state || !state.segs.length) return '';
  return state.segs.map((s) => s.text).join('\n\n');
}

// 手动校订只允许改每段正文，不允许前端挪 cutoff/upto 或增删段落。expectedRev 把打开面板时的
// 快照钉住：后台折叠若先落库，CAS 0 命中并明说冲突，绝不让旧草稿覆盖新时光带。
export async function updateDeskTimelineTexts(
  env: DeskTimelineEnv, windowId: string, expectedRev: number, texts: string[]
): Promise<{ success: true; state: TimelineState } | { success: false; error: string; conflict?: boolean }> {
  if (!Number.isInteger(expectedRev) || expectedRev < 0) return { success: false, error: 'timeline_rev 不合法' };
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) return { success: false, error: 'timeline_texts 必须是字符串数组' };
  if (texts.some((t) => !t.trim())) return { success: false, error: '时光带段落不能为空' };
  if (texts.some((t) => t.length > 8000) || texts.reduce((n, t) => n + t.length, 0) > 40000) {
    return { success: false, error: '时光带内容过长' };
  }
  const state = await loadDeskTimelineState(env, windowId);
  if (!state) return { success: false, error: '写作窗不存在' };
  if (state.rev !== expectedRev || state.segs.length !== texts.length) {
    return { success: false, error: '时光带已被后台更新，请重新打开后再编辑', conflict: true };
  }
  const next: TimelineState = {
    segs: state.segs.map((seg, i) => ({ ...seg, text: texts[i].trim() })),
    cutoff: state.cutoff,
    rev: state.rev + 1,
  };
  if (!(await casWriteTimeline(env, windowId, expectedRev, next))) {
    return { success: false, error: '时光带已被后台更新，请重新打开后再编辑', conflict: true };
  }
  return { success: true, state: next };
}

// 给 chat/desk.ts 查"cutoff之后的楼层"用(同 editorialSummary getEditorialSummaryCutoff 的角色)。
export async function getDeskTimelineCutoff(env: DeskTimelineEnv, windowId: string): Promise<{ t: string; id: string } | null> {
  try {
    const st = await loadDeskTimelineState(env, windowId);
    return st ? parseCutoffComposite(st.cutoff) : null;
  } catch (e) {
    console.error('[desk-timeline] 读游标失败,按无游标算', e);
    return null;
  }
}

// 前栅栏(照 editorialSummary invalidateSummaryIfFolded):楼层变更(编辑/truncate)前调用。
// 目标复合序 (targetCreatedAt,targetId) 落在折叠区(≤cutoff)→ 从它所在的那一段起往后作废
// (更早的段保留,cutoff 回退到最后一个幸存段;丢掉的区间原始楼层都在,下一轮聊天收尾自动重折);
// 不在折叠区→只推一格 rev(杀在途折叠的陈旧快照,同 editorialSummary 的"clean"分支)。
// 复合序比较跟 editorial 家族同一条家法。status 只是给调用方看的说明,三态:
// clean=没碰到折叠区 / trim=砍了尾巴还剩几段 / reset=一段不剩(等价于老口径的整条作废)。
export async function invalidateDeskTimelineIfFolded(
  env: DeskTimelineEnv, windowId: string, targetCreatedAt: string, targetId: string
): Promise<{ status: 'clean' | 'trim' | 'reset'; rev: number } | 'busy'> {
  const target = { t: targetCreatedAt, id: targetId };
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = await loadDeskTimelineState(env, windowId);
    if (!st) return { status: 'clean', rev: 0 }; // 窗口都不存在了,没什么好作废的,调用方走它自己的404
    const c = st.cutoff ? parseCutoffComposite(st.cutoff) : null;
    const folded = !!c && !compositeLt(c, target); // target ≤ cutoff:这楼已经被折进去了
    const trimmed = folded ? trimSegsBefore(st.segs, target) : { segs: st.segs, cutoff: st.cutoff };
    const next: TimelineState = { segs: trimmed.segs, cutoff: trimmed.cutoff, rev: st.rev + 1 };
    if (await casWriteTimeline(env, windowId, st.rev, next)) {
      const status = !folded ? 'clean' : next.segs.length ? 'trim' : 'reset';
      return { status, rev: next.rev };
    }
  }
  return 'busy';
}

// 后栅栏(照 editorialSummary fenceSummaryAfterWrite,但只有一种收拾模式——desk 没有 editorialClear
// 那种"清空聊天保留提要正文"的对应功能,所以不需要 'zeroCutoff' 那第二种收拾语义,撞车统一整个作废)。
// expectedRev=前栅栏推完的 rev;intact=窗口期没人动过→纯推格;落空=窗口期有人折叠/手改过→收拾。
// target=这次改的那一楼(跟前栅栏用的是同一个锚点):撞车时按它做同一套"只砍受影响那段及之后"的
// 裁剪,不再一刀清空整条(理由见 trimSegsBefore 上面那段)。target 缺席才退回老的整条 wipe——
// 没有锚点就无从判断哪一段可信,只能保守全丢;仓库内所有调用方都带着锚点,这条是留给未来调用方的兜底。
export async function fenceDeskTimelineAfterWrite(
  env: DeskTimelineEnv, windowId: string, expectedRev: number | null, target?: { createdAt: string; id: string }
): Promise<boolean> {
  const anchor = target ? { t: target.createdAt, id: target.id } : null;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const st = await loadDeskTimelineState(env, windowId);
      if (!st) return true; // 窗口已经不存在(比如这就是窗口删除流程里的一环),没什么好收拾的
      const intact = expectedRev !== null && st.rev === expectedRev;
      const settled = intact
        ? { segs: st.segs, cutoff: st.cutoff }
        : anchor ? trimSegsBefore(st.segs, anchor) : { segs: [] as TimelineSeg[], cutoff: null };
      const next: TimelineState = { segs: settled.segs, cutoff: settled.cutoff, rev: st.rev + 1 };
      if (await casWriteTimeline(env, windowId, st.rev, next)) return true;
    }
    console.error(`[desk-timeline] window ${windowId} 后栅栏五次都撞车(异常拥挤)——留观,同 editorialSummary 先例不上持久恢复标记`);
    return false;
  } catch (e: any) {
    console.error(`[desk-timeline] window ${windowId} 后栅栏异常(消息变更本身已生效): ${e?.message || e}`);
    return false;
  }
}

// 检查并(必要时)把某个写作窗较早的楼层折进时光带一段新场景总结。跑在 ctx.waitUntil 里,不卡前端
// (chat/desk.ts 每轮聊天收尾挂载,照 editorial.ts 挂 maybeCompressEditorial 的姿势)。
// opts.keep 指定保留原文层数；非法值退回 KEEP，0 合法。
export async function maybeFoldDeskTimeline(
  env: DeskTimelineEnv, windowId: string, ctx?: ExecutionContext, opts: { force?: boolean; keep?: number } = {}
): Promise<any> {
  const model = SUM_MODEL;
  const usageSink = makeD1UsageSink(env);
  const keep = Number.isInteger(opts.keep) && (opts.keep as number) >= 0 ? (opts.keep as number) : KEEP;
  // API usage 放在函数级作用域，确保 CAS 异常与 superseded 分支也能记账；vps 无 usage。
  let apiUsage: CompleteTextUsage | undefined;
  try {
    const state = await loadDeskTimelineState(env, windowId);
    if (!state) return { success: true, acted: false, skip: 'window_gone' };
    const cutoff = parseCutoffComposite(state.cutoff);

    const cond = cutoff ? ' AND (created_at > ? OR (created_at = ? AND id > ?))' : '';
    const binds = cutoff ? [cutoff.t, cutoff.t, cutoff.id] : [];
    const tail = (
      await env.OC_DB.prepare(
        `SELECT id, role, content, created_at FROM desk_floors WHERE window_id = ? AND content != ''${cond} ORDER BY created_at ASC, id ASC`
      ).bind(windowId, ...binds).all<any>()
    ).results as any[];

    if (!opts.force && tail.length <= TRIGGER) {
      return { success: true, acted: false, skip: 'not_enough', tail: tail.length };
    }

    const candidate = tail.slice(0, Math.min(Math.max(0, tail.length - keep), BATCH_MAX));
    if (candidate.length === 0) {
      return { success: true, acted: false, skip: 'nothing_to_fold', tail: tail.length };
    }
    const toFold = selectDeskTimelineFoldBatch(candidate);
    if (toFold.length === 0) {
      return { success: true, acted: false, skip: 'unpaired_user', tail: tail.length };
    }
    const lastFold = toFold[toFold.length - 1];
    const newUpto = `${lastFold.created_at}|${lastFold.id}`;

    // 时光带只喂 assistant 正文：user 楼里的 OOC/导演指令不进摘要，assistant 楼尾的 meow_FM/
    // 小剧场也由 extractDeskTimelineAssistantBody 截掉。水位与折叠批次仍按全部楼层推进——只是模型
    // 看到的临时素材变干净，不改变 cutoff/upto 的账本语义。软协议缺席就用 assistant 全文回退。
    const lines = toFold
      .filter((m) => m.role === 'assistant')
      .map((m) => extractDeskTimelineAssistantBody(m.content)
        .replace(/<楼层原文>/g, '＜楼层原文＞').replace(/<\/楼层原文>/g, '＜/楼层原文＞')
      )
      .filter((text) => text.trim())
      .join('\n\n');
    if (!lines.trim()) {
      await usageSink.logUsage('desk-timeline', model, undefined, 'failed');
      return { success: false, acted: false, error: '本批没有可供总结的 assistant 正文' };
    }
    const priorSeg = state.segs.length ? state.segs[state.segs.length - 1] : null;
    const user = (priorSeg ? `【上一段时光带｜仅作承接参考，禁止复述】\n${priorSeg.text}\n\n` : '') +
      `【本轮楼层原文｜唯一摘要来源】\n<楼层原文>\n${lines}\n</楼层原文>`;

    // 渠道守门(文案主权在本文件,合同层只回结构化终态):缺 key 在动手前拦下。
    if (!env.ANTHROPIC_API_KEY) {
      console.error('[desk-timeline] ANTHROPIC_API_KEY 没配,摘要走不通');
      await usageSink.logUsage('desk-timeline', model, undefined, 'failed');
      return { success: false, acted: false, error: 'ANTHROPIC_API_KEY 没配' };
    }

    // completeText 只返回结构化终态；时光带文案在本层翻译。API 截断/拒答也必须记真实 usage。
    let text = '';
    {
      const r = await completeText(env, { system: SUM_SYS_DESK, prompt: user, model });
      apiUsage = r.usage;
      if (!r.ok) {
        const reason =
          r.kind === 'no_key' ? 'ANTHROPIC_API_KEY 没配' :
          r.kind === 'http' ? `summary ${r.detail}` :
          r.kind === 'empty' ? `summary ${r.detail || 'empty'}` :
          r.kind === 'truncated' ? 'summary 被 max_tokens 截断,这批不落库、下轮重试' :
          r.kind === 'refusal' ? 'summary 被模型拒答(refusal),这批不落库' :
          r.kind === 'timeout' ? 'summary 100s 超时被砍,下轮重试' :
          `summary fetch 失败: ${r.detail}`;
        console.error(`[desk-timeline] ${reason}`);
        await usageSink.logUsage('desk-timeline', model, apiUsage, 'failed');
        return { success: false, acted: false, error: reason };
      }
      text = String(r.text).trim();
    }
    if (!text) {
      await usageSink.logUsage('desk-timeline', model, apiUsage, 'failed');
      return { success: false, acted: false, error: 'empty summary' };
    }

    // 最多保留 20 段，超限丢弃最老摘要段；原始楼层不删除。
    let nextSegs = [...state.segs, { text, upto: newUpto }];
    if (nextSegs.length > SEG_CAP) nextSegs = nextSegs.slice(nextSegs.length - SEG_CAP);

    const wrote = await casWriteTimeline(env, windowId, state.rev, { segs: nextSegs, cutoff: newUpto, rev: state.rev + 1 });
    if (!wrote) {
      // API 已调用即使被并发折叠抢先也要记账；vps 无 usage。
      if (apiUsage) {
        try { await usageSink.logUsage('desk-timeline', model, apiUsage, 'ok'); } catch {}
      }
      return { success: true, acted: false, skip: 'superseded', myOpeningRev: state.rev };
    }

    await usageSink.logUsage('desk-timeline', model, apiUsage, 'ok');
    // 一次最多折一批，不保证清空积压；调用方必须读取 more，不能用固定留白推断。
    const remaining = tail.length - toFold.length;
    return {
      success: true, acted: true, folded: toFold.length, remaining,
      more: remaining > keep, batchMax: BATCH_MAX,
      newCutoff: newUpto, segCount: nextSegs.length,
    };
  } catch (e: any) {
    const reason = `desk-timeline 意外炸了: ${e?.message || e}`;
    console.error(`[desk-timeline] ${reason}`);
    try { await usageSink.logUsage('desk-timeline', model, apiUsage, 'failed'); } catch {}
    return { success: false, acted: false, error: reason };
  }
}
