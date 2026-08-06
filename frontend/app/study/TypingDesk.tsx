'use client';

// ✍️ 打字桌 —— AI 写作/聊天窗口的正文界面。
// 沿用同一套聊天界面的通用规则:全屏 early-return、SSE 读取(data: 行解析)、genRef 世界代数、
// IME 安全回车、iOS 键盘兜底、localStorage 草稿。跟单一会话的聊天界面最大的不同——这里是
// "多窗口"(用户可以同时开好几本书的好几扇窗),单会话场景只有一条全局会话,没有"切窗口时旧
// 世界的流式回调还在飞"这种问题;这边额外加了 myGen 闭包快照 + 每次 setFloors/loadWindow 前
// 比对 genRef,防止切窗/返回列表后旧窗口的 SSE 回调把新窗口的画面糊错(这套命名沿用"世界翻篇"
// 这个说法)。
//
// 通用规则:fetch 全 try/catch,res.ok && body.success 双验,变更类请求收紧到 success===true 才算数,
// 加载/错误/空态三态分开,颜色只走 var(--xxx)。
//
// 默认极简原则:开新窗=选project(当前项目tab)→选配方→(可选)标题→开窗,三步零仪式感;
// 积木/世界书/正则这些"抽屉"通通走独立的抽屉面板,不在主流程里。

import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import DeskDrawerHub, { type DeskDrawerHandle, type DeskDrawerTabKey } from './DeskDrawers';
import LoreWindow from './LoreWindow';
import { applyDownRegex, segmentRendered, buildCardSrcDoc, DESK_CARD_MAX_HEIGHT, foldProtocolBlocks, unwrapContentTagClient, type DeskRegexRule, type RenderSegment, type FoldPart } from './deskRender';

// ── 数据形状(照后端 tools/deskWindows.ts / deskRecipes.ts / tools/desk.ts / chat/deskAssemble.ts 的真实返回来,字段名不许自己发明) ──
type Weight = 'light' | 'heavy';
// project:后端list每行实际返回(deskWindows.ts SELECT带project)——这个类型此前漏声明,
// 曾经因为这个漏差点被误判成"窗口没有project字段";项目集合effect以它为权威源,别再漏。
type WindowListItem = { id: string; project: string; title: string; recipe_id: string; floor_count: number; updated_at: string; created_at: string };
type WindowDetail = {
  id: string; project: string; title: string; recipe_id: string;
  note: string; note_depth: number;
  state_board: Record<string, any>; vars: Record<string, any>;
  timeline_state: { segs: { text: string; upto: string }[]; cutoff: string | null; rev: number };
  created_at: string; updated_at: string;
};
type Recipe = {
  id: string; project: string; name: string; preset_id: string; weight: Weight;
  overrides: any; regex_ids: string[]; params: any; light_system: string;
  created_at: string; updated_at?: string;
};
type Preset = { id: string; name: string; block_count: number; queue_count: number; library_count: number; params: any; created_at: string };
type FloorReport = {
  blocks?: { identifier: string; name: string; tokensEst: number }[];
  loreHits?: string[];
  recalledChapters?: (string | number)[];
  // 全部候选(含落选的)+相关度分数。调及格线之前得先看得见真实分布,不然只能拍脑袋。
  // 类型故意写成 unknown:这两样是从 D1/流式响应读回来的裸 JSON,老楼层里什么形状都可能有,
  // 给它标一个漂亮的结构等于骗自己——真正的守卫在 FloorReportView 里逐项归一化。
  recallCandidates?: unknown;
  recallSettings?: unknown;
  recentChapters?: (string | number)[];
  layers?: Record<string, number>;
  standardSlots?: Record<string, number>;
  totalEst?: number;
  stateBoardStale?: boolean;
};
type FloorRole = 'user' | 'assistant';
type Floor = {
  key: string; // 本地渲染用(临时流式楼层用 'u'+ts/'a'+ts,落库后换成服务端真 id——同编辑部 dbId 家法)
  id?: string; // 服务端真身份;没有=还没落库(流式中/半途)
  role: FloorRole;
  content: string;
  thinking?: string | null; // desk_floors.thinking 列(真 extended-thinking,VPS渠道多半是空的)
  variantsCount: number;
  activeVariant: number;
  report: FloorReport;
  createdAt?: string;
  streaming?: boolean; // 当场流式中(还没收到 done/error)
};

// 项目 tab 来源:窗口列表的 project(权威源) ∪ 配方里出现过的非空 project(legacy兜底) ∪ 书架
// 统计的 by_project(书架先立了项目、桌上还没开过窗的也必须在这儿看得见)。三路都空才落
// DEFAULT_PROJECTS 占位——占位名不再无条件并入,免得空库首跑顶着两个假项目误导人。
const DEFAULT_PROJECTS = ['默认项目'];

// 装配引擎给模型的固定状态板协议键(chat/deskAssemble.ts STATEBOARD_INSTRUCTION 原文钉死这五项)。
// 板子是空的/模型还没写过状态板时,拿这五个当占位摆样子;板子里实际有什么键就照原样列,不因为
// 对不上这五个名字就砍掉(万一模型没完全照抄键名,好歹别把数据吞了)。
const STATE_BOARD_KEYS = ['在场角色', '衣装', '位置', '关系', '时间地点'];

// 状态板行/子行的 id 生成器——必须是模块级(不能挪进组件函数体里当 let):组件每次渲染都会
// 重新跑一遍函数体,放里面的话每次渲染计数器都归零,新旧行会撞出重复 id。全局递增+随机尾巴,
// 只求"同一次面板会话里不撞",不用扛持久化/跨会话唯一性——boardDraft 每次开面板都从服务端
// 数据重新 boardToRows() 建一份,这个 id 从不落库,纯粹是给 React key 和内部状态当稳定身份用
// (设计要求:改键名不许让那一行跳位,就是靠这个 id 而不是键名文本来认"这是哪一行")。
let boardRowIdSeq = 0;
function genBoardRowId(): string {
  boardRowIdSeq += 1;
  return `br${boardRowIdSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Sage 风格小料(照 page.tsx 同款数值抄一份——列表屏用这套;写作屏是编辑部同款 Tailwind 全屏聊天皮,两种视觉语言各管各的屏) ──
const cardStyle: React.CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--line-soft)', borderRadius: 22, boxShadow: '0 6px 18px var(--card-shadow)',
};
const glassCardStyle: React.CSSProperties = {
  background: 'var(--glass-bg)', border: '1.5px dashed var(--dash-line)', borderRadius: 22, boxShadow: '0 4px 16px var(--card-shadow)',
};
const pillStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, color: 'var(--ink2)',
  background: 'var(--card-bg)', border: '1px solid var(--line-soft)', padding: '7px 16px', borderRadius: 30,
  cursor: 'pointer', textDecoration: 'none', fontFamily: 'inherit',
};
const btnPrimaryStyle: React.CSSProperties = {
  fontSize: 13, color: 'var(--card-bg)', background: 'var(--accent)', border: 'none',
  padding: '9px 18px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit',
};
const inputStyle: React.CSSProperties = {
  fontSize: 13.5, color: 'var(--ink-body)', background: 'var(--card-bg)', border: '1px solid var(--line-soft)',
  borderRadius: 12, padding: '9px 14px', fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box',
};

function fmtWin(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return iso; }
}
// 同编辑部 fmtTime:当天只显时分,隔天起带日期
function fmtTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return time;
    const date = d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    return `${date} ${time}`;
  } catch { return ''; }
}
function grow(el: HTMLTextAreaElement | null, composing = false) {
  if (!el) return;
  // 楼层行内编辑:height='auto'→重设成scrollHeight这套自增高手法,每次都会强制一次同步reflow
  // ——测"内容变短了要不要收缩"这一步躲不掉(不先清掉height,scrollHeight在没溢出时就等于当前
  // 已设的高度,量不出内容真实缩了多少),但对着**聚焦中**的textarea反复来这一下,是iOS Safari上
  // caret位置错位的已知诱因:浏览器内部缓存的光标可视位置跟不上突然的布局变化,可视光标和实际
  // 命中区域就分家了(实测:光标显示在第5行,手指得往下按一截才够得到)。治法:reflow前后把
  // selectionStart/End和scrollTop原样点回去,显式回写选区能逼浏览器把caret重新按新布局画一遍,
  // 不留错位。
  //
  // ⚠️硬红线:中文输入法**正在组字**时绝不许碰 selection。input 事件在 composition 期间照样
  // 会触发,这时候写 selectionStart/End 会把候选词打断、或者让上屏位置错乱——中文输入场景下
  // 这个回归比原本要修的 caret 错位还严重。所以组字期间高度照常更新、只跳过选区回写(这仍然
  // 严格好于改之前那版:那版同样 reflow,而且一次按键跑两遍)。
  // 真凶另一半(调用方那一层):这个函数以前是从render期的inline callback ref里跑的,受控
  // textarea(value=editDraft)每敲一个字都re-render,ref回调因为是每次新建的函数对象被React
  // 判定成"变了"从而重新触发,于是一次按键实际跑两遍grow(ref一遍+onInput一遍)——那才是抖动
  // 的主因,已经挪到useLayoutEffect(仅在编辑框刚打开时跑一次)+onInput(打字时跑一次)分工,
  // 这里不用再兼容"render期反复调用"这种用法。
  // ⚠️彻底不再写 height:'auto'。
  // 早期版本只挡住了"最终高度不许变矮",可 height:'auto' 那一帧照写不误——而**那一帧本身**才是
  // 病根:内容一旦超过 240px 上限,'auto' 会让框子在一瞬间撑到完整内容高度(可能六七百px),
  // 下一句再压回 240。等于每敲一个键、每删一个字,页面都被撑开又收回一次。iOS 缓存的光标可视
  // 位置就是在这一撑一收之间跟丢的(实测:上面一行删字,光标画在下面一行)。
  //
  // 治法:根本不需要 'auto' 就能拿到"内容到底多高"——元素高度固定而内容溢出时,scrollHeight
  // 本来就等于内容完整高度。所以:
  //   ①装得下(scrollHeight <= clientHeight) → 一个字节都不写,零重排。删字走的正是这条路。
  //   ②装不下 → 直接把算出来的高度写上去,一次写完,没有中间态。
  // 顺带天然实现了"只长不缩":内容缩回框内就走①,框子留着不动——这正是上一版想要的效果,
  // 现在不用额外判断了。松开焦点/下次打开元素重建,自然重新量准。
  // clientHeight 与 scrollHeight 都不含边框,而 box-sizing:border-box 下 style.height 含边框,
  // 所以补一个 extra(=offsetHeight-clientHeight),否则每次都差两像素、内容永远差一点点装不下。
  if (el.scrollHeight <= el.clientHeight) return;
  const extra = el.offsetHeight - el.clientHeight;
  const next = Math.min(el.scrollHeight + extra, 240);
  const prev = parseFloat(el.style.height) || 0;
  if (next <= prev) return; // 已经到顶(或没变高)——同样不写,不制造无谓重排
  const focused = document.activeElement === el;
  const { selectionStart, selectionEnd } = el;
  el.style.height = next + 'px';
  if (focused && !composing) {
    el.selectionStart = selectionStart;
    el.selectionEnd = selectionEnd;
  }
}
function isComposingKey(e: React.KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || (e.nativeEvent as KeyboardEvent).keyCode === 229;
}
// @候选下拉探测正则(配合后端刚上线的"@点名"机制):后端对"@"之后取的是 Unicode 字母/数字/_/-
// 连续段当 token 去等值匹配卡名/keys,前端菜单必须用同一套字符集判断"光标是不是正落在一个
// @token 末尾",不然会出现"菜单弹出来了但后端根本不认这段""菜单没弹但后端其实认"这种错位。
const AT_TOKEN_RE = /@([\p{L}\p{N}_-]*)$/u;
function formatBoardValue(v: any): string {
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join('、') : '—';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

// 正文里内嵌的 <thinking>...</thinking>:部分预设自己在正文里吐 COT 块(不是走 API 级 extended
// thinking 那条独立通道),先用这把朴素正则挖出来折叠,不追求完美(嵌套/半截标签不管)——
// 后续补上正式的"下行正则管道"(deskRender.ts applyDownRegex,desk_regex direction='down'/'both'
// 那批)之后,这把朴素正则仍然留着当兜底:没导下行正则的预设、或下行正则压根没碰 <thinking> 标签
// 的场合,还是靠它给阅读体验找个台阶。渲染时对着"下行正则处理完之后的文本"再跑一遍这个函数
// (见写作屏 assistant 楼层块),两层不冲突——大多数情况下第二层无事可做。
//
// 流式场景的补丁(真实数据验证):部分预设的 <thinking> 标签常年贴在正文最开头(比如
// "<thinking>\n[语言检定]...[基调锚定]...\n</thinking>\n\n<content>..."),流式期间闭合标签
// 落地前,原来这把正则一个字都不认(没有完整 <thinking>…</thinking> 配对就不动 body)——那一小段
// COT 就会原样裸露在正文气泡里滚动,读起来像"思考渣"糊在屏幕上,闭合标签一到才"啪"地收进折叠区、
// 正文瞬间换脸,观感就是"卡了半天才冒出来"。streaming=true 时补一条兜底:body 里剩的如果是个还没
// 等到闭合标签的字面 <thinking> 开头,就先把这一截也折进思考区——真正闭合后自然被上面的完整匹配
// 接管,两条路径不冲突。只认这一种字面标签形状,其它协议标签(<meow_FM>/<branches>/<snow>/<ccd>
// 等)一律不碰,不在这个函数的管辖范围内。settled(非流式)时不走这条兜底——标签真写残了就老实展示
// 原文,别把内容锁死在折叠区里出不来。
// 这条兜底还修过一版:早期实现是 body.search(全篇搜索)命中就把"命中点之后的全部"搬进思考区
// ——正文正常写作/讲解里提到一句字面 "<thinking>"(比如小说文本引用、代码示例),后面所有真
// 正文都会被误吞,直到 settled 才整段跳回来,复现了同一种"卡到最后才冒出来"的手感。收窄成只认
// "响应开头"的未闭合 thinking(允许前导空白,但必须从位置0起),其它位置出现的字面 <thinking>
// 一律当普通正文,不兜底——真实用法本来就是"开头吐COT",这个收窄不影响本来要治的那个病,只是
// 不再殃及正文中段的无辜文字。
function splitInlineThinking(content: string, streaming?: boolean): { thinking: string; body: string } {
  const re = /<thinking>([\s\S]*?)<\/thinking>/gi;
  let thinking = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) thinking += (thinking ? '\n\n' : '') + m[1].trim();
  let body = content.replace(re, '');
  if (streaming) {
    const om = /^\s*<thinking>/i.exec(body);
    if (om) {
      thinking += (thinking ? '\n\n' : '') + body.slice(om[0].length).trim();
      body = '';
    }
  }
  return { thinking, body: body.trim() };
}

// 美化卡"内容指纹"用的廉价字符串哈希(djb2 变体,不追求抗碰撞,只用来给同一楼层同一位置的
// 卡片按*内容*而不是按*位置*分配身份——不引库,几行够用)。见下面 contentKey 的用途注释。
function cheapHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── 每窗独立缓存的 localStorage 「素颜/美化」偏好 ──
// 存的是"用户手动点过的覆盖值",键=楼层key、值=是否美化;没点过的楼层不进这个表,渲染时按
// matched-for-this-floor 现算默认值(工单原话"default 美化 when any down-rule matched")。
function beautifyStorageKey(windowId: string): string {
  return `oc_desk_beautify_${windowId}`;
}
function loadBeautifyOverrides(windowId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(beautifyStorageKey(windowId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch { /* 无localStorage环境/解析失败,当没存过 */ }
  return {};
}

// ── 剧本透视:紧凑等宽读出,给数据不给花哨排版 ──
function FloorReportView({ report }: { report: FloorReport | null | undefined }) {
  if (!report || Object.keys(report).length === 0) return null;
  const blocks = Array.isArray(report.blocks) ? report.blocks : [];
  const loreHits = Array.isArray(report.loreHits) ? report.loreHits : [];
  const recalled = Array.isArray(report.recalledChapters) ? report.recalledChapters : [];
  // report 是从 D1/流式响应读回来的裸 JSON,TS 类型管不住它的运行时形状——
  // 老楼层的报告里 score 可能是字符串、候选项可能是 null,裸 .toFixed 一调就把整棵渲染树打崩
  // (透视是浮层,崩了等于这一楼直接白屏)。渲染前逐项归一化:形状不对的丢掉,分数不是有限数就显示「—」。
  // ⚠️别用裸 Number():Number('')===0、Number(null)===0、Number(true)===1,全是"有限数",
  // 于是空分数会显示成 0.000、缺字段的设置会显示成 0——那比不显示更糟,因为它是**看起来正常的
  // 假数据**,你会拿它去调及格线。只认真数字,和"非空且真能解析成数"的字符串。
  const finiteNum = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const asObj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const candidates = (Array.isArray(report.recallCandidates) ? (report.recallCandidates as unknown[]) : [])
    .map(asObj)
    .filter((c): c is Record<string, unknown> => c !== null)
    .map((c) => ({
      chapterNo: typeof c.chapterNo === 'string' || typeof c.chapterNo === 'number' ? String(c.chapterNo) : '?',
      score: finiteNum(c.score),
      passed: c.passed === true,
      reason: typeof c.reason === 'string' ? c.reason : '',
    }));
  const rsObj = asObj(report.recallSettings);
  const rsTopK = rsObj ? finiteNum(rsObj.topK) : null;
  const rsMin = rsObj ? finiteNum(rsObj.minScore) : null;
  const rsMax = rsObj ? finiteNum(rsObj.maxChapters) : null;
  const recallSettings = rsTopK !== null && rsMin !== null && rsMax !== null
    ? { topK: rsTopK, minScore: rsMin, maxChapters: rsMax }
    : null;
  const recent = Array.isArray(report.recentChapters) ? report.recentChapters : [];
  const layers = report.layers && typeof report.layers === 'object' ? report.layers : {};
  const standardSlots = report.standardSlots && typeof report.standardSlots === 'object' ? report.standardSlots : {};
  const slotLabels: Record<string, string> = {
    worldInfoBefore: 'World Info (before)', charDescription: 'Char Description',
    charPersonality: 'Char Personality', scenario: 'Scenario', worldInfoAfter: 'World Info (after)',
    chatExamples: 'Chat Examples', chatHistory: 'Chat History', personaDescription: 'Persona',
  };
  return (
    <div className="mt-1.5 max-w-[85%] max-[760px]:max-w-[92%] border border-dashed border-dash-line rounded-xl bg-card/80 px-4 py-3 font-mono text-[11px] leading-relaxed text-ink-body break-all whitespace-pre-wrap">
      {report.stateBoardStale && <div style={{ color: '#c2693f', marginBottom: 6 }}>这楼的状态板没解析出来,沿用旧板</div>}
      {typeof report.totalEst === 'number' && <div className="serc" style={{ fontSize: 13, color: 'var(--ink-deep)', marginBottom: 6 }}>本次发送估算约 {report.totalEst} tokens</div>}
      <div>积木({blocks.length}): {blocks.length ? blocks.map((b) => `${b.name || b.identifier}(~${b.tokensEst})`).join(', ') : '—'}</div>
      <div style={{ marginTop: 4 }}>世界书命中: {loreHits.length ? loreHits.join('、') : '—'}</div>
      <div style={{ marginTop: 4 }}>召回老章: {recalled.length ? recalled.join('、') : '—'}</div>
      {candidates.length > 0 && (
        <div style={{ marginTop: 4 }}>
          候选相关度{recallSettings ? `(及格线 ${recallSettings.minScore} / 上限 ${recallSettings.maxChapters} 篇 / 候选池 ${recallSettings.topK})` : ''}:{' '}
          {candidates.map((c) => `${c.chapterNo} ${c.score === null ? '—' : c.score.toFixed(3)}${c.passed ? '✓' : `✗${c.reason}`}`).join(' / ')}
        </div>
      )}
      <div style={{ marginTop: 4 }}>近期章: {recent.length ? recent.join('、') : '—'}</div>
      <div style={{ marginTop: 4 }}>
        分层估算: {Object.keys(layers).length ? Object.entries(layers).map(([k, v]) => `${k}:${v}`).join(' / ') : '—'}
      </div>
      <div style={{ marginTop: 4 }}>标准槽: {Object.keys(standardSlots).length ? Object.entries(standardSlots).map(([k, v]) => `${slotLabels[k] || k}:~${v}`).join(' / ') : '—'}</div>
    </div>
  );
}

// ── 模型下拉:id 抄后端 MODEL_PROFILES 白名单(src/chat/models.ts),后端不认的名字会自己夹回默认,
// 这里只是省得每次都要记型号。选择存 localStorage 全桌通用,默认与后端 DESK_DEFAULT_MODEL 同款。──
const DESK_MODELS = [
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-5', label: 'Opus 5' },
];

// ── 每楼下方的动作条(编辑/复制/透视/楼层号/时间戳)。user 楼层和 assistant 楼层共用同一条,
// 靠 isAssistant 挑行为——挂在模块顶层而不是 write 屏渲染函数内部,免得每次 .map() 迭代都现造一个
// 新组件类型(那样 React 每帧都会当成全新元素卸载重挂,编辑框/焦点全丢),所有依赖都走 props 传入。
function FloorActionRow({
  f, isAssistant, sending, mutBusy, onEdit, onCopy, onToggleReport,
  floorNo, extra,
  isLast, onReroll, onResend,
}: {
  f: Floor; isAssistant?: boolean; sending: boolean; mutBusy: boolean;
  onEdit: (f: Floor) => void; onCopy: (text: string) => void; onToggleReport: (key: string) => void;
  floorNo: number;
  extra?: React.ReactNode; // 素颜/美化切换钮塞在这儿(只有 assistant 楼层的调用点会传)
  // 重roll挪进动作条:isLast/onReroll 只有最后一条 assistant 楼的调用点会传——
  // roll 语义只打最后一楼(后端如此),天然"assistant only"+"last only"。
  isLast?: boolean; onReroll?: (f: Floor) => void;
  // 任务5(孤儿user楼重发):onResend 只有"floors数组里的最后一楼、且这一楼是user角色"这一种
  // 情形的调用点会传(见写作屏 user 楼渲染那处),天然限定"user only"+"last only"——不需要
  // 在这里再判 role,调用方已经把条件收窄了。
  onResend?: (f: Floor) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-1.5 flex-wrap">
      {/* 动作条顺序统一:assistant楼新序=复制、编辑、素颜/美化、透视、重roll
          (复制/编辑排前两位;素颜/美化即extra,原来插在
          复制和编辑之间,现挪到编辑之后)。user楼没有复制/透视(isAssistant一律false),extra
          user调用点也没传——这次挪位对user楼视觉上是空操作,"编辑排在复制之后"这条原则对user楼
          天然满足(有什么排什么,user楼目前只有编辑)。重roll/楼层号/时间戳位置原样不动,
          只挪了这两块的先后顺序,handler(onCopy/onEdit本体)一字未改。 */}
      {isAssistant && f.content && (
        <button onClick={() => onCopy(f.content)} className="serc text-[11px] text-ink2 hover:text-accent">复制</button>
      )}
      {f.id && !sending && !mutBusy && f.content && (
        <button onClick={() => onEdit(f)} className="serc text-[11px] text-ink2 hover:text-accent">编辑</button>
      )}
      {extra}
      {isAssistant && f.id && Object.keys(f.report || {}).length > 0 && (
        <button onClick={() => onToggleReport(f.key)} className="serc text-[11px] text-ink2 hover:text-accent">透视</button>
      )}
      {/* 任务5:孤儿user楼(生成失败后落单、没有AI回复跟着)的补救出口——门禁照抄"编辑"按钮
          同款惯例(f.id && !sending && !mutBusy 才显示),真正的互斥闸在 resendOrphan 内部
          (照 send() 全套:sendingRef/editingFloorKey/mutRef/boardSavingRef/recipeSwitchingRef)。 */}
      {!isAssistant && f.id && !sending && !mutBusy && onResend && (
        <button onClick={() => onResend(f)} className="serc text-[11px] text-ink2 hover:text-accent">重发</button>
      )}
      {/* 重roll 挪进楼层动作条,排在偏后(破坏性较强)的位置——只有最后一条
          assistant 楼(isLast)才显示,非最后一楼不显示(roll 语义只打最后一楼,后端如此)。
          门禁一字不改:handler 仍是外层 reroll(f),这里的隐藏条件照抄"编辑"按钮同款惯例
          (f.id && !sending && !mutBusy 才渲染,流式中/编辑中直接不显示,不是显示成disabled灰态)
          ——sending 在 reroll 自身进行时也是 true(setSending(true) 同一把状态),天然盖住了
          "这楼正在流式重roll中"这个情形,不需要另外去读 f.streaming。 */}
      {isAssistant && isLast && f.id && !sending && !mutBusy && onReroll && (
        <button onClick={() => onReroll(f)} className="serc text-[11px] text-ink2 hover:text-accent">重roll</button>
      )}
      <span className="ser text-[11px] text-ink2">第{floorNo}楼</span>
      {f.createdAt && <span className="ser text-[11px] text-ink2">{fmtTime(f.createdAt)}</span>}
    </div>
  );
}

// 布局改为左廊常驻:左廊现在任何视图都在场,从打字桌切去别的门不再是"整页早退"
// 那种硬切,而是页面(page.tsx)把 view 状态一换、这个组件直接卸载——但写作屏在飞(配方切换中)时
// 卸载会把还没落库的 PUT 结果丢在半空,原来 backToList 按钮已经堵过这个洞(见下面 backToList 定义
// 处的注释),现在左廊点门也要走同一道闸。父组件(page.tsx)自己不知道 TypingDesk 内部是不是"安全
// 可以离开",所以这里用 forwardRef+useImperativeHandle 开一个小口子:requestLeave() 同步跑一遍跟
// backToList 一模一样的检查+清理,блокирует(拦下)就返回 false(顺带把横幅挂在 deskError 上,
// 组件这时还没被卸载,横幅出得来),放行就顺手把飞着的流掐掉+世界代数翻篇(genRef++)再返回 true。
export type TypingDeskHandle = { requestLeave: () => boolean };

const TypingDesk = forwardRef<TypingDeskHandle, { base: string; envOk: boolean; onBack: () => void }>(function TypingDesk({ base, envOk, onBack }, deskRef) {
  const [mode, setMode] = useState<'list' | 'write'>('list');
  const [projects, setProjects] = useState<string[]>(DEFAULT_PROJECTS);
  const [project, setProject] = useState<string>(DEFAULT_PROJECTS[0]);
  // 向导里手建的项目名登记簿——三路来源的异步拉取完成时必须并上它,不许把刚手建的项目
  // 从列表里踩掉、更不许把 setProject 重定向走(codex Day112 Medium)
  const manualProjectsRef = useRef<Set<string>>(new Set());
  const [isTouch, setIsTouch] = useState(false);
  // 🧰 抽屉全家(S5a旧裁定,已被任务3推翻大半):积木/配方·世界书·正则·核心记忆·导入,原来
  // 只在窗口列表屏开(见文件底部渲染)——写作屏一个字不碰这份状态,关掉抽屉等于它从没打开过
  // (铁律2:复杂度全收进抽屉)。这份 drawerOpen 状态仍然只管列表屏那颗🧰入口,行为不变。
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 写作屏抽屉:写作屏里也要能开抽屉调积木/正则/美化,不用退回
  // 列表屏。独立一份 open 状态(跟列表屏那份互不干扰,两边理论上不会同时挂载,但各自独立更安全),
  // 复用同一个 DeskDrawerHub 组件本体(本体不改逻辑,两段确认/丢弃式离开等守卫原样生效),project
  // 传 win.project(写作屏语境下抽屉该认的是"这扇窗归哪个项目",不是列表屏当前选中的 tab)。
  const [writeDrawerOpen, setWriteDrawerOpen] = useState(false);
  // 列表屏/写作屏两颗文具盒入口共用这一个 ref——同一时刻 mode 只可能是
  // 'list' 或 'write' 之一(下面渲染是两条互斥的 return 分支),对应地只有一个 <DeskDrawerHub>
  // 会被挂载,ref 天然跟着挂载中的那一个走,不会串。requestLeave()/backToList() 离开这扇桌子/
  // 这扇窗之前,都先问它一句"有没有没存的草稿",见下面两处调用。
  const drawerRef = useRef<DeskDrawerHandle | null>(null);
  // 顶栏「文」/「世」两颗钮进的是同一个抽屉,只是落在不同标签页(第一批过渡态:世界书
  // 独立浮窗是第二批的活)。「世」不是新开一扇门,是"开抽屉 + 请它切到世界书页"——切页走
  // drawerRef.requestTab(=抽屉里的 guardedSetTab),这样抽屉已经开着时点「世」照样吃那套
  // "有未存草稿先问一句"的两段确认,不会把她正在填的核心记忆草稿悄悄冲掉(顶栏 z-8 高过抽屉
  // 背板 z-7,这几颗钮在抽屉开着的时候是真能点到的,不是理论情况)。
  function openWriteDrawerAt(k: DeskDrawerTabKey) {
    setWriteDrawerOpen(true);
    drawerRef.current?.requestTab(k);
  }

  useEffect(() => {
    try { setIsTouch(window.matchMedia('(pointer: coarse)').matches); } catch {}
  }, []);

  // iOS 第三方键盘"收起"只藏键盘不 blur 时的滚动兜底(同编辑部,全组件生命周期挂着,无害)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onVvResize = () => {
      const keyboardGone = window.innerHeight - vv.height < 60;
      if (!keyboardGone) return;
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      if (window.scrollY > maxScroll) window.scrollTo(0, maxScroll);
    };
    vv.addEventListener('resize', onVvResize);
    return () => vv.removeEventListener('resize', onVvResize);
  }, []);

  // ── 项目集合:软性增强,拿不到也不影响主流程(见文件头注释) ──
  // 原先只从配方列表反推——配方通用化后新配方project='',
  // 不再贡献项目名;某项目名下"最后一份带project的旧配方"被删掉,这个项目就从下拉里消失,
  // 哪怕它底下还挂着窗口(=窗口失联,列表屏切不到那个tab了)。窗口的project没受这轮通用化
  // 影响,仍是"这扇窗归哪个项目"的真实维度,改成以窗口为权威来源:GET /api/oc/desk/windows
  // 不带project参数(deskWindowList原生支持,查证见交付报告),拉全量窗口的project去重;配方的
  // 非空project(老配方历史值)继续并入当legacy兜底——防哪个边角项目只被曾经建过的老配方
  // 提过一嘴、从没开过窗,不该在这次改动里凭空从下拉消失。两口请求各自独立try/catch,一个
  // 翻车不连累另一个,最终并集里至少还有 DEFAULT_PROJECTS 兜底。
  useEffect(() => {
    if (!envOk) return;
    (async () => {
      const set = new Set<string>();
      try {
        const winRes = await fetch(`${base}/api/oc/desk/windows`);
        if (winRes.ok) {
          const wd = await winRes.json().catch(() => null);
          if (wd && wd.success === true) {
            (Array.isArray(wd.windows) ? wd.windows : []).forEach((w: any) => { if (w && typeof w.project === 'string' && w.project.trim()) set.add(w.project.trim()); });
          }
        }
      } catch {}
      try {
        const recRes = await fetch(`${base}/api/oc/desk/recipes`);
        if (recRes.ok) {
          const rd = await recRes.json().catch(() => null);
          if (rd && rd.success === true) {
            (Array.isArray(rd.recipes) ? rd.recipes : []).forEach((r: any) => { if (r && typeof r.project === 'string' && r.project.trim()) set.add(r.project.trim()); });
          }
        }
      } catch {}
      try {
        const stRes = await fetch(`${base}/api/oc/stats`);
        if (stRes.ok) {
          const sd = await stRes.json().catch(() => null);
          if (sd && sd.success !== false && sd.by_project && typeof sd.by_project === 'object') {
            Object.keys(sd.by_project).forEach((p) => { if (typeof p === 'string' && p.trim()) set.add(p.trim()); });
          }
        }
      } catch {}
      manualProjectsRef.current.forEach((p) => set.add(p));
      const list = set.size ? Array.from(set) : [...DEFAULT_PROJECTS];
      setProjects(list);
      // 首跑默认选中的占位名若不在真实列表里,自动落到第一个真项目——别让"默认项目"这个假 tab 顶在门口;
      // 手建项目在登记簿里、必在 list 中,不会被这步重定向踩掉
      setProject((p) => (list.includes(p) ? p : list[0]));
    })();
  }, [base, envOk]);

  // ══════════════════════════ 窗口列表屏 ══════════════════════════
  const [windows, setWindows] = useState<WindowListItem[]>([]);
  const [winListLoading, setWinListLoading] = useState(true);
  const [winListError, setWinListError] = useState('');
  const [winNonce, setWinNonce] = useState(0);
  const winListSeqRef = useRef(0);

  useEffect(() => {
    if (mode !== 'list') return;
    if (!envOk) { setWinListError('环境变量没配好'); setWinListLoading(false); return; }
    setWinListLoading(true); setWinListError('');
    const tok = ++winListSeqRef.current;
    (async () => {
      try {
        const qs = new URLSearchParams({ project });
        const res = await fetch(`${base}/api/oc/desk/windows?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json().catch(() => null);
        if (!d || d.success !== true) throw new Error(d?.error || '后端报错');
        if (tok !== winListSeqRef.current) return;
        setWindows(Array.isArray(d.windows) ? d.windows : []);
      } catch (e: any) {
        if (tok !== winListSeqRef.current) return;
        setWinListError(e.message || '这一屋窗户翻不开'); setWindows([]);
      } finally {
        if (tok === winListSeqRef.current) setWinListLoading(false);
      }
    })();
  }, [mode, project, winNonce, base, envOk]);

  // 窗口卡片删除:双确认(家法照 page.tsx onDeleteClick,按 id 各开一份计时器)
  const [winDelStage, setWinDelStage] = useState<Record<string, 0 | 1>>({});
  const winDelTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [winDelError, setWinDelError] = useState('');
  function onWinDeleteClick(id: string) {
    const stage = winDelStage[id] || 0;
    if (stage === 0) {
      setWinDelStage((s) => ({ ...s, [id]: 1 }));
      if (winDelTimers.current[id]) clearTimeout(winDelTimers.current[id]);
      winDelTimers.current[id] = setTimeout(() => setWinDelStage((s) => ({ ...s, [id]: 0 })), 3000);
      return;
    }
    if (winDelTimers.current[id]) clearTimeout(winDelTimers.current[id]);
    deleteWindow(id);
  }
  async function deleteWindow(id: string) {
    setWinDelStage((s) => ({ ...s, [id]: 0 }));
    setWinDelError('');
    try {
      const res = await fetch(`${base}/api/oc/desk/windows/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '删除失败(服务端没确认成功)');
      setWinNonce((n) => n + 1);
    } catch (e: any) { setWinDelError(e.message || '删除失败'); }
  }

  // ── 开新窗向导:①项目(下拉可切,可就地起新名)→②配方(下拉;没有就地建)→③标题(可选)→开窗,三步 ──
  const [wizardOpen, setWizardOpen] = useState(false);
  // ①项目改可切换:tab 里没有的项目在向导里必须有路可走;配方已全桌通用,切项目不需要重拉配方
  const [wizProjManual, setWizProjManual] = useState(false);
  const [wizProjName, setWizProjName] = useState('');
  const [wizRecipes, setWizRecipes] = useState<Recipe[]>([]);
  const [wizRecipesLoading, setWizRecipesLoading] = useState(false);
  const [wizRecipesError, setWizRecipesError] = useState('');
  const [wizRecipeId, setWizRecipeId] = useState('');
  const [wizTitle, setWizTitle] = useState('');
  const [wizCreating, setWizCreating] = useState(false);
  const [wizError, setWizError] = useState('');
  // 就地建配方(没有配方时自动弹出;也留个"另建一个"手动入口)
  const [wizMiniOpen, setWizMiniOpen] = useState(false);
  const [wizMiniName, setWizMiniName] = useState('');
  const [wizMiniPresetId, setWizMiniPresetId] = useState('');
  const [wizMiniWeight, setWizMiniWeight] = useState<Weight>('heavy');
  const [wizPresets, setWizPresets] = useState<Preset[]>([]);
  const [wizPresetsLoading, setWizPresetsLoading] = useState(false);
  const [wizPresetsError, setWizPresetsError] = useState('');
  const [wizMiniCreating, setWizMiniCreating] = useState(false);
  const [wizMiniError, setWizMiniError] = useState('');

  async function loadWizRecipes() {
    setWizRecipesLoading(true); setWizRecipesError('');
    try {
      if (!envOk) throw new Error('环境变量没配好');
      // 配方从project维度升为全桌通用后——开窗向导②配方这步不再按project过滤,
      // 拉全量:任何项目的窗口都能选任何配方,不再受"这份配方是不是当前项目建的"限制。
      const res = await fetch(`${base}/api/oc/desk/recipes`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '后端报错');
      const list: Recipe[] = Array.isArray(d.recipes) ? d.recipes : [];
      setWizRecipes(list);
      if (list.length) setWizRecipeId(list[0].id);
      else openMiniCreate();
    } catch (e: any) { setWizRecipesError(e.message || '配方翻不出来'); }
    finally { setWizRecipesLoading(false); }
  }
  function openWizard() {
    setWizardOpen(true);
    setWizError(''); setWizTitle(''); setWizRecipeId(''); setWizRecipes([]);
    setWizMiniOpen(false);
    setWizProjManual(false); setWizProjName('');
    loadWizRecipes();
  }
  async function openMiniCreate() {
    setWizMiniOpen(true);
    setWizMiniName(''); setWizMiniWeight('heavy'); setWizMiniError('');
    setWizPresetsLoading(true); setWizPresetsError('');
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/desk/presets`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '后端报错');
      const list: Preset[] = Array.isArray(d.presets) ? d.presets : [];
      setWizPresets(list);
      if (list.length) setWizMiniPresetId(list[0].id);
    } catch (e: any) { setWizPresetsError(e.message || '预设包翻不出来'); }
    finally { setWizPresetsLoading(false); }
  }
  async function createMiniRecipe() {
    const name = wizMiniName.trim();
    if (!name || !wizMiniPresetId || wizMiniCreating) return;
    setWizMiniCreating(true); setWizMiniError('');
    try {
      if (!envOk) throw new Error('环境变量没配好');
      // 配方全桌通用后就地建配方不再带project——跟BlocksTab
      // createRecipe口径对齐,不传就落''(后端project已改可选),别带着当前tab的project继续产
      // "看着通用其实还是钉着project"的旧式配方。回显对象的project改用服务端返回值(d.project
      // ?? ''),不用本地project变量伪造——服务端才是权威,前端不该替它决定这个字段存了什么。
      const body = { name, preset_id: wizMiniPresetId, weight: wizMiniWeight };
      const res = await fetch(`${base}/api/oc/desk/recipes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '配方没建成(服务端没确认成功)');
      const nr: Recipe = { id: d.id, project: d.project ?? '', name, preset_id: wizMiniPresetId, weight: wizMiniWeight, overrides: {}, regex_ids: [], params: {}, light_system: '', created_at: d.created_at };
      setWizRecipes((rs) => [nr, ...rs]);
      setWizRecipeId(nr.id);
      setWizMiniOpen(false);
    } catch (e: any) { setWizMiniError(e.message || '配方没建成'); }
    finally { setWizMiniCreating(false); }
  }
  async function createWindow() {
    if (!wizRecipeId || wizCreating) return;
    setWizCreating(true); setWizError('');
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const body: any = { project, recipe_id: wizRecipeId };
      const title = wizTitle.trim();
      if (title) body.title = title;
      const res = await fetch(`${base}/api/oc/desk/windows`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '开窗失败(服务端没确认成功)');
      setWizardOpen(false);
      setWinNonce((n) => n + 1);
      enterWindow(d.id);
    } catch (e: any) { setWizError(e.message || '开窗失败'); }
    finally { setWizCreating(false); }
  }

  // ══════════════════════════ 写作屏 ══════════════════════════
  const [curWindowId, setCurWindowId] = useState<string | null>(null);
  // curWindowId是state,async函数里"await之后再读它"读到的是发起那一刻
  // 的闭包快照,不是切窗后的live值(跟state本身滞后不滞后无关,是JS闭包语义本身)——要在fetch
  // 落地时判断"世界是不是还是发起时那个窗",得有一个每次切窗都同步写入的ref当活的对照组。
  // 直接照 genRef 的老家法:在 setCurWindowId 的两处调用点(enterWindow/backToList)同步落一份,
  // 不借 useEffect(effect要等下一轮commit,时序上不如直接赋值稳)。
  const curWindowIdRef = useRef<string | null>(null);
  const [win, setWin] = useState<WindowDetail | null>(null);
  const [floors, rawSetFloors] = useState<Floor[]>([]);
  // 楼层的活值镜像:给"异步响应落地时要看此刻楼层是什么样"的地方用(目前只有 refreshBoard 的
  // 楼层对账)——闭包里的 floors 是发起那一刻的旧快照,跟几秒后的响应赛跑必然读到过期值。
  // 同 inputRef/curWindowIdRef 那套家法。
  const floorsRef = useRef<Floor[]>([]);
  useEffect(() => { floorsRef.current = floors; }, [floors]);
  // ⚠️包一层 setFloors:**同步**作废在飞的状态板刷新。
  // 原来这个拨号写在 useEffect([floors]) 里,要等 render/commit 之后才跑——同一轮事件循环里
  // 先 setFloors、紧接着刷新的 Promise 落地,那时 effect 还没执行,令牌和 floorsRef 都还是旧值,
  // 三道闸会一起放行,一份照旧正文算出来的板就写进了她的草稿。拨号必须跟状态更新同一拍。
  // 挂在 setter 上而不是挨个改 12 个调用点:漏一个就是一条暗缝,而"楼层动了=刷新基准没了"
  // 这条判据对每一个调用点都成立(流式逐块更新也算——那时她本来就该重按)。
  // setFloors 没有出现在任何依赖数组里(查过),所以每次渲染换个函数身份不会引起额外重渲。
  const setFloors: typeof rawSetFloors = (updater) => {
    boardRefreshSeqRef.current++;
    rawSetFloors(updater);
  };
  const [winLoadLoading, setWinLoadLoading] = useState(false);
  const [winLoadError, setWinLoadError] = useState('');

  // ── 下行(美化)正则管道 ── 规则表 fetch 一次/窗口(downRulesFetchedForRef 挡重复请求,
  // 挡的是"同一扇窗内 win 对象因为 gentle reload 换了引用但 id 没变"这种情况——每楼重roll/编辑
  // 后台都会 loadWindow(gentle) 一次,不该跟着重新拉正则表)。失败降级为空规则表(=纯无操作),
  // 绝不拦住楼层渲染(工单点2"失败降级为无操作...never block reading floors")。
  const [downRules, setDownRules] = useState<DeskRegexRule[]>([]);
  const [downRulesNotice, setDownRulesNotice] = useState('');
  const downRulesFetchedForRef = useRef<string | null>(null);
  // 下行变换结果缓存——键=楼层id,值带content引用+规则版本号,
  // 任一变了才重算;换窗清空,超200条整体清防涨。规则版本号在setDownRules处递增。
  const downRulesVerRef = useRef(0);
  const downCacheRef = useRef(new Map<string, { content: string; ver: number; out: string }>());
  const [downRulesReloadNonce, setDownRulesReloadNonce] = useState(0);
  // 任务1(老楼层剥壳):入参改吃"剥完 <content> 壳之后"的文本,不再直接读 f.content——
  // unwrapContentTagClient 跑在 applyDownRegex 之前(工单点1"之前或之后皆可",这里选之前:
  // 老壳先剥干净,下行正则不用面对多余的首尾标签行)。缓存键(content 字段)跟着改存实际喂给
  // applyDownRegex 的入参(即已剥壳文本),不再是原始 f.content——覆盖到这一步新增的预处理,
  // 剥壳结果变了(比如楼层被编辑改动)缓存天然判旧,不会拿着剥壳前的旧壳粘出过期结果。
  function downTransform(f: Floor, unwrappedContent: string): string {
    if (!f.id) return unwrappedContent;
    const hit = downCacheRef.current.get(f.id);
    if (hit && hit.content === unwrappedContent && hit.ver === downRulesVerRef.current) return hit.out;
    const out = applyDownRegex(unwrappedContent, downRules);
    if (downCacheRef.current.size > 200) downCacheRef.current.clear();
    downCacheRef.current.set(f.id, { content: unwrappedContent, ver: downRulesVerRef.current, out });
    return out;
  }
  // 协议渣兜底折叠结果缓存——镜像 downCacheRef 同款纪律:纯函数不许每帧重跑。
  // foldProtocolBlocks 本身没有外部可变规则表(不像 applyDownRegex 挂着 downRules),键只用
  // "楼层id+输入文本"就够判重,不需要额外的版本号。跑在 applyDownRegex 之后(工单点3钉死的
  // 接线顺序:自定义正则先吃,吃剩的才轮到这层兜底)。
  const foldCacheRef = useRef(new Map<string, { input: string; out: FoldPart[] }>());
  function foldTransform(f: Floor, bodyText: string) {
    if (!f.id) return foldProtocolBlocks(bodyText);
    const hit = foldCacheRef.current.get(f.id);
    if (hit && hit.input === bodyText) return hit.out;
    const out = foldProtocolBlocks(bodyText);
    if (foldCacheRef.current.size > 200) foldCacheRef.current.clear();
    foldCacheRef.current.set(f.id, { input: bodyText, out });
    return out;
  }
  // 美化卡 sandbox 升级到 allow-scripts 后(取舍见 deskRender.ts buildCardSrcDoc 头注释),
  // 卡片自己用 ResizeObserver 量高度、postMessage 上报——父页这层只信"认识的卡片 iframe"发来的信:
  // opaque origin 发不出真实 e.origin,退而求其次校验 e.source 是否严格等于本页某张卡当前的
  // contentWindow(逐张对号,不是信 postMessage 的 type 字段就收),防的是别的 iframe/浏览器扩展/
  // 未来某个新窗口混进同一个 message 事件流。收到消息前继续吃 DESK_CARD_MAX_HEIGHT 旧默认值兜底,
  // 收到后钳位到 [80,800]——防脚本(不管是恶意还是单纯算错)把卡片撑爆页面或缩没到看不见。
  //
  // 身份键改用 contentKey = `${f.key}-seg-${i}#${cheapHash(seg.code)}`(必现误杀修复)——
  // 单用 cardKey(位置)当身份会踩坑:切素颜/美化、编辑楼层、抽屉改正则重算,都会让"同一位置"换成
  // "不同内容"却复用同一个 cardKey,若这时 iframe 元素被 React 原地更新 srcDoc(而不是整个卸载
  // 重挂),下面导航击杀器的 load 计数会在旧 Map 条目上继续累加,两下点击就被误判成"脚本导航"。
  // 内容指纹进了 React key 之后,任何合法内容变化=新 contentKey=新元素、旧元素卸载,计数天然清零;
  // 真·同一份文档发生的脚本自导航不会改变 seg.code,contentKey 不变,第二次 load 照旧命中击杀——
  // 两种情况用同一套机制天然区分开,不需要额外的"是不是用户操作"判断。
  //
  // ref 是渲染期间新建的内联函数,父组件任何一次
  // 重渲染(哪怕跟这张卡毫不相干——发消息/开抽屉/卡片自己 postMessage 报高度触发的 setCardHeights
  // 都算)React 都会照样拿同一个 DOM 节点重新调一次 ref 回调。如果 ref 回调里"看到调用就清零计数",
  // 会把这种"节点没变、只是又被喂了一次"的 churn 当成真挂载,把击杀器的记忆连本带利洗掉——第一次
  // load 计到1,高度上报引发父组件重渲染,计数被腰斩回0,自导航的第二次 load 又只计到1,永远到不了
  // 2,击杀器形同虚设。改用 cardNodesRef 记"这个 contentKey 上次挂的是哪个 DOM 节点",只有节点真的
  // 换了(!==)才算真挂载、才清零计数;同一节点被重复调用的 churn 什么都不做。
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const cardWindowsRef = useRef<Map<string, Window>>(new Map());
  const cardNodesRef = useRef<Map<string, HTMLIFrameElement>>(new Map());
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!e.data || e.data.type !== 'desk-card-height') return;
      let matchedKey: string | null = null;
      for (const [key, win] of cardWindowsRef.current) {
        if (win === e.source) { matchedKey = key; break; }
      }
      if (!matchedKey) return; // 验 source 未过——不是本页哪张已知卡片发的,一律不认
      const h = Number(e.data.h);
      if (!Number.isFinite(h)) return;
      const clamped = Math.max(80, Math.min(800, Math.round(h)));
      const k = matchedKey;
      setCardHeights((prev) => (prev[k] === clamped ? prev : { ...prev, [k]: clamped }));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  // 导航击杀器:CSP 焊死了 fetch/XHR/WebSocket/远程图这些常规网络
  // 出口,但焊不住"脚本给 iframe 自己导航"这条缝(location.href 跳转本身就是一次带数据的请求,
  // 平台层无法根治,取舍详见 deskRender.ts buildCardSrcDoc 头注释"残余风险"段)。srcdoc iframe
  // 正常只该触发一次 load(装载 srcdoc 本体那次)——第二次 load 事件说明文档被换了,即发生了导航,
  // 立刻把这张卡标记"已击杀",本次会话内不再重挂 iframe。击杀态按 contentKey 记账,只随内容变化
  // 自然解除(新内容=新 contentKey=没被记过=新机会,合理语义)——不因为素颜/美化来回切、楼层重渲染
  // 这类"内容没变、只是暂时不挂 iframe"的场景被误清。⚠️局限如实写:导航发起的第一个请求在 load
  // 事件触发前就已经发出去了,这道闸拦的是"发现即掐断、不许继续外带+不许把导航后的响应渲染出来",
  // 不是"防住第一下"。
  const cardLoadCountRef = useRef<Map<string, number>>(new Map());
  const [killedCards, setKilledCards] = useState<Record<string, true>>({});
  function onCardIframeLoad(contentKey: string) {
    const n = (cardLoadCountRef.current.get(contentKey) || 0) + 1;
    cardLoadCountRef.current.set(contentKey, n);
    if (n >= 2) {
      cardWindowsRef.current.delete(contentKey); // 卡都要拆了,不再是"认识的卡片"
      setKilledCards((prev) => (prev[contentKey] ? prev : { ...prev, [contentKey]: true }));
    }
  }
  // 每楼「素颜/美化」的用户手动覆盖值(未覆盖的楼层按 matched-for-this-floor 现算默认值)
  const [beautifyOverrides, setBeautifyOverrides] = useState<Record<string, boolean>>({});
  function toggleBeautify(floorKey: string, defaultVal: boolean) {
    if (!curWindowId) return;
    const windowId = curWindowId;
    setBeautifyOverrides((prev) => {
      const cur = floorKey in prev ? prev[floorKey] : defaultVal;
      const next = { ...prev, [floorKey]: !cur };
      try { localStorage.setItem(beautifyStorageKey(windowId), JSON.stringify(next)); } catch {}
      return next;
    });
  }

  // 世界代数(照编辑部家法,desk 这边多一层用途:切窗口/退回列表也算翻篇,防旧窗口的流式回调/
  // 对账落到新窗口头上——每次开始一轮 send/reroll 前拍一份 myGen 快照,闭包里全程认它)
  const genRef = useRef(0);
  const sendingRef = useRef(false); // 两种轮次(发送/重roll)共用一把互斥锁,同一时刻只许一轮在飞——续写已砍(前端不可达,后端分支留另一单)
  // 反向互斥:改楼类请求(编辑/剪楼/切变体)在飞时也不许起新生成——不然生成抓的是旧历史,
  // 改楼落地后画面和正史就岔开了。ref给逻辑闸,state给按钮禁用。
  const mutRef = useRef(0);
  const [mutCount, setMutCount] = useState(0);
  function beginMut() { mutRef.current += 1; setMutCount((c) => c + 1); }
  function endMut() { mutRef.current = Math.max(0, mutRef.current - 1); setMutCount((c) => Math.max(0, c - 1)); }
  const [turnKind, setTurnKind] = useState<null | 'send' | 'reroll'>(null); // 'continue' 已砍(续写按钮/函数整个移除)
  // 模型选择:初始定死默认值防hydration闪变,挂载后再读localStorage
  const [model, setModel] = useState('claude-sonnet-4-5');
  useEffect(() => { try { const m = localStorage.getItem('oc_desk_model'); if (m && DESK_MODELS.some((x) => x.id === m)) setModel(m); } catch { /* 无localStorage环境无所谓 */ } }, []);
  function pickModel(id: string) { setModel(id); try { localStorage.setItem('oc_desk_model', id); } catch { /* 同上 */ } }
  // 窗口换配方(实测撞出的洞:删配方没查窗口引用,窗口还钉着旧recipe_id,重roll直接500
  // "配方不存在"——原来只能手动接回新配方救急,这里补正经的UI出口)。选实现简单的:头栏一个原生
  // <select>(照模型选择器同款视觉家法),不做弹出菜单那套(点击态/外部点击关闭都要自己管,
  // 原生select浏览器免费给)。全量拉配方(GET不分project,同R3工单"配方全桌通用"那次拍板),
  // 每次进写作屏/切窗口都刷新一次列表(不额外加"只拉一次"的缓存判重——这个列表小,万一
  // 刚建了新配方就想立刻切过去,过期缓存比多拉一次请求更糟)。
  const [recipeOptions, setRecipeOptions] = useState<Recipe[]>([]);
  const [recipeSwitching, setRecipeSwitching] = useState(false);
  const [recipeSwitchNotice, setRecipeSwitchNotice] = useState('');
  const recipeSwitchNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 互斥只有单向:recipeSwitching是state,send/reroll/continue读不到"同一tick已经
  // 占了锁"这件事(setState不同步落到当前闭包,同族老毛病)——照 boardSavingRef 家法补一把同步
  // 锁,查锁+占锁必须在switchRecipe的任何await之前完成;state只管UI显示,互斥判断只认这个ref。
  const recipeSwitchingRef = useRef(false);
  // 防重入/乱序:上面的同步锁本身已经挡掉"同tick连续切两次"(第二次调用一进门就
  // 被recipeSwitchingRef拦住),这里再补一道切换序号防御——万一将来锁被绕开(比如换了实现),
  // 乱序到达的旧响应也不会覆盖新响应已经落地的结果。tok在发起时自增,回写前连世界闸一起验。
  const switchSeqRef = useRef(0);
  useEffect(() => {
    if (mode !== 'write' || !curWindowId) return;
    let cancelled = false;
    (async () => {
      try {
        if (!envOk) return;
        const res = await fetch(`${base}/api/oc/desk/recipes`);
        if (!res.ok) return; // 下拉拿不到就先空着,不拦写作屏其它功能(降级为"看不出别的配方,但当前这个不受影响")
        const d = await res.json().catch(() => null);
        if (!cancelled && d && d.success === true) setRecipeOptions(Array.isArray(d.recipes) ? d.recipes : []);
      } catch { /* 同上,静默降级 */ }
    })();
    return () => { cancelled = true; };
  }, [mode, curWindowId, base, envOk]);
  async function switchRecipe(newRecipeId: string) {
    if (!curWindowId || !win || !newRecipeId || newRecipeId === win.recipe_id) return;
    // 生成在飞不许切配方(工单点名):assembleDesk 装配这一楼时读的是窗口此刻的recipe_id,
    // 这楼生成中途换掉会导致这楼用旧配方拼、下一楼却对着新配方——读ref不读state,理由同
    // saveBoard/send那族互斥闸(state不同步落到当前闭包)。
    if (sendingRef.current) { setDeskError('生成中,不能换配方'); return; }
    // 查锁+占锁必须在这里(任何await之前)同步完成——JS单线程,这几行之间没有
    // yield点,不会被另一次调用(不管是再点一次下拉,还是同tick触发的send/reroll/continue)
    // 插队。state(setRecipeSwitching)只管UI显示,不参与互斥判断。
    if (recipeSwitchingRef.current) { setDeskError('配方切换中,请稍候'); return; }
    recipeSwitchingRef.current = true;
    const savedWindowId = curWindowId;
    const myGen = genRef.current;
    const tok = ++switchSeqRef.current; // 序号在占锁之后、await之前发,天然递增不会撞号
    setRecipeSwitching(true); setRecipeSwitchNotice('');
    try {
      const res = await fetch(`${base}/api/oc/desk/windows/${savedWindowId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipe_id: newRecipeId }) });
      // 错误管道先读body(工单点名+顺手排查那条"装配报错前端表现"揪出的同族坑,见 streamChat
      // 那边的大段注释):不管res.ok与否都先读一次JSON,让后端具体错误文案(比如"preset_id不
      // 存在"这类)有机会透到deskError横幅上,读不出JSON才退回HTTP状态码文案。
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || `HTTP ${res.status}`);
      // 世界代数双证(同 saveBoard 那道跨窗回写闸,理由见 curWindowIdRef 声明处注释):PUT打的是
      // savedWindowId,落库没问题;回写前端画面前确认还在这扇窗、没有切走。再加一道序号
      // 校验——F1的同步锁已经让同一时刻只可能有一次switchRecipe在飞,正常情况下tok必然是最新
      // 的,这道校验是防御性的(万一以后锁的实现被绕开),不是当前时序下真会触发的分支。
      if (curWindowIdRef.current === savedWindowId && genRef.current === myGen && tok === switchSeqRef.current) {
        setWin((w) => (w ? { ...w, recipe_id: newRecipeId } : w));
        setRecipeSwitchNotice('配方已换');
        if (recipeSwitchNoticeTimer.current) clearTimeout(recipeSwitchNoticeTimer.current);
        recipeSwitchNoticeTimer.current = setTimeout(() => setRecipeSwitchNotice(''), 2500);
      }
    } catch (e: any) {
      // 失败横幅同样过世界闸:切换在飞时若真发生了跨窗
      // (backToList已被下面的守卫拦住,这里是防御性),旧窗的失败不该在新窗脸上冒错误。
      if (curWindowIdRef.current === savedWindowId && genRef.current === myGen) {
        setDeskError(e.message || '换配方失败');
      }
    }
    finally { recipeSwitchingRef.current = false; setRecipeSwitching(false); } // 持锁方释放:ref先解,state再同步(UI跟着解锁)
  }
  const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resyncSeqRef = useRef(0);
  // loadWindow(gentle) 对账原来只认 genRef——同一扇窗内"旧一轮 done 后的对账GET
  // 慢到 + 新一轮已经起跑"这种时序,genRef 没翻篇(还是同一扇窗),旧GET照样把新一轮的流式占位楼/
  // 已收增量整包覆盖,画面脱节。补一把独立的加载序号闸:loadWindow 每次调用入口自增一个token当自己
  // 的"这一趟"身份证,提交前比对token是否还是当前最新——send/reroll 两个起跑口在通过全部互斥门禁、
  // 真正开始这一轮前主动把它再自增一次,把上一轮所有在飞的loadWindow提交预先作废(不用等它自己的
  // 下一次loadWindow调用去顶,免得旧GET在那之前的窗口期内抢先落地)。genRef管"世界翻篇"(切窗/返回
  // 列表),loadSeqRef管"同一扇窗内的轮次先后"——两闸并联,谁的场子谁看门。
  const loadSeqRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 当场这一轮(send/reroll/continue)的收尾 promise——切窗/返回列表前必须先等它落地,
  // 免得旧世界的收尾逻辑(sendingRef 复位/floors 增量)追上新世界头上
  const pendingRef = useRef<Promise<void> | null>(null);
  // 持久错误横幅:跟 floors 数组分开放,canonical reload 会整包替换 floors,横幅要扛得住那一下(FIX1)
  const [deskError, setDeskError] = useState('');
  // 重roll"客厅手感"改造:进流式态前把目标楼原样(content+thinking)捏一份快照,失败/中断时
  // 靠它把楼复原,不许停在"被清空"的半吊子画面。同一时刻只许一轮在飞(sendingRef 保证),
  // 单变量够用,不用按 key 建表。恢复动作走 patchFloor(带 myGen 比对),世代闸自然罩得住。
  const floorSnapshotRef = useRef<{ key: string; content: string; thinking: string | null } | null>(null);
  // 离窗协议注册在状态板 state 之前，不能读首帧闭包；三把 ref 给返回/侧栏/回家入口提供活状态。
  const boardDirtyRef = useRef(false);
  const timelineDirtyRef = useRef(false);
  // 两段确认的"已问过一次"标记。原来是 0|1 的哑标记,谁点都能消费同一次确认:
  // 脏着的时候点「← 返回」亮起确认、人不走了回去接着编,3.5s 内点「时光带」就被当成"她确认过了"
  // 直接丢稿。现在存的是**具体哪个动作**在等第二下(null=没在等),换个动作要重新问一次。
  const boardArmRef = useRef<string | null>(null);

  // ── 小纸条/状态板面板改浮窗:原来两块面板内联渲在对话区顶部,聊天拉到下面点开看不见,得手动
  // 滚回最上面。改成 position:fixed 盖在对话内容之上、不随滚动走,视觉位置仍卡在"头栏下方"那个
  // 原位——头栏/底栏都是响应式高度(断点/字号会变),不能硬编码 px,量出它们的实际渲染高度,
  // 面板 top 顶着头栏底边、maxHeight 扣掉头栏+底栏各自高度,面板自己 overflow-y-auto 内部滚动,
  // 结构上就不可能伸到头栏/底栏的屏幕区域。z 层级仍用原来核定的 z-[1](跟 <main> 一个值,
  // 不新起够到头栏 z-10/底栏 z-[2] 的层级——已经因为够太高被拦过一次),同层级下 fixed 元素
  // 谁在 DOM 里靠后谁盖住谁,两块面板的 JSX 挪到 <main> 之后渲染,天然赢过滚动中的对话内容。
  //
  // 浮窗顶上的面板标题被头栏遮住——真凶:ResizeObserver 默认量的是
  // content-box(entry.contentRect 天生就是这个,跟 observe() 有没有传 box 选项无关),header/
  // footer 却都吃了 padding(px-6 py-3 一类)+ border(border-b 1px)——headerH/footerH 因此永远
  // 比头栏/底栏*真正*的渲染高度矮了"padding+border"这一截。浮窗 top:headerH 顶的是这个偏矮的
  // 数字,于是浮窗的最上面一小截(它自己的标题区)其实叠进了头栏底部那圈 padding/border 的屏幕
  // 区域——头栏 z-10 比浮窗 z-[1] 高,画面上就是头栏"盖住"了浮窗标题。改法:显式管 border-box
  // (entry.borderBoxSize,含 padding+border,才是头栏底边在屏幕上的真实位置),没有这个字段的
  // 极端环境(旧引擎/测试环境 polyfill 缺失)兜底退回 getBoundingClientRect().height——两条路径
  // 量出来的都是"这块元素在屏幕上到底占多高",top:headerH 才会精确顶在头栏视觉下边缘,不多不少。
  const headerRef = useRef<HTMLElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const [headerH, setHeaderH] = useState(64);
  const [footerH, setFooterH] = useState(88);
  useEffect(() => {
    if (mode !== 'write') return;
    const headerEl = headerRef.current;
    const footerEl = footerRef.current;
    if (!headerEl || !footerEl) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const bbs = entry.borderBoxSize;
        const box = bbs ? (Array.isArray(bbs) ? bbs[0] : bbs) : null; // 规范是数组,老实现/polyfill 可能给单个对象
        const h = box ? Math.round(box.blockSize) : Math.round(target.getBoundingClientRect().height);
        if (target === headerEl) setHeaderH(h);
        else if (target === footerEl) setFooterH(h);
      }
    });
    ro.observe(headerEl, { box: 'border-box' });
    ro.observe(footerEl, { box: 'border-box' });
    return () => ro.disconnect();
  }, [mode]);

  const loadWindow = useCallback(async (id: string, gentle = false, expectGen?: number): Promise<void> => {
    if (expectGen !== undefined && expectGen !== genRef.current) return; // 调用前置检查:发起前世界已经翻篇,不用打这一枪
    const gen = genRef.current;
    // 加载序号闸:这一趟loadWindow的身份证——入口自增,提交前比对是否还是
    // 当前最新。send/reroll起跑时会抢先自增这个计数器,把上一轮还在飞的旧GET预先作废,详见声明处
    // 头注释。跟下面的gen(世界翻篇闸)并联,两把尺子任一对不上就整体放弃提交(gentle静默同款家法)。
    const mySeq = ++loadSeqRef.current;
    if (!gentle) { setWinLoadLoading(true); setWinLoadError(''); }
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/desk/windows/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '后端报错');
      if (gen !== genRef.current) return; // 世界翻篇(切窗/返回列表),旧结果作废
      if (mySeq !== loadSeqRef.current) return; // 同一扇窗内被更新的一轮(send/reroll重新起跑)顶掉了,旧对账整体放弃提交
      const w: WindowDetail = {
        id: d.window.id, project: d.window.project, title: d.window.title || '', recipe_id: d.window.recipe_id,
        note: d.window.note || '', note_depth: typeof d.window.note_depth === 'number' ? d.window.note_depth : 3,
        state_board: d.window.state_board && typeof d.window.state_board === 'object' ? d.window.state_board : {},
        timeline_state: d.window.timeline_state && typeof d.window.timeline_state === 'object'
          ? d.window.timeline_state : { segs: [], cutoff: null, rev: 0 },
        vars: d.window.vars && typeof d.window.vars === 'object' ? d.window.vars : {},
        created_at: d.window.created_at, updated_at: d.window.updated_at,
      };
      const fl: Floor[] = (Array.isArray(d.floors) ? d.floors : []).map((f: any) => ({
        key: f.id, id: f.id, role: f.role, content: f.content || '',
        thinking: f.thinking || null,
        variantsCount: typeof f.variants_count === 'number' ? f.variants_count : 1,
        activeVariant: typeof f.active_variant === 'number' ? f.active_variant : 0,
        report: f.report && typeof f.report === 'object' ? f.report : {},
        createdAt: f.created_at,
      }));
      setWin(w);
      setFloors(fl);
      // 孤儿编辑态自愈(首测"全都没反应"案):流式楼的临时key被服务端id顶替/楼被剪掉后,editingFloorKey
      // 指着一个不存在的楼——编辑框没处渲染却把发送/重roll/保存全部无声锁死。对账后发现孤儿就地清掉。
      setEditingFloorKey((k) => (k && !fl.some((x) => x.key === k) ? null : k));
      // 美化覆盖表随正史修剪
      setBeautifyOverrides((prev) => {
        const alive = new Set(fl.map((x) => x.key));
        const next: Record<string, boolean> = {};
        let changed = false;
        for (const [k, v] of Object.entries(prev)) { if (alive.has(k)) next[k] = v; else changed = true; }
        if (!changed) return prev;
        try { localStorage.setItem(beautifyStorageKey(id), JSON.stringify(next)); } catch { /* 存不进就算了,内存态已修剪 */ }
        return next;
      });
    } catch (e: any) {
      if (gen !== genRef.current) return;
      if (mySeq !== loadSeqRef.current) return; // 同上:这一趟已经被更新的调用顶掉,连错误横幅都不该是它来贴
      if (gentle) return; // 温柔模式失败就放弃,不糊错误态到屏上(同编辑部家法:对账是兜底不是保证)
      setWinLoadError(e.message || '这扇窗翻不开');
    } finally {
      if (!gentle) setWinLoadLoading(false);
    }
  }, [base, envOk]);

  function scheduleResync(myGen: number, windowId: string, delayMs: number) {
    const tok = ++resyncSeqRef.current;
    if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
    resyncTimerRef.current = setTimeout(async () => {
      if (tok !== resyncSeqRef.current) return;
      resyncTimerRef.current = null;
      if (genRef.current !== myGen) return; // 世界翻篇,这单对账没意义了
      if (sendingRef.current) { scheduleResync(myGen, windowId, 4000); return; }
      try { await loadWindow(windowId, true, myGen); } catch { /* 拉取真炸了就放弃,同编辑部取舍 */ }
    }, delayMs);
  }
  useEffect(() => () => { if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current); }, []);

  // ── 下行正则规则表——窗口(win)首次装载完整后拉一次,downRulesFetchedForRef 挡住同一扇窗
  // 后续 gentle reload 触发的重复请求(win 对象引用每次 reload 都换,但 id 不变——挡的是 id,不是引用)。
  // 两口请求:①配方列表(项目维度,现有后端没有"单个配方"端点,借列表反查 preset_id) ②正则全表
  // (不按 scope/preset_id 过滤——过滤会连 scope='global' 的行一起漏掉,因为它们 preset_id 是 NULL,
  // 过滤条件写不出"preset_id=X 或 scope=global"这种OR,干脆全量拉回来前端自己筛)。
  useEffect(() => {
    if (mode !== 'write' || !win || !curWindowId || win.id !== curWindowId) return;
    // 判重键原来只用win.id,换配方(recipe_id变了、id没变——同一扇窗)不会
    // 触发重拉,继续拿着旧preset反查出的美化正则渲染,切完配方会以为立刻生效,其实卡着旧规则。
    // 键里焊上recipe_id,配方一变这把钥匙天然对不上,自动触发重拉——不用额外写"配方变了就清缓存"
    // 这种专门判断,判重键本身就把这件事说清楚了。
    const rulesKey = `${win.id}#${win.recipe_id}`;
    if (downRulesFetchedForRef.current === rulesKey) return;
    // 占坑挪到"事成之后":提前占坑+中途被gentle reload取消=坑占死了再也不重拉。
    // 被取消的请求不留印,下一次effect照常重来;并发的两趟里迟到者被cancelled闸挡住,不会双写。
    let cancelled = false;
    (async () => {
      try {
        if (!envOk) throw new Error('环境变量没配好');
        // 配方全桌通用后——这里的配方反查(recipe_id→preset_id,给下行正则认包用)
        // 不能再按窗口project过滤:窗口现在可以引用别的项目建的配方,过滤会把它漏掉→presetId落null
        // →这窗的预设专属美化规则无声失效(班子在通用化施工时抓出的连带雷)。
        const [recipesRes, regexRes] = await Promise.all([
          fetch(`${base}/api/oc/desk/recipes`),
          fetch(`${base}/api/oc/desk/regex`),
        ]);
        if (!recipesRes.ok || !regexRes.ok) throw new Error(`HTTP ${recipesRes.status}/${regexRes.status}`);
        const rd = await recipesRes.json().catch(() => null);
        const gd = await regexRes.json().catch(() => null);
        if (!rd || rd.success !== true || !gd || gd.success !== true) throw new Error(rd?.error || gd?.error || '后端报错');
        const recipe = (Array.isArray(rd.recipes) ? rd.recipes : []).find((r: any) => r.id === win.recipe_id);
        const presetId: string | null = recipe ? recipe.preset_id : null;
        const allRules: DeskRegexRule[] = Array.isArray(gd.regex) ? gd.regex : [];
        const applicable = allRules.filter((r) => r.scope === 'global' || (r.scope === 'preset' && !!presetId && r.preset_id === presetId));
        if (!cancelled) { downRulesFetchedForRef.current = rulesKey; downRulesVerRef.current += 1; downCacheRef.current.clear(); setDownRules(applicable); setDownRulesNotice(''); }
      } catch {
        // 失败降级为无操作(工单点2):规则表拿不到就当没有下行正则,楼层照常显示原文,绝不拦阅读
        if (!cancelled) { downRulesFetchedForRef.current = rulesKey; downRulesVerRef.current += 1; downCacheRef.current.clear(); setDownRules([]); setDownRulesNotice('美化正则没读到,这扇窗先看原文~'); }
      }
    })();
    return () => { cancelled = true; };
  }, [mode, win, curWindowId, base, envOk, downRulesReloadNonce]);

  // 抽屉里改了正则/导入了新预设→开着的窗立刻重拉规则表
  function onRegexChangedFromDrawer() {
    downRulesFetchedForRef.current = null;
    downRulesVerRef.current += 1;
    downCacheRef.current.clear();
    setDownRulesReloadNonce((n) => n + 1);
  }

  // 切窗/返回列表前的共同栅栏:先掐掉正在飞的流,等它自己的收尾 promise 落地
  // (sendingRef 复位/floors 增量/canonical reload 都在那份收尾里,不能让旧世界的收尾追上新世界)
  // ——settle 完了才轮到 genRef++ 世界翻篇,顺手兜底复位一次互斥锁。
  async function abortActiveStream() {
    if (abortRef.current) abortRef.current.abort();
    if (pendingRef.current) { try { await pendingRef.current; } catch {} }
  }

  async function enterWindow(id: string) {
    await abortActiveStream();
    genRef.current++;
    sendingRef.current = false;
    pinnedRef.current = true; // 换窗=新对话从底部看起,清掉上一扇窗残留的解钉状态
    setSending(false);
    setTurnKind(null);
    setDeskError('');
    setCurWindowId(id);
    curWindowIdRef.current = id;
    setWin(null); setFloors([]); setWinLoadError('');
    setTimelineOpen(false); setNoteOpen(false); setBoardOpen(false); setDryrunOpen(false);
    // 切窗后在飞透视的 finally 被窗口双证正确跳过——所以
    // 翻篇入口自己负责杀令牌+复位 dryrun 全套,否则 dryrunLoading 卡 true,新窗的透视被重入闸
    // 永久拦死(直到整组件重挂载)。
    dryrunSeqRef.current++;
    setDryrunLoading(false); setDryrunReport(null); setDryrunError('');
    setEditingFloorKey(null);
    // ⋯ 菜单的三块回执都是**本窗**的话,跨窗残留会读串(上一扇窗"折了26层"的回执挂在新窗
    // 顶上,像是这扇窗刚被压过)。跟 dryrun 那组同一条纪律:翻篇入口自己负责复位。
    // compressing/compressingRef 刻意**不**在这里复位——离窗闸已经保证压缩在飞时走不到这儿,
    // 真要在这里强制清零反而会把还在飞的那趟的 finally 复位提前,埋一个"锁提早解开"的洞。
    setMenuOpen(false); setCompressNote(''); setCompressError(''); setExportError('');
    downRulesFetchedForRef.current = null;
    downRulesVerRef.current += 1; downCacheRef.current.clear();
    setDownRules([]); setDownRulesNotice('');
    setBeautifyOverrides(loadBeautifyOverrides(id));
    setMode('write');
    loadWindow(id, false, genRef.current);
    try { const d = localStorage.getItem(`oc_desk_draft_${id}`); setInput(d || ''); } catch { setInput(''); }
  }
  async function backToList() {
    // 换配方PUT在飞时不许离窗:离窗后立刻重进会让canonical加载读到旧recipe_id,
    // 而成功回写又被世界闸丢弃且无人补对账——前端从此显示旧配方、后端却已是新配方。PUT亚秒级,
    // 锁一拍就过,比"成功后跨窗补对账"那套便宜且不引入新竞态。
    if (recipeSwitchingRef.current) { setDeskError('配方切换中,稍等一两秒再离开'); return; }
    if (timelineSavingRef.current) { setDeskError('时光带保存中,稍等一两秒再离开'); return; }
    // 压缩在飞时不许离窗——它是一趟 30~100 秒的模型调用,人走了回执没人接、窗口详情也不会
    // 重拉,回来看到的是压缩前的旧时光带(而库里已经变了)。跟配方切换/时光带保存同一族待遇。
    if (compressingRef.current) { setDeskError('正在压缩时光带,等它折完再走(约半分钟)'); return; }
    // 三道闸(状态板/时光带 → 世界书 → 文具盒)**先全问一遍、都点头了才动手**——任何一道边问边关,
    // 都会在后面那道拦下时留下"人没走成、草稿已经丢了"的半截状态。
    if (!boardGate('back')) return;
    // 世界书浮窗也是同一族——它里头的核心记忆草稿/条目行内编辑器
    // 原来住在文具盒里、由 drawerRef.requestClose() 顺带保着,抬进浮窗之后不主动问就没人管了。
    if (!loreGate('back')) return;
    // 写作屏自己那颗文具盒(writeDrawerOpen)开着且有未存草稿时,
    // "← 返回"也不许悄悄把它连根卸掉——问一句 drawerRef,拦下就原地不动(文具盒自己的关闭按钮
    // 文案会变成"再点一次丢弃并关闭",能看得见发生了什么);这不是这里要修的具体
    // 复现路径(那两条在 page.tsx 的 rail/家链接),但同一个漏洞家族、同一个 drawerRef 就在手边,
    // 顺手堵上,不留"rail/家守住了、← 返回还在裸奔"的不对称。
    if (drawerRef.current && !drawerRef.current.requestClose()) return;
    // 全部闸都点过头了,现在才真的动手(文具盒是最后一道,它之后没有会反悔的闸)
    resetBoardState(); resetLoreState();
    await abortActiveStream();
    genRef.current++;
    sendingRef.current = false;
    setSending(false);
    setTurnKind(null);
    setDeskError('');
    if (resyncTimerRef.current) { clearTimeout(resyncTimerRef.current); resyncTimerRef.current = null; }
    // 回列表也是世界翻篇,dryrun 在飞的话同样要杀令牌+复位,
    // 不然下次进任何窗透视都被卡死的 dryrunLoading 拦住。
    dryrunSeqRef.current++;
    setDryrunOpen(false); setDryrunLoading(false); setDryrunReport(null); setDryrunError('');
    setMode('list');
    setCurWindowId(null);
    curWindowIdRef.current = null;
    setWin(null); setFloors([]);
    setWinNonce((n) => n + 1); // 回列表时顺手刷新一次(楼层数/updated_at 可能变了)
  }

  // 列表屏"← 书架"钮原来直接调父级 onBack——文具盒(列表屏那颗,
  // drawerRef 此刻挂的是它)开着带脏草稿时点它,组件被父级卸载,草稿静默丢失,没过 requestClose
  // 也没过 requestLeave(onBack 是 page.tsx 传下来的裸回调,不经过任何这边的守卫)。补一行同款闸
  // (照 backToList 那句一字不改):没开/没脏/已经在 discardTimer 窗口内确认过一次→放行,真的调
  // onBack();有脏草稿且第一次问→drawer 自己把 discardArm 亮起来,原地不动。不为这一个按钮另起
  // 一个"统一 leave helper"抽象——就一行闸,跟 backToList 那句抄一遍比多包一层函数更看得清。
  function leaveToShelfFromList() {
    if (drawerRef.current && !drawerRef.current.requestClose()) return;
    onBack();
  }

  // 左廊点别的门 = 从这扇窗"离开"(page.tsx 会紧接着卸载这个组件)——守卫口径原样照抄 backToList
  // 那一段(见上面注释,同一个 recipeSwitchingRef 互斥闸):配方切换在飞就拦下,横幅走 deskError
  // (组件这时还没被卸载,横幅显示得出来);放行的话把飞着的流掐掉+世界代数翻篇,交给即将到来的卸载
  // 收尾。跟 backToList 的差别只在于:这里不 await abortActiveStream() 的收尾 promise 落地(那一步
  // 是为了"留在同一个组件里、接着要显示新列表"服务的;这里组件本身要被卸载,旧世界的收尾回调靠
  // genRef 世代闸自然作废,不需要真的等它跑完)。
  //
  // 这道闸原来只懂"配方在飞",不懂"文具盒里还有没存的草稿"——page.tsx 的
  // rail切门/"家"链接直接调这个函数,配方没在飞就放行,写作屏或列表屏那颗文具盒(不管哪个开着,
  // drawerRef 天然跟着当前挂载的那个走)有脏草稿也会被静默连根卸掉。统一离开协议:先问
  // drawerRef.current.requestClose()——drawer 没开/没脏就是空操作直接过(true);有脏草稿且
  // 还没被确认过,drawer 自己把 discardArm 亮起来(关闭按钮文案变"再点一次丢弃并关闭",这时
  // drawer 还开着盖在写作屏/列表屏右侧,能看得见),这次 requestLeave 原地按兵不动(false)。
  // 接下来不管是在文具盒里再点一次关闭/背板,还是索性再点一次同一扇目标门(discardTimer
  // 3.5s 内没过期,第二次 requestClose 会命中"已确认"那支真的关掉),第二次 requestLeave 才会
  // 真的往下走。不新发明确认UI,完全复用 DeskDrawerHub 现成的两段确认状态机。
  useImperativeHandle(deskRef, () => ({
    requestLeave(): boolean {
      if (recipeSwitchingRef.current) { setDeskError('配方切换中,稍等一两秒再离开'); return false; }
      if (timelineSavingRef.current) { setDeskError('时光带保存中,稍等一两秒再离开'); return false; }
      if (compressingRef.current) { setDeskError('正在压缩时光带,等它折完再走(约半分钟)'); return false; } // 同 backToList 那道,理由见那边
      // 同 backToList:三道闸先全问、都点头了才动手
      if (!boardGate('leave')) return false;
      if (!loreGate('leave')) return false;
      if (drawerRef.current && !drawerRef.current.requestClose()) return false;
      resetBoardState(); resetLoreState();
      if (abortRef.current) abortRef.current.abort();
      genRef.current++;
      sendingRef.current = false;
      setSending(false);
      setTurnKind(null);
      setDeskError('');
      if (resyncTimerRef.current) { clearTimeout(resyncTimerRef.current); resyncTimerRef.current = null; }
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // 流式追尾钉底:贴底(<120px)才跟滚,往上翻=解钉——流式
  // 继续吐但视角不动;自己滑回底部自动重钉。发送/重发时在 send() 里强制重钉(那一刻肯定想看新楼)。
  // ⚠️钉住时用 'auto' 瞬滚不用 smooth:smooth 的中间帧位置离底很远,scroll 监听器会把自己的
  // 补间误判成"用户翻上去了"当场解钉;'auto' 同步落底,监听器读到的永远是贴底位置。
  // 内容增高本身不触发 scroll 事件,所以钉/解钉只会由真实滚动(用户或瞬滚落底)驱动,不会自激。
  const pinnedRef = useRef(true);
  // ⚠️耳朵挂在写作屏 <main> 的 onScroll 上,不是 window——应用壳化后滚动发生在壳内那层
  // overflow-y-auto 的 <main>,window 根本不滚。首发挂错了窗户(window 监听器永远不响,pinned
  // 恒 true,钉底形同虚设),这是实测"打字桌不行、别处ok"抓出来的差异:别处没壳化、真滚窗口,所以好使。
  const onScrollerScroll = (e: React.UIEvent<HTMLElement>) => {
    const el = e.currentTarget;
    pinnedRef.current = el.scrollHeight - el.clientHeight - el.scrollTop < 120;
  };
  useEffect(() => {
    if (!pinnedRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [floors]);

  // ── composer 草稿:按窗口分槽存 localStorage ──
  const [input, setInput] = useState('');
  // send()里给"这条消息是不是还是composer里当前那份"当判据的地方
  // (onUserSaved清稿/失败回填)不能读闭包里的input——那是send()被调用那一刻的旧快照,resendOrphan
  // 的truncate网络往返+send()自己的SSE往返都要等好几百毫秒,这段时间完全可能已经在composer里
  // 敲了别的字,闭包却看不到。inputRef同步镜像"此刻composer里究竟装的是什么",在onChange和这里的
  // effect两处写入,读的地方永远是活的当下值。
  const inputRef = useRef('');
  useEffect(() => {
    if (!curWindowId) return;
    try { localStorage.setItem(`oc_desk_draft_${curWindowId}`, input); } catch {}
  }, [input, curWindowId]);
  useEffect(() => { inputRef.current = input; }, [input]);

  // ── @角色卡候选下拉(后端"@点名"配套的打字辅助;数据/视觉锚点见 footer 里 composer textarea 那段) ──
  // 数据源跟 DeskDrawers.tsx LoreTab 同一个接口(GET lore?project=),这里只要 is_char 的那批的
  // name——菜单是帮忙打对字用的,不是世界书浏览器,keys/content 一概不需要。
  const [charCards, setCharCards] = useState<string[]>([]);
  const atCardsSeqRef = useRef(0); // 同 loreSeqRef 家法(DeskDrawers.tsx):project连续切换时,晚到的旧响应不许覆盖新的
  useEffect(() => {
    const proj = win?.project;
    const tok = ++atCardsSeqRef.current;
    if (!proj) { setCharCards([]); return; } // 还没进写作屏/win没载完——菜单先是空的
    (async () => {
      try {
        const res = await fetch(`${base}/api/oc/desk/lore?${new URLSearchParams({ project: proj })}`);
        const d = await res.json().catch(() => null);
        if (!res.ok || !d || d.success !== true) throw new Error();
        if (tok !== atCardsSeqRef.current) return;
        const rows: any[] = Array.isArray(d.lore) ? d.lore : [];
        // is_char 后端可能给 0/1 也可能给 true/false,一律 truthy 判断(规格①)
        setCharCards(rows.filter((r) => !!r?.is_char && typeof r?.name === 'string' && r.name).map((r) => r.name as string));
      } catch {
        // 拉取失败静默——菜单就是空的,不弹错误横幅(打字辅助不值当吓到人)
        if (tok === atCardsSeqRef.current) setCharCards([]);
      }
    })();
  }, [base, win?.project]);

  // 菜单开关态。atQuery=@后面已经打出来的那一截(可能是空串,刚打完@还没接字);
  // atIdx=当前高亮候选的下标(方向键上下移动用,允许溢出/为负,读取时一律走下面的atIdxSafe夹紧)。
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [atIdx, setAtIdx] = useState(0);
  // 组字状态镜像(compositionstart/end里维护)——onChange/onSelect判"要不要重算菜单"要用它,
  // 插入候选时写selectionStart/End前也要再核一遍(头部137-147行硬红线:组字中绝不许碰选区)。
  const composingRef = useRef(false);
  // 插入候选后光标该落的目标位置。受控textarea此刻el.value还是插入前的旧值,立刻写selectionStart
  // 会被这次setInput引发的重渲染盖掉——先记一个一次性标记,等下面那个跟着input变化跑的effect
  // 在渲染提交之后再消费(文件里"记标记、下个effect回写"是既有手法,不是这里新发明的花活)。
  const pendingCaretRef = useRef<number | null>(null);

  const atCandidates = useMemo(() => {
    if (!atMenuOpen) return [];
    const q = atQuery.toLowerCase();
    return q ? charCards.filter((n) => n.toLowerCase().includes(q)) : charCards; // 规格③
  }, [atMenuOpen, atQuery, charCards]);
  const atMenuVisible = atMenuOpen && atCandidates.length > 0; // 规格③:无候选就不显示,键盘也不拦
  // charCards异步到达/query变化都可能让候选列表比atIdx还短(比如高亮着第4项时候选缩到只剩2个),
  // 读取用这个夹紧过的下标,别让 atCandidates[atIdx] 读出 undefined。
  const atIdxSafe = atCandidates.length > 0 ? Math.min(Math.max(atIdx, 0), atCandidates.length - 1) : 0;

  // 光标/内容变化后重算菜单状态:光标前文本末尾是不是正落在一个@token上。用selectionStart不用
  // selectionEnd——这只关心"打字/移动产生的折叠光标"这一种场景,没打算兼容"选中一段文字"这种边缘操作。
  function recomputeAtMenu(el: HTMLTextAreaElement) {
    const pos = el.selectionStart;
    if (pos === null) { setAtMenuOpen(false); return; }
    const before = el.value.slice(0, pos);
    const m = before.match(AT_TOKEN_RE);
    // ASCII左边界(跟后端extractAtMentions同一条规则):@前一个字符是ASCII字母数字或邮箱局部符时,
    // 这是someone@example.com那类标识符,后端不认——菜单也别弹,不然点了候选插出一段后端会无视
    // 的"@卡名",前后端语义错位。汉字左邻照常放行("准了@张淮深"是真实用法)。
    // ⚠️不能抄后端的lookbehind正则:Safari<16.4解析lookbehind直接SyntaxError,整个模块炸掉,
    // 主力设备是iPad——所以用"match完手动看前一个字符"的写法,行为等价,老浏览器安全。
    const prevCh = m && typeof m.index === 'number' && m.index > 0 ? before.charAt(m.index - 1) : '';
    if (m && !(prevCh && /[A-Za-z0-9._%+-]/.test(prevCh))) { setAtQuery(m[1]); setAtIdx(0); setAtMenuOpen(true); }
    else setAtMenuOpen(false);
  }

  // 切窗口=世界翻篇,菜单跟着一起收(规格⑧)。"发送"这条不用在这里另开口子:发送要么走键盘Enter
  // (菜单开着时Enter已经被下面onComposerKeyDownAt接管,压根到不了send()),要么点"发送"按钮——
  // 点按钮前浏览器默认行为就会先把textarea blur掉,下面textarea的onBlur已经把菜单收了,不用在
  // send()内部再插一行(省得碰"不要动发送逻辑"这条红线)。
  useEffect(() => { setAtMenuOpen(false); }, [curWindowId]);

  // 插入候选:把光标前的"@partial"换成"@卡名 "(带一个尾随空格,方便直接接着打字或发送)。
  function insertAtCandidate(name: string) {
    // IME闸:键盘路径有isComposingKey挡着,但**指针路径**(点候选)没有——菜单开着时
    // 开始拼音组字再点候选,这里若继续跑就会在组字中途读选区+setInput覆盖受控值,打断上屏丢字。
    // 组字期间一律拒绝插入,连selectionStart都不读;菜单本身在onCompositionStart已经关了,这里是
    // 纵深防御(blur/状态时序再怎么飘也进不来)。
    if (composingRef.current) { setAtMenuOpen(false); return; }
    const el = composerRef.current;
    const pos = el ? el.selectionStart : null;
    if (!el || pos === null) { setAtMenuOpen(false); return; }
    const before = input.slice(0, pos);
    const m = before.match(AT_TOKEN_RE);
    if (!m) { setAtMenuOpen(false); return; } // 防御:菜单开着理应匹配得到,真落空了宁可不插也别插错地方
    const atStart = pos - m[0].length;
    const insText = '@' + name + ' ';
    setInput(input.slice(0, atStart) + insText + input.slice(pos));
    setAtMenuOpen(false);
    pendingCaretRef.current = atStart + insText.length;
  }
  // 上面setInput提交、组件重渲染之后这个effect才会跑(受控textarea的DOM value这时已经是新值),
  // 满足"写selection必须在React渲染完成后"这条要求;composingRef那道兜底理由同头部注释,虽然
  // 插入这条路径本来就只可能发生在非组字状态(下面菜单键盘拦截里已经用isComposingKey挡过一轮
  // 组字期的Enter/Tab,不会误触发插入)。
  useEffect(() => {
    const pos = pendingCaretRef.current;
    if (pos === null) return;
    pendingCaretRef.current = null;
    const el = composerRef.current;
    if (!el || composingRef.current) return;
    el.selectionStart = pos;
    el.selectionEnd = pos;
    grow(el); // 插入的卡名长短跟原来的"@片段"不一定一样,顺手补一次自增高(同onInput那条路径手法)
  }, [input]);

  // 菜单打开且有候选时,方向键/Enter/Tab/Escape 全部在这里拦下来给菜单用,不许漏到下面
  // onComposerKeyDown里(尤其Enter——漏过去就从"选中候选"变成了"发送")。IME组字中的Enter是
  // 输入法上屏动作,不是"选中候选"的意图,跟isComposingKey那条既有红线保持一致,原样放行。
  function onComposerKeyDownAt(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (atMenuVisible && !isComposingKey(e)) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAtIdx((i) => (i + 1) % atCandidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAtIdx((i) => (i - 1 + atCandidates.length) % atCandidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertAtCandidate(atCandidates[atIdxSafe]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setAtMenuOpen(false); return; }
    }
    onComposerKeyDown(e);
  }

  function patchFloor(myGen: number, key: string, fn: (f: Floor) => Floor) {
    if (myGen !== genRef.current) return; // 世界翻篇,这条流式增量不该落到新世界头上
    setFloors((prev) => prev.map((f) => (f.key === key ? fn(f) : f)));
  }

  // ── SSE 消费(同编辑部 callChat 的 data: 行解析,desk 没有工具事件,usage/ping 不用管) ──
  // FIX1:不再"读完循环就当成功"——显式收口成 outcome,done 事件才算体面终态,
  // error 事件/没等到 done 就 EOF/fetch或读流本身炸了(含 abort),一律算 error,绝不裸 resolve "ok"。
  type StreamOutcome = { done: true; floorId?: string } | { error: string; aborted?: boolean };
  async function streamChat(body: any, handlers: {
    onUserSaved?: (id: string) => void;
    onText?: (t: string) => void;
    onThinking?: (t: string) => void;
  }, signal?: AbortSignal): Promise<StreamOutcome> {
    let res: Response;
    try {
      res = await fetch(`${base}/api/oc/desk/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') return { error: '已暂停', aborted: true };
      return { error: `连接断了：${err?.message || err}` };
    }
    // 无声守卫排查(实测撞到的洞:删配方没查窗口引用,窗口还钉着旧recipe_id,重roll时后端
    // assembleDesk 装配失败返回 HTTP 500 + {success:false, error:'配方不存在: ...'}这样的JSON体——
    // 原来这里 !res.ok 直接吐 `HTTP ${res.status}`,body 一个字都没读,后端精心写的错误文案被
    // 无声吞掉,只会看到一句干巴巴的"HTTP 500",猜不出是配方被删了。补上读体,读不出JSON
    // (比如真的网关级500,body压根不是JSON)才退回HTTP状态码文案兜底。
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const eb = await res.json();
        if (eb && typeof eb.error === 'string' && eb.error) msg = eb.error;
      } catch { /* 非JSON错误体(网关级故障等),退回HTTP状态码文案 */ }
      return { error: msg };
    }
    if (!res.body) return { error: '响应没有内容(服务端异常)' };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const p = t.slice(5).trim();
          if (!p) continue;
          let e: any;
          try { e = JSON.parse(p); } catch { continue; }
          if (e.type === 'user_saved') handlers.onUserSaved?.(e.id);
          else if (e.type === 'text') handlers.onText?.(e.text);
          else if (e.type === 'thinking') handlers.onThinking?.(e.text);
          else if (e.type === 'done') return { done: true, floorId: e.id };
          else if (e.type === 'error') return { error: e.error || '出错了' };
          // ping/usage 不用管:打字桌没有额度面板,desk 手套零工具也不会吐 tool 事件
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return { error: '已暂停', aborted: true };
      return { error: `连接断了：${err?.message || err}` };
    }
    // 读到 EOF 但压根没收到 done/error——流断在半道,同样不算体面收尾(desk.ts writer.close() 前
    // 一定会先发 done 或 error,读到这里说明连接被腰斩,不是服务端的正常收尾)
    return { error: '流断在半道,没收到结束信号' };
  }

  // ── ①普通发送 ──
  const [sending, setSendingState] = useState(false);
  function setSending(v: boolean) { setSendingState(v); }
  // FIX1:composer/草稿在 user_saved 事件真正到达前不清——那才是后端把用户这楼落库的
  // 时刻(见 chat/desk.ts pumpVps「mode==='normal' 就先 send user_saved」)。user_saved 之前但凡失败,
  // 把刚才提交的字连本带利还回composer+这扇窗的草稿槽,一个字都不许丢。
  // 孤儿user楼重发,复用send()逻辑而不是另外复制一份:补一个可选的overrideMsg——
  // resendOrphan() 剪掉孤儿楼之后拿它的原文当这个参数直接调用,不经过composer/input这层状态
  // (省一趟"先setInput再读input"的时序坑,setState不同步落到当前闭包)。不传时=原来的行为
  // (读input),footer发送按钮那个调用点照旧不传参,一字不变。
  async function send(overrideMsg?: string) {
    const msg = (overrideMsg !== undefined ? overrideMsg : input).trim();
    if (!msg || sendingRef.current || !curWindowId) return;
    // 被互斥矩阵拦下时明说原因(无声守卫容易被当成坏了)
    if (editingFloorKey !== null) { setDeskError('有楼层正在编辑中——先点它的「保存」或「取消」,再发送'); return; }
    if (mutRef.current > 0) { setDeskError('有改动正在保存,稍等一两秒再试'); return; }
    // 读ref不读state,理由同saveBoard入口那段注释:状态板PUT在飞时
    // 不许起新生成——两条写路径都在改这条窗记录,不拦会跟finalizeDeskTurn那次收尾写撞车。反过来
    // "脏草稿但没在保存"不拦生成(她开着面板琢磨措辞时想先发一楼是合理流,拦了才烦)——脏+
    // 生成完事之后交给对账跟进效应的冲突态兜住。
    if (boardSavingRef.current) { setDeskError('状态板保存中,稍等一两秒再试'); return; }
    if (timelineSavingRef.current) { setDeskError('时光带保存中,稍等一两秒再试'); return; }
    // 互斥只有单向:换配方PUT在飞时同理不许起新生成——正在换的这个recipe_id
    // 可能这楼装配就要用上,读ref理由同上面boardSavingRef那行。
    if (recipeSwitchingRef.current) { setDeskError('配方切换中,稍等一两秒再试'); return; }
    if (composerRef.current) composerRef.current.style.height = 'auto';
    const windowId = curWindowId;
    const myGen = genRef.current;
    sendingRef.current = true;
    pinnedRef.current = true; // 自己发消息=想看新楼,强制重钉(钉底机制见 pinnedRef 声明处)
    // 全部互斥门禁已过,这一轮真正起跑——抢先自增加载序号,把上一轮(哪怕同一扇窗)还在飞的旧
    // loadWindow(gentle)对账预先作废,不等它自己下次调用去顶。
    loadSeqRef.current++;
    setSending(true);
    setTurnKind('send');
    const userKey = 'u' + Date.now();
    const asgKey = 'a' + Date.now();
    setFloors((prev) => [...prev,
      { key: userKey, role: 'user', content: msg, variantsCount: 1, activeVariant: 0, report: {} },
      { key: asgKey, role: 'assistant', content: '', thinking: '', variantsCount: 1, activeVariant: 0, report: {}, streaming: true },
    ]);
    const ac = new AbortController();
    abortRef.current = ac;
    const turn = (async () => {
      let userSaved = false;
      const outcome = await streamChat({ window_id: windowId, message: msg, channel: 'vps', model }, {
        onUserSaved: (id) => {
          userSaved = true;
          patchFloor(myGen, userKey, (f) => ({ ...f, id }));
          // overrideMsg(resendOrphan重发孤儿楼)路径不能无条件
          // 清composer——从resendOrphan剪楼到这里收到user_saved,中间隔着两趟网络往返,这段时间里完全
          // 可能已经在composer里开始写别的东西。没传overrideMsg(composer本来就是这条消息的正主,
          // 原行为不变)、或者composer现在是空的(没什么好清的,顺手把草稿槽也归零)、或者composer
          // 里装的还是这条overrideMsg本身(trim后比较,没被动过)——这三种情况才清;composer装着
          // 别的非空内容时原样不碰,留着她的新草稿一个字不少。
          if (overrideMsg === undefined || !inputRef.current.trim() || inputRef.current.trim() === overrideMsg.trim()) {
            setInput('');
            try { localStorage.setItem(`oc_desk_draft_${windowId}`, ''); } catch {}
          }
        },
        onText: (t) => patchFloor(myGen, asgKey, (f) => ({ ...f, content: f.content + t })),
        onThinking: (t) => patchFloor(myGen, asgKey, (f) => ({ ...f, thinking: (f.thinking || '') + t })),
      }, ac.signal);
      if (abortRef.current === ac) abortRef.current = null;

      if ('done' in outcome) {
        patchFloor(myGen, asgKey, (f) => ({ ...f, id: outcome.floorId, streaming: false }));
        if (myGen === genRef.current) { setDeskError(''); loadWindow(windowId, true, myGen).catch(() => {}); }
      } else {
        patchFloor(myGen, asgKey, (f) => ({ ...f, streaming: false }));
        let bannerMsg = outcome.error;
        if (!userSaved) {
          // 用户楼层都没存住:把这两条占位楼层原样撤回。同上一条注释同一病根——overrideMsg路径下
          // composer此刻若已经被填上别的内容(非空且不是这条overrideMsg本身),composerUntouched
          // 为真,不能覆盖它;但这时 msg 已经没有任何楼层在存着了(孤儿楼在 resendOrphan 里已经被
          // truncate 剪掉,这次 send 自己又没能存住新楼层)——composer/草稿槽两条路都堵着才是真的
          // 会丢字,所以这种情形改把原文直接摆进错误横幅里,能看见能复制,不靠去翻一个根本
          // 不知道存在、且下一次打字就会被"input变化"那个effect悄悄覆盖掉的草稿槽。
          const composerUntouched = overrideMsg !== undefined && !!inputRef.current.trim() && inputRef.current.trim() !== overrideMsg.trim();
          if (!composerUntouched) {
            try { localStorage.setItem(`oc_desk_draft_${windowId}`, msg); } catch {}
          } else {
            bannerMsg = `${outcome.error}——输入框里有别的内容没被碰,这条没发出去的消息原文帖在这里,先复制走保存好:\n\n${msg}`;
          }
          if (myGen === genRef.current) {
            setFloors((prev) => prev.filter((x) => x.key !== userKey && x.key !== asgKey));
            if (!composerUntouched) setInput(msg);
          }
        } else if (myGen === genRef.current) {
          // 用户楼层已经落库,只是AI这半截没能收尾——撤掉占位气泡,靠下面的对账把真实状态接回来。
          // userSaved=true 这条分支不存在"msg 没地方存"的问题(它已经是一条真实落库的楼层了),
          // 不需要 composerUntouched 那套兜底,原样保留原逻辑。
          setFloors((prev) => prev.filter((x) => x.key !== asgKey));
        }
        if (!outcome.aborted && myGen === genRef.current) setDeskError(bannerMsg); // 主动暂停不算"出错",不吓到人
        if (myGen === genRef.current) {
          loadWindow(windowId, true, myGen).catch(() => {});
          if (!outcome.aborted) scheduleResync(myGen, windowId, 2500); // 真出错兜个延迟对账(ctx.waitUntil 可能还在跑)
        }
      }

      if (myGen === genRef.current) { setSending(false); setTurnKind(null); }
      sendingRef.current = false;
    })();
    pendingRef.current = turn;
    await turn;
    if (pendingRef.current === turn) pendingRef.current = null;
  }
  function onComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !isComposingKey(e)) {
      e.preventDefault();
      send();
    }
  }

  // ── ②重roll(最后一楼的手感钮)── 续写按钮/continueWriting()/预览态已整个砍掉:
  // 后端 continue:true 分支留给另一单处理,这边只管让前端够不着它,不留死代码。
  // roll 后端不落用户楼层(chat/desk.ts:`if (mode==='normal') send user_saved`,roll 不是 normal),
  // 压根没有 user_saved 事件,也没有composer文字要复原——失败只管把楼复原+持久横幅+对账。
  //
  // 客厅手感改造:不再灌进独立的 rerollPreview/turnThinking 预览框——直接借 send() 那条正路的
  // 画面态,点下按钮就把目标楼(已经落库、key=服务端真id)当场清空(content/thinking 清空、
  // streaming:true),新增量照旧走 patchFloor 打进 content/thinking,「构思」折叠块 + 正文气泡
  // 边流边显,跟 send() 新占位楼视觉上是同一件事。清空前拿 floorSnapshotRef 捏一份原样快照,
  // 失败/中断时用它把楼复原,绝不停在"被清空"的空壳状态;成功时 done→loadWindow 拿服务端真值
  // 整包对账(variants/report 等),这里的画面态只是"对账落地前的过渡"。
  async function reroll(f: Floor) {
    if (!curWindowId || sendingRef.current || !f.id) return;
    if (editingFloorKey !== null) { setDeskError('有楼层正在编辑中——先保存或取消,再重roll'); return; }
    if (mutRef.current > 0) { setDeskError('有改动正在保存,稍等一两秒再试'); return; }
    if (boardSavingRef.current) { setDeskError('状态板保存中,稍等一两秒再试'); return; } // 同 send() 那道闸,读ref理由见那边注释
    if (timelineSavingRef.current) { setDeskError('时光带保存中,稍等一两秒再试'); return; }
    if (recipeSwitchingRef.current) { setDeskError('配方切换中,稍等一两秒再试'); return; } // 同上
    const windowId = curWindowId;
    const myGen = genRef.current;
    sendingRef.current = true;
    pinnedRef.current = true; // 点重roll=想看新写的字,同 send() 强制重钉
    // 同 send() 那道闸:起跑前抢先自增加载序号,作废上一轮在飞的旧对账(同上头注释)。
    loadSeqRef.current++;
    setSending(true); setTurnKind('reroll');
    floorSnapshotRef.current = { key: f.key, content: f.content, thinking: f.thinking ?? null };
    patchFloor(myGen, f.key, (fl) => ({ ...fl, content: '', thinking: '', streaming: true }));
    const ac = new AbortController();
    abortRef.current = ac;
    const turn = (async () => {
      const outcome = await streamChat({ window_id: windowId, roll: true, channel: 'vps', model }, {
        onText: (t) => patchFloor(myGen, f.key, (fl) => ({ ...fl, content: fl.content + t })),
        onThinking: (t) => patchFloor(myGen, f.key, (fl) => ({ ...fl, thinking: (fl.thinking || '') + t })),
      }, ac.signal);
      if (abortRef.current === ac) abortRef.current = null;

      if ('done' in outcome) {
        // 先落 streaming:false 兜个底——万一紧跟着的 gentle loadWindow 悄悄失败(温柔模式失败就
        // 放弃,同 loadWindow 头注释那条家法),楼不会卡死在流式态;真拉到手了这行马上被整包覆盖。
        patchFloor(myGen, f.key, (fl) => ({ ...fl, streaming: false }));
        if (myGen === genRef.current) { setDeskError(''); loadWindow(windowId, true, myGen).catch(() => {}); }
      } else {
        // 失败/中断(fetch炸/SSE error/主动暂停):拿清空前捏的快照把楼复原,一个字不丢——
        // patchFloor 内部比对 myGen,世界翻篇(切窗/返回列表)时这条恢复自然被世代闸挡住,
        // 不会糊错新世界的楼(不需要在这里另加一层 genRef 判断)。
        const snap = floorSnapshotRef.current;
        if (snap && snap.key === f.key) {
          patchFloor(myGen, f.key, (fl) => ({ ...fl, content: snap.content, thinking: snap.thinking, streaming: false }));
        } else {
          patchFloor(myGen, f.key, (fl) => ({ ...fl, streaming: false })); // 快照丢了(理论不该发生)的防御性兜底,至少别卡在流式态
        }
        if (!outcome.aborted && myGen === genRef.current) setDeskError(outcome.error);
        if (myGen === genRef.current) {
          loadWindow(windowId, true, myGen).catch(() => {});
          if (!outcome.aborted) scheduleResync(myGen, windowId, 2500);
        }
      }
      floorSnapshotRef.current = null;
      if (myGen === genRef.current) { setSending(false); setTurnKind(null); }
      sendingRef.current = false;
    })();
    pendingRef.current = turn;
    await turn;
    if (pendingRef.current === turn) pendingRef.current = null;
  }

  // ── 楼层就地编辑(铅笔→行内 textarea→PUT /floors/:id) ──
  const [editingFloorKey, setEditingFloorKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  // 楼层编辑框的textarea DOM引用(iPad光标错位案修复)——user楼/assistant楼两处渲染分支共用
  // 这一个ref:editingFloorKey全局只可能有一个非null值,同一时刻两处textarea绝不会同时挂载,
  // 共用没有互相踩踏的风险。配合下面的useLayoutEffect,只在"编辑框刚打开"这一下测一次初始
  // 高度(autoFocus那一刻还没打字,scrollHeight要靠这次算出来),打字过程中的增高全权交给
  // 各自textarea的onInput——不再让grow()挂在render期的inline callback ref上反复重跑
  // (原因见grow()头注释)。
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // ⚠️聚焦这件事自己接管,不用 <textarea autoFocus>(iPad 实测:点「编辑」的瞬间
  // 整页刷成空白、要往下滑才重新看见气泡)。autoFocus 走的是"挂载即 focus()",而 focus() 默认
  // **会把元素滚进视野**;iOS 上软键盘同时弹起、可视视口高度骤变,这一脚滚动经常滚飞,
  // 页面看起来就是"内容没了"(其实只是滚到别处去了)。改成 preventScroll 先掐掉那脚默认滚动,
  // 再用 block:'nearest' 补一次——她点「编辑」时那一楼本来就在屏幕上,nearest 通常一步都不滚。
  // 跟文具盒侧栏那个"往左滑再闪回"是同一族病(见 DeskDrawers.tsx 初始焦点 effect)。
  useLayoutEffect(() => {
    if (editingFloorKey === null) return;
    const el = editTextareaRef.current;
    if (!el) return;
    grow(el);
    try { el.focus({ preventScroll: true }); } catch { el.focus(); }
    el.scrollIntoView({ block: 'nearest' });
    // 键盘弹起之后还要再判一次遮挡(实测:现在不弹飞了,但编辑框不跟着输入法一起挪上来,
    // 得先收一次输入法、再点框子才对)。原因是 preventScroll 顺手也掐掉了浏览器"把聚焦元素
    // 让开键盘"那套内建行为,而 scrollIntoView 算的是**布局视口**——iOS 上布局视口不随键盘
    // 变矮,它于是认为框子明明可见、一步都不滚,人却看着它被键盘盖住了。
    // 所以等 visualViewport 真的变矮之后,拿可视视口的底边自己判一次:真被挡住了才滚,
    // 没挡住就一动不动(她手动点框子那条路本来就正常,别去干扰它)。
    // ⚠️不能在第一次 resize 就收工:iOS 键盘是**动画**升起来的,一路会连发好几次
    // resize。第一次事件多半是键盘升到一半时的中间高度——那时判"没挡住"或者按中间高度滚一下,
    // 键盘继续升上来照样把框子盖住,而监听已经拆了、没人管了。所以改成防抖:每来一次 resize 就
    // 重置一个 120ms 的小表,等视口尺寸真正稳下来才判遮挡;整段留一个 700ms 总兜底(外接键盘/
    // 桌面浏览器压根不发 resize,不能干等),兜底跑完才拆监听。
    const vv = window.visualViewport;
    let done = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let backstop: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (done) return;
      const r = el.getBoundingClientRect();
      const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      // 真被挡住了才滚;没挡住一动不动——她手动点框子那条路本来就正常,别去干扰
      if (r.bottom > visibleBottom - 8) el.scrollIntoView({ block: 'center' });
    };
    const onResize = () => {
      if (done) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(check, 120);
    };
    const finish = () => {
      if (done) return;
      check();
      done = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      vv?.removeEventListener('resize', onResize);
    };
    vv?.addEventListener('resize', onResize);
    backstop = setTimeout(finish, 700);
    return () => {
      done = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (backstop) clearTimeout(backstop);
      vv?.removeEventListener('resize', onResize);
    };
  }, [editingFloorKey]);
  // user楼编辑保存=回退重发新增状态:
  // - editRegenStage/editRegenTimers:二段确认家法,照 winDelStage/boardCloseStage
  //   同款"点一次亮警告文案,3秒内再点一次才真的执行"套路,不新开弹窗体系——只有"这楼是user楼
  //   且不是floors数组里最后一楼"这一种情形会被点亮;assistant楼编辑、user孤儿楼编辑,Save按钮
  //   永远维持现状(一次点击直接保存),不会碰这份状态。
  // - pendingRegenSend:技术性中转站,不是画面态——理由见下面confirmFloorEditRegen末尾+紧跟着
  //   那个effect的大段注释,纯粹用来绕开一个真实存在的state闭包时序坑。
  const [editRegenStage, setEditRegenStage] = useState<Record<string, 0 | 1>>({});
  const editRegenTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [pendingRegenSend, setPendingRegenSend] = useState<{ text: string; gen: number; windowId: string } | null>(null);
  function startFloorEdit(f: Floor) {
    if (sendingRef.current || !f.id || editingFloorKey !== null) return;
    if (mutRef.current > 0) return; // 改楼在飞时不许开编辑框:切变体半路开编辑抓的是旧content,存回去=覆盖新变体
    setEditingFloorKey(f.key);
    setEditDraft(f.content);
    setEditError('');
  }
  function cancelFloorEdit() {
    setEditingFloorKey(null); setEditDraft(''); setEditError('');
  }
  async function confirmFloorEdit(f: Floor) {
    const text = editDraft.trim();
    if (!text || editSaving) return;
    if (sendingRef.current) { setEditError('正在生成中,等这一楼写完再保存'); return; } // 双向互斥补口:开着的编辑器也不许在生成中提交
    if (mutRef.current > 0) { setEditError('有别的改动还在保存,稍等一下'); return; } // 改楼互斥
    if (!f.id) { setEditError('这条还没存好,稍等再改'); return; }
    const myGen = genRef.current;
    const windowId = curWindowId;
    setEditSaving(true); setEditError('');
    beginMut(); // 双向互斥:改楼在飞时不许起新生成
    try {
      const res = await fetch(`${base}/api/oc/desk/floors/${f.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '保存失败(服务端没确认成功)');
      if (myGen === genRef.current) {
        setFloors((prev) => prev.map((x) => (x.key === f.key ? { ...x, content: text } : x)));
        setEditingFloorKey(null); setEditDraft('');
        if (windowId) loadWindow(windowId, true, myGen).catch(() => {}); // FIX3:成功后 canonical reload 接回 report/variants 之类的真值
      }
    } catch (e: any) {
      const msg = e.message || '保存失败';
      setEditError(msg); // 编辑框旁边留个即时反馈——editingFloorKey/editDraft 原样不动,没打字白打
      if (myGen === genRef.current) {
        setDeskError(msg);
        if (windowId) loadWindow(windowId, true, myGen).catch(() => {});
      }
    }
    finally { endMut(); if (myGen === genRef.current) setEditSaving(false); }
  }
  // Save按钮统一入口(任务2):assistant楼 / user楼最后一楼(孤儿)——维持现状,点一次直接保存
  // (confirmFloorEdit一字不改,重发钮已经覆盖"孤儿user楼想重新生成"这个场景,这里不抢它的活)。
  // user楼且不是最后一楼——先过二段确认(见editRegenStage头注释那份状态的用途),真按下确认后
  // 才转给confirmFloorEditRegen动手。
  function onFloorSaveClick(f: Floor) {
    if (editSaving) return;
    const isLastFloor = f.key === floors[floors.length - 1]?.key;
    if (f.role !== 'user' || isLastFloor) { confirmFloorEdit(f); return; }
    const stage = editRegenStage[f.key] || 0;
    if (stage === 0) {
      setEditRegenStage((s) => ({ ...s, [f.key]: 1 }));
      if (editRegenTimers.current[f.key]) clearTimeout(editRegenTimers.current[f.key]);
      editRegenTimers.current[f.key] = setTimeout(() => setEditRegenStage((s) => ({ ...s, [f.key]: 0 })), 3000);
      return;
    }
    if (editRegenTimers.current[f.key]) clearTimeout(editRegenTimers.current[f.key]);
    setEditRegenStage((s) => ({ ...s, [f.key]: 0 }));
    confirmFloorEditRegen(f);
  }
  // Save按钮文案(任务2):stage1时把"后面N楼将被剪掉"的真实数字算出来贴脸上——N=floors数组里
  // 排在这楼之后的楼层数(不含本楼自己;本楼会被剪掉又立刻重新造一条,不算在"被剪掉"的后续楼里)。
  function floorSaveLabel(f: Floor): string {
    if (editSaving) return '保存中…';
    if ((editRegenStage[f.key] || 0) === 1) {
      const idx = floors.findIndex((x) => x.key === f.key);
      const n = idx < 0 ? 0 : floors.length - 1 - idx;
      return `保存并从这楼重新生成,后面${n}楼将被剪掉——确定?再点一次`;
    }
    return '保存';
  }
  // user楼编辑保存=回退重发:这楼不是最后一楼,单纯PUT改字不够——
  // 后面还跟着别的楼层,内容跟新编辑稿对不上了。两条路线读代码后选定这条(报告里也这么写):
  // ①truncate inclusive:true 锚点定成"下一楼",可以不删本楼本身——但这样"本楼"就成了新的最后
  // 一楼(user身份),而现有chat接口没有"对着已经存在的最后一条user楼直接触发生成"这种调用形状,
  // 只能靠send()发message,send()一定会新起一条user楼,那就跟保留下来的这条重复了,此路不通。
  // ②(选用)inclusive:true 锚点=本楼自己,连本楼一起铰掉,让send(编辑稿)当overrideMsg重新造
  // 一条内容相同的新user楼——净效果等于"改字",只是这条楼层换了新id,而且天然复用send()的正路
  // (复用send()逻辑,不另外复制一份),跟resendOrphan同构,连composer草稿保护闸都照抄。
  // 顺序:①先PUT把编辑稿存到这楼本身(即便下面truncate马上要把这楼整条删掉,这一步是给失败路径
  // 打底——truncate/send任一步再失败,这楼在服务端仍是编辑后的新内容,不会退回编辑前的旧字,
  // 刷新/重进这扇窗都看得见,算不上丢字)②truncate这楼③交给下面的effect触发send(编辑稿)。
  async function confirmFloorEditRegen(f: Floor) {
    if (f.role !== 'user') return; // 双层闸(防御性):onFloorSaveClick已经判过role,这里再确认一遍
    const text = editDraft.trim();
    if (!text || editSaving) return;
    if (sendingRef.current) { setEditError('正在生成中,等这一楼写完再保存'); return; }
    if (mutRef.current > 0) { setEditError('有别的改动还在保存,稍等一下'); return; }
    if (boardSavingRef.current) { setEditError('状态板保存中,稍等一两秒再试'); return; }
    if (recipeSwitchingRef.current) { setEditError('配方切换中,稍等一两秒再试'); return; }
    if (!f.id || !curWindowId) { setEditError('这条还没存好,稍等再改'); return; }
    // resendOrphan同款入口闸(原样照抄判断条件,理由见resendOrphan声明处大段注释):composer里
    // 有正在写的、跟这次重生成无关的下一条草稿——整个动作直接拒绝,不PUT也不剪楼。
    if (inputRef.current.trim() && inputRef.current.trim() !== text) {
      setEditError('输入框里有未发送的草稿,先发送或清空它再保存重新生成');
      return;
    }
    const myGen = genRef.current;
    const windowId = curWindowId;
    setEditSaving(true); setEditError('');
    beginMut(); // 双向互斥:PUT+truncate这两步改楼动作在飞时不许被生成/别的改楼插一脚
    // step①:PUT保存编辑稿——失败=编辑没落地,编辑稿原样留在编辑框(editingFloorKey/editDraft
    // 不动),不继续剪楼,同confirmFloorEdit失败路径同一家法。
    try {
      const res = await fetch(`${base}/api/oc/desk/floors/${f.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '保存失败(服务端没确认成功)');
    } catch (e: any) {
      setEditError(e.message || '保存失败');
      endMut();
      if (myGen === genRef.current) setEditSaving(false);
      return;
    }
    // 之前标注过的"极端时序取舍"后来被推翻——入口闸只在函数最开头查了一次inputRef,可PUT本身是一次网络往返,这几百毫秒里
    // 完全可能才刚开始在composer打一条跟这次重生成无关的新草稿;下面写恢复槽那步不看这个,
    // 会把新草稿的localStorage镜像直接覆盖成编辑稿——input state本身没事,但刷新页面/关标签页/
    // 切窗重进这扇窗时,composer回填读的是localStorage,新草稿的持久落地这样就没了。治法:在
    // PUT成功之后、写槽之前,原样复读一遍入口闸那同一条判断——两个检查点夹住PUT这段唯一的
    // await窗口,中间再没有别的await能让新草稿在两次检查之间冒出来又溜过去。冲突时整个重新
    // 生成取消(不写槽、不truncate),编辑态原地不动(她还能接着编辑或取消),PUT那份已经落库的
    // 编辑稿不受影响(不算丢字)——两边(新草稿的持久镜像+这楼的编辑稿)都保住,只是重新生成
    // 这个动作本身要她先处理完composer里的新草稿再重试。
    if (inputRef.current.trim() && inputRef.current.trim() !== text) {
      endMut();
      if (myGen === genRef.current) {
        setEditError('重新生成已取消:输入框里出现了新草稿,为防覆盖两边都保住了——先处理输入框内容再重试');
        setEditSaving(false);
      }
      return;
    }
    // 在发truncate之前,把编辑稿写进这扇窗的
    // 持久草稿槽(oc_desk_draft_<windowId>,就是composer草稿那个槽,enterWindow进这扇窗时会读它
    // 回填输入框——见 enterWindow 最后一行 `setInput(d || '')`)。理由:truncate是一次网络往返,
    // 期间完全可能切窗/退回列表/整页离开——genRef会前进,下面"两步都成功"分支原来只在
    // myGen===genRef.current时才收尾,gen一旦前进就整段跳过,而这一步truncate其实已经在服务端
    // 把楼剪掉了(PUT那份记录也跟着没了)、pendingRegenSend没被排队、input/composer也没被碰过——
    // 编辑稿会掉进一个哪儿都没落的黑洞,永久丢字。这里的槽是最后一道兜底:不管gen怎么翻篇,只要
    // 下次回到这扇窗(enterWindow(windowId)),输入框里就有这段字。
    // 冲突自查:这里只写本窗槽(键名钉着windowId),不会碰别的窗口的草稿;
    // 原来这里"本窗槽此刻应该没有别的有效草稿"只靠函数最开头那一次入口闸撑着,PUT那段await
    // 期间冒出的新草稿会被这里的写入悄悄覆盖掉持久镜像——这个风险已经被上面紧挨着PUT成功之后
    // 补的那道复读闸堵死(两个检查点夹住PUT唯一的await窗口,中间再没有别的await能让新草稿溜过
    // 两次检查),走到这一行时inputRef.current必然是空或等于text,不会有别的草稿被覆盖。
    // 原来这里是"try{setItem}catch{}"——写失败(localStorage被禁/配额满)
    // 照样往下发truncate,安全网名存实亡,丢字路径原样复活。升级成硬前置闸:setItem之后立刻
    // getItem回读校验值真的落地了(不只是没抛异常——某些实现下setItem"成功"但实际没写进去,
    // 或配额满时静默截断),写失败/抛异常/回读值对不上,一律当写槽失败——不发truncate,editingFloorKey/
    // editDraft原样不动(编辑框还开着),PUT那份已经落库不受影响(不算丢字),mut锁立刻释放,
    // editError把原因说清楚，可在浏览器存储恢复后重新编辑重试。
    let draftSlotOk = false;
    try {
      localStorage.setItem(`oc_desk_draft_${windowId}`, text);
      draftSlotOk = localStorage.getItem(`oc_desk_draft_${windowId}`) === text;
    } catch { draftSlotOk = false; }
    if (!draftSlotOk) {
      endMut();
      if (myGen === genRef.current) {
        setEditError('本地草稿槽写入失败(浏览器存储不可用),为防丢字已取消重新生成——内容已保存到这楼，存储恢复后可重新编辑重试');
        setEditSaving(false);
      }
      return;
    }
    // step②:truncate inclusive:true,锚点=本楼自己(理由见函数头注释)。失败时PUT已经落库的
    // 编辑稿还稳稳留在这楼上,不算丢字,只是没能进入"重新生成"这一半——退出编辑态+横幅说清楚,
    // 能看见楼上已经是新内容；刷新后可重新编辑并重试自动回退重发。
    try {
      const res = await fetch(`${base}/api/oc/desk/windows/${windowId}/truncate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ floor_id: f.id, inclusive: true }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '剪不掉(服务端没确认成功)');
    } catch (e: any) {
      const msg = e.message || '这一楼剪不掉';
      endMut();
      if (myGen === genRef.current) {
        setFloors((prev) => prev.map((x) => (x.key === f.key ? { ...x, content: text } : x)));
        setEditingFloorKey(null); setEditDraft('');
        setEditSaving(false);
        setDeskError(`${msg}——编辑已经保存,但没能回退后面的楼层重新生成；内容仍留在这楼上，刷新后可重新编辑重试`);
        loadWindow(windowId, true, myGen).catch(() => {});
      }
      return;
    }
    // truncate请求本身成功了(这楼在服务端已经被剪掉)。世界代数+当前窗口双证(同下面effect
    // 那道闸同款写法):都对得上才是"还在这扇窗"的正常路径,进入"两步都成功"的收尾+排队
    // 重新生成;任一个对不上=她已经离开(切窗/退回列表/组件卸载),楼已经删了没法回退,前面
    // 写的持久草稿槽就是这里唯一的救场——尽力而为再点一条deskError横幅(若组件还挂着——只是
    // 切了别的窗/退回列表而不是整页卸载——横幅能看见;真卸载了这次setDeskError是空调用,
    // 不会报错,槽本身已经兜底,不依赖这条横幅能不能被看到)。
    if (myGen === genRef.current && windowId === curWindowIdRef.current) {
      // 本地乐观更新——这楼(inclusive:true,连锚点自己)以及它后面全部已经在服务端被整段剪掉,
      // 退出编辑态,loadWindow对账接回真值。
      setFloors((prev) => {
        const idx = prev.findIndex((x) => x.key === f.key);
        return idx < 0 ? prev : prev.slice(0, idx);
      });
      setEditingFloorKey(null); setEditDraft('');
      loadWindow(windowId, true, myGen).catch(() => {});
      // 不在这里直接调send()——理由见下面那个effect头注释(闭包时序坑),交给它接手。
      setPendingRegenSend({ text, gen: myGen, windowId });
    } else {
      setDeskError('这一楼已经剪掉、正准备重新生成,但你已经离开了这扇窗——编辑稿已经存进这扇窗的草稿槽,回到这扇窗时输入框里就能看见,手动发送即可');
    }
    endMut();
    if (myGen === genRef.current) setEditSaving(false);
  }
  // pendingRegenSend中转(任务2技术注脚,避免一个真实存在的闭包坑):PUT+truncate两步成功后,
  // 理应清空editingFloorKey退出编辑态、再调用send()重新生成——但setEditingFloorKey(null)只是
  // 排进下一次渲染的state更新,不会同步反映到"这次点击"所在渲染批次里已经捕获的send()闭包上
  // (send()内部读的editingFloorKey是它自己那次渲染定死的值,此刻依然是f.key,不是null)——
  // 同一个tick里紧接着调用send()还是会被"有楼层正在编辑中"那道闸原样拦下。editingFloorKey
  // 现有闸的判断逻辑一个字不用动(问题根本不在闸,在"调用时机"),解法是不在confirmFloorEditRegen
  // 里直接调send(),而是把要发的内容/世界代数快照存进pendingRegenSend这个state,交给这个effect
  // 在下一次真正的渲染(此时editingFloorKey state已经落成null、组件重新执行拿到的是全新一份
  // send()闭包)里再触发——两次渲染之间隔的这一拍,用户感知不到(没有额外网络往返,纯本地state
  // 流转)。世界代数(gen)+curWindowIdRef 双证:effect真正触发时若世界已经翻篇(切窗/退回列表),
  // 这条重发不该发生。
  useEffect(() => {
    if (!pendingRegenSend) return;
    if (editingFloorKey !== null) return; // 编辑态还没真正落成null(理论上下一渲染就会是),再等一拍
    const { text, gen, windowId } = pendingRegenSend;
    setPendingRegenSend(null);
    if (gen !== genRef.current || windowId !== curWindowIdRef.current) return;
    send(text).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRegenSend, editingFloorKey]);
  function onFloorEditKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>, f: Floor) {
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !isComposingKey(e)) {
      e.preventDefault();
      onFloorSaveClick(f);
    } else if (e.key === 'Escape') {
      cancelFloorEdit();
    }
  }

  // ── 版本切换器(◀ n/N ▶)──
  const [variantBusy, setVariantBusy] = useState<Record<string, boolean>>({});
  const [variantError, setVariantError] = useState('');
  async function switchVariant(f: Floor, newIndex: number) {
    if (!f.id || variantBusy[f.key] || newIndex < 0 || newIndex >= f.variantsCount) return;
    if (sendingRef.current) return; // 生成中禁切变体:同截楼一个理——正在推的楼拿着旧的活跃版本当历史
    if (mutRef.current > 0 || editingFloorKey !== null) return; // 改楼动作彼此也互斥:编辑开着/别的改楼在飞都不许切
    const myGen = genRef.current;
    const windowId = curWindowId;
    setVariantBusy((s) => ({ ...s, [f.key]: true }));
    setVariantError('');
    beginMut(); // 双向互斥
    try {
      const res = await fetch(`${base}/api/oc/desk/floors/${f.id}/variant`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ index: newIndex }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '切版本失败(服务端没确认成功)');
      if (myGen === genRef.current) {
        setFloors((prev) => prev.map((x) => (x.key === f.key ? { ...x, content: d.content, activeVariant: d.active_variant } : x)));
        if (windowId) loadWindow(windowId, true, myGen).catch(() => {}); // FIX3
      }
    } catch (e: any) {
      const msg = e.message || '切版本失败';
      setVariantError(msg);
      if (myGen === genRef.current) {
        setDeskError(msg);
        if (windowId) loadWindow(windowId, true, myGen).catch(() => {});
      }
    }
    finally { endMut(); setVariantBusy((s) => ({ ...s, [f.key]: false })); }
  }

  // ── 📖 收进章节草稿功能已整个拆除,不单独收一段原文进草稿箱——原闭环
  // (弹窗草稿/幂等身份证/独立菜单入口)不留死代码,整块删掉。

  // ── ✉️ 孤儿user楼「重发」:生成失败时 send() 若已经拿到 user_saved 但
  // AI那半截没能收尾,只会把 assistant 占位楼撤掉(见 send() 里的 else 分支)——不像"user楼都
  // 没存住"那支会把两条楼层原样撤回,这一支会在窗口尾部留一条落库了的孤零零 user 楼,没有AI
  // 回复跟着。这里补一个"重发"出口:①暂存这楼content ②inclusive:true剪掉这楼本身(复用
  // 直接调用 truncate 端点清掉孤儿楼，再把 content 原样塞进 send() 重新起跑
  // (复用send()逻辑,不另外复制一份)。互斥门禁照抄send()自己入口那一串(sendingRef/
  // editingFloorKey/mutRef/boardSavingRef/recipeSwitchingRef)——在这里先查一遍是因为剪楼这步
  // 本身也是个改楼动作,得先过这些闸才有资格动手剪;剪完调用send()时它自己也会再查一遍
  // (双层闸不算多余,send()不知道调用方是不是已经查过)。任一步失败都要把content留在输入框
  // 里,一个字不丢——剪楼这步失败靠这里手动setInput,发送那步失败靠send()自己的家法。
  async function resendOrphan(f: Floor) {
    if (!curWindowId || !f.id || sendingRef.current) return;
    if (editingFloorKey !== null) { setDeskError('有楼层正在编辑中——先点它的「保存」或「取消」,再重发'); return; }
    if (mutRef.current > 0) { setDeskError('有改动正在保存,稍等一两秒再试'); return; }
    if (boardSavingRef.current) { setDeskError('状态板保存中,稍等一两秒再试'); return; }
    if (recipeSwitchingRef.current) { setDeskError('配方切换中,稍等一两秒再试'); return; }
    const content = f.content;
    // 入口闸:composer 里如果已经有正在写的、跟这楼无关的
    // 下一条消息(非空且不等于孤儿楼内容本身)——整个重发动作直接拒绝,不剪楼也不发请求,无声守卫=
    // 以为坏了(家法),横幅把原因说清楚。composer 空的、或者装的就是这楼自己的内容(比如上一次
    // 重发失败弹回来的那份)才放行——这样从这里往下,只需要再防"truncate/send() 这两段异步窗口期
    // 里又开始打字"这一种时序,不用担心进门那一刻composer就已经有别的东西。读 inputRef 不读
    // input state(理由同 send() 里同款注释:异步操作跨好几个渲染,state闭包会过期)。
    if (inputRef.current.trim() && inputRef.current.trim() !== content.trim()) {
      setDeskError('输入框里有未发送的草稿,先发送或清空它再重发');
      return;
    }
    const windowId = curWindowId;
    const myGen = genRef.current;
    beginMut(); // 双向互斥:剪这一楼期间不许被别的改楼动作插一脚
    let truncOk = false;
    try {
      const res = await fetch(`${base}/api/oc/desk/windows/${windowId}/truncate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ floor_id: f.id, inclusive: true }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '剪不掉(服务端没确认成功)');
      truncOk = true;
      if (myGen === genRef.current) {
        setFloors((prev) => {
          const idx = prev.findIndex((x) => x.key === f.key);
          return idx < 0 ? prev : prev.slice(0, idx); // inclusive:true,连这一楼自己一起不留
        });
        loadWindow(windowId, true, myGen).catch(() => {});
      }
    } catch (e: any) {
      // 剪楼失败时这一楼本身还稳稳待在服务端(truncate没成功,压根没删掉)——不像
      // send()内部失败那样"内容已经无处可存",这里没有真正的丢字风险。composer在这趟truncate
      // 网络往返期间如果被填上了别的内容(入口闸只挡得住"一进门就有别的东西",挡不住"进门后
      // 剪楼这几百毫秒里才开始打字"),就不碰它,只报错说清楚原因+这楼还在原处;composer确实还是
      // 空的才把内容填回composer,方便她原地再点一次重发。
      if (myGen === genRef.current) {
        if (inputRef.current.trim()) {
          setDeskError((e.message || '这一楼剪不掉') + '——输入框里有别的内容没被碰,这楼还留在原处,清空输入框后可以再点一次重发');
        } else {
          setDeskError(e.message || '重发失败(这一楼剪不掉,内容原样留在输入框)');
          setInput(content); // 剪楼这步失败,composer本来就是空的:内容手动还回composer,不丢字
        }
      }
    } finally {
      endMut();
    }
    if (!truncOk || myGen !== genRef.current) return; // 世界翻篇/剪楼没成功,不继续发送
    await send(content); // 复用send()正路——它内部失败时自会按overrideMsg感知的家法处理composer(见send()注释)
  }

  // ── ⋯ 菜单:导出正文 / 立即压缩 ─────────────────────────────
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportError, setExportError] = useState('');
  const [compressing, setCompressing] = useState(false);
  // 同步镜像:双击/连点时 state 还没 commit,靠 ref 闸住第二发,同款互斥ref手法在这个文件别处也有先例。
  // 它同时是**离窗闸**——压缩是一趟 30~100 秒的模型调用,人走了回执就没人接,窗口详情也不会重拉。
  const compressingRef = useRef(false);
  const [compressNote, setCompressNote] = useState('');
  const [compressError, setCompressError] = useState('');

  // 导出:整窗正文 → markdown,**纯前端**。
  // ⚠️不开后端端点是刻意的:楼层落库的 content 是生肉——```stateboard 围栏、<meow_FM>/<enigma>/
  // <branches> 这类行级协议块、贴在文末的裸协议围栏统统都在里头。把它洗成"正文"的那套规则整个
  // 住在展示层(deskRender.ts:剥 <content> 壳 → 下行正则 → 兜底折叠 → ```html 美化卡分离),后端
  // 再写一份必然跟展示层漂移,于是"导出的东西跟屏幕上看到的对不上"。这里直接复用同一条管线,
  // 承诺是**所见即所导**。顺带一个白送的好处:协议块的识别是标签名无关的(除 FOLD_SKIP_TAGS 白名单,
  // 任何独占一行的 <xxx> 都折;文末围栏按位置折),换预设换成 <woof_radio> 也照样吃掉,不用改代码。
  //
  // 洗的顺序逐字镜像楼层渲染那段(见 floors.map 里 unwrappedContent→regexedContent→beautifySplit→
  // foldedParts→segments 那五行),只是最后把 fold 段(协议渣)和 html 段(美化卡)丢掉、只留 text 段。
  // user 楼原样导出:她自己写的字,渲染路径本来也不过美化管线(role==='user' 那支直接 return)。
  // ⚠️一个字节都不裁:她的正文里可能有刻意的缩进、代码块、首尾空行。
  // 逐段 trim 是改写稿子;**逐楼 trim 同样是改写稿子**——第一轮我把它降级成"楼级去首尾"就以为
  // 算文档级了,其实导出循环每楼调一次,等于把每一楼各裁一刀。这里只做两件事:丢掉被剥离的段
  // (协议渣/美化卡),剩下的原样保留;段与段之间补一个空行(它们中间本来就隔着被丢掉的东西,
  // 不补会粘成一段)。真正的文档级整理只有一处,在 doExport 末尾,且只碰换行不碰空格。
  function floorProse(f: Floor): string {
    if (f.role === 'user') return String(f.content || ''); // 她自己写的字,一个字节都不动
    const unwrapped = unwrapContentTagClient(f.content);
    const regexed = downTransform(f, unwrapped);
    const { body } = splitInlineThinking(regexed, false);
    const pieces = foldTransform(f, body)
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .flatMap((p) => segmentRendered(p.text))
      .filter((s): s is { type: 'text'; text: string } => s.type === 'text')
      .map((s) => s.text)
      .filter((t) => t.trim()); // 判空用 trim,留下来的原文不动
    return pieces.join('\n\n');
  }
  // 本机时区(=亚特兰大,她的浏览器就在那儿)。刻意不用 toLocaleString:各浏览器的 locale 默认格式
  // 不一样,导出的档案格式该是稳定的,不该取决于她今天用哪个浏览器打开。
  function stampOf(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function doExport() {
    setMenuOpen(false);
    setExportError('');
    // 生成期间不导:流式楼层走的是**素颜**分支(渲染那边的 isSettled 判断),
    // 半截文本喂给下行正则/兜底折叠会被误匹配、误折;更要命的是这一楼可能压根不会落库(请求失败
    // 就回滚了),导出一份"数据库里从来没存在过的内容"是最坏的一种档案。
    if (sendingRef.current) { setExportError('这一楼还在写,等它落定再导出'); return; }
    try {
      const title = win?.title || '未命名窗口';
      const now = stampOf(new Date().toISOString());
      // 只导已落库且不在流式中的楼层——口径逐字对齐渲染那边的 isSettled(!!f.id && !f.streaming)。
      const settled = floors.filter((f) => !!f.id && !f.streaming);
      const skipped = floors.length - settled.length;
      const lines: string[] = [`# 打字桌 · ${title}`, '', `> ${win?.project || ''} · 导出于 ${now} · 共 ${settled.length} 楼${skipped ? `（另有 ${skipped} 楼还没落库，未收录）` : ''}`, ''];
      for (const f of settled) {
        const prose = floorProse(f);
        if (!prose.trim()) continue; // 整楼都是协议渣/空楼:不产出一个只有抬头的空段落(判空用 trim,内容仍是原文)
        // 抬头**不带时间戳**:导出的稿子要贴进母本,靠 Ctrl+H 一键把
        // `## user` / `## Claude` 批量替换掉——抬头一旦各带各的时间就不是同一个字符串,替换不了。
        // 时间只留在文件头那一行(导出于 …),归档信息不丢,又不进入每一段的正文边界。
        lines.push(`## ${f.role === 'user' ? 'user' : 'Claude'}`, '', prose, '');
      }
      // 唯一的文档级整理:收掉文末堆积的空行,补一个换行收尾。**只匹配 \n 不匹配 \s**——
      // `\s+$` 会连最后一楼正文真实的尾随空格一起吃掉,那是内容不是排版。
      const doc = lines.join('\n').replace(/\n+$/, '') + '\n';
      const blob = new Blob([doc], { type: 'text/markdown;charset=utf-8' });
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u;
      // 文件名里的路径分隔符/保留字符会让部分浏览器静默拒绝下载,统一换成短横
      a.download = `${title.replace(/[\\/:*?"<>|]/g, '-')}-${now.slice(0, 10)}.md`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(u);
    } catch (e: any) { setExportError(e?.message || '导出失败'); }
  }

  // 立即压缩:把 cutoff 之后的旧楼强制折进时光带,只留最近 KEEP 层原文(默认口径在后端,前端不传
  // keep,免得两处各写一个数字)。用途见后端 index.ts /compress 那段注释——她的急救键。
  // 互斥:直接挂进现成的 beginMut/endMut「改楼动作」一族——send/reroll/开编辑/存编辑/切变体/剪楼
  // 六处都已经在检查 mutRef>0,借它一次性拿到双向互斥,不新发明一套闸。离窗那条另用 compressingRef
  // 拦(照 timelineSavingRef 先例,见 backToList/requestLeave)。
  async function doCompress() {
    setMenuOpen(false);
    if (!curWindowId || !win) return;
    if (compressingRef.current) return;
    // 被拦下时明说原因(无声守卫容易被当成坏了)
    if (sendingRef.current) { setCompressError('生成中,先等这一楼写完'); return; }
    if (mutRef.current > 0) { setCompressError('有改动正在保存,稍等一两秒再试'); return; }
    if (editingFloorKey !== null) { setCompressError('有楼层正在编辑中——先保存或取消'); return; }
    // 双向互斥的另一半:时光带 PUT 在飞时不许起压缩,
    // 两边写的是同一份 timeline_state。
    if (timelineSavingRef.current) { setCompressError('时光带正在保存,稍等一两秒再试'); return; }
    const windowId = curWindowId;
    const myGen = genRef.current;
    compressingRef.current = true; setCompressing(true);
    setCompressError(''); setCompressNote('');
    beginMut();
    // 自带超时闸:这趟请求同时锁着「改楼动作」族和离窗闸——万一连接
    // 半死不活地挂着不返回,她就被锁在这扇窗里,发不了新楼也走不掉,只能刷新页面。后端自己的罩是
    // 100s,这里给 130s 留出网络往返余量:正常情况永远轮不到它,它只负责保证这把锁一定会松开。
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 130_000);
    try {
      const res = await fetch(`${base}/api/oc/desk/windows/${windowId}/compress`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: ctl.signal,
      });
      const d = await res.json().catch(() => null) as any;
      if (!res.ok || !d?.success) throw new Error(d?.error || `HTTP ${res.status}`);
      if (d.acted) {
        // remaining=这次没折的层数(留白 + 超出单批上限的部分)。如实报,绝不装作压干净了——
        // 后端一批最多折 16 层,积压大时一按压不完
        // 是**正常且有意**的,必须让她知道可以再按一次(工单钉死的"no silent caps")。
        // 用后端给的 more 明示位,不自己拿 remaining 跟写死的 6 比(keep 是可变参数,硬编码
        // 会在换 keep 时报错话)。d.more===undefined 时退回不提示,不瞎猜。
        setCompressNote(`折了 ${d.folded} 层，近景还剩 ${d.remaining} 层，时光带共 ${d.segCount} 段${d.more ? '——还有积压，可以再按一次继续折' : ''}`);
      } else if (d.skip === 'nothing_to_fold' || d.skip === 'not_enough') {
        setCompressNote('近景已经很短了,没有可折的楼层');
      } else {
        setCompressNote('这次没折成(可能刚被后台折过),打开「时」看一眼');
      }
      // 时光带 rev 变了:重拉窗口详情,免得「时」面板还捧着压缩前的旧 rev 去保存(那会撞冲突提示)。
      if (myGen === genRef.current) await loadWindow(windowId, true, myGen).catch(() => {});
    } catch (e: any) {
      // 超时不等于没折成:后端可能已经折完只是回执没回来。说人话让她自己去「时」看一眼,
      // 别报一句"失败"骗她再按一次(再按一次是安全的——CAS 会挡重复,但白烧一次模型调用)。
      setCompressError(e?.name === 'AbortError'
        ? '等太久了,这次先不等了——打开「时」看一眼,可能其实已经折好了'
        : (e?.message || '压缩失败'));
    } finally {
      clearTimeout(timer);
      endMut();
      compressingRef.current = false;
      setCompressing(false);
    }
  }

  // ── 📝 导演小纸条抽屉 ──
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteDepthDraft, setNoteDepthDraft] = useState(3);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState('');
  const noteSavingRef = useRef(false);
  function toggleNoteDrawer() {
    // 世界书浮窗也得进这道互斥——不问的话,浮窗里开着
    // 没保存的行内编辑器时点小纸条,两层浮窗会同时盖着(它俩 top/z 一样),而且之后从别的路径
    // 离窗时那份草稿还是会静默没掉。跟时光带/状态板一个待遇。
    // ⚠️两道闸都只问不动手:原来这里是先 requestBoardPanelClose()(会就地丢弃状态板草稿)再问
    // 世界书,世界书一拦,小纸条没开成、状态板的草稿却已经没了。
    if ((timelineOpen || boardOpen) && !boardGate('note')) return;
    if (!loreGate('note')) return;
    if (timelineOpen || boardOpen) resetBoardState();
    resetLoreState();
    if (!noteOpen && win) { setNoteDraft(win.note || ''); setNoteDepthDraft(win.note_depth ?? 3); setNoteError(''); }
    setNoteOpen((o) => !o);
  }
  async function saveNote() {
    if (!curWindowId || noteSaving) return;
    // 互斥+生成期间锁(任务2a+任务3,照 saveBoard 同一套家法抄:查锁+占锁必须在任何await之前
    // 同步完成,读ref不读state——同一tick双击保存/保存刚起飞就send,state版闸挡不住)。
    if (noteSavingRef.current) { setNoteError('正在保存,请稍候'); return; }
    // 刻意不查 sendingRef(验收修正):生成收尾的窗口写回只动 state_board,不碰 note/note_depth,
    // 生成期间改小纸条无冲突且是合理操作(调下一轮的导演指示)——别学状态板那把锁,那把锁的
    // 理由(模型这楼末尾要写板)对小纸条不成立。重入锁+下方世界代数双证已够。
    const depth = Math.max(1, Math.min(10, Math.round(noteDepthDraft) || 3));
    // 世界代数双证(同 saveBoard 那道跨窗回写闸):PUT打的是发起这一刻的窗,落地前核对
    // 还在这扇窗、世界没翻篇,不一致就静默丢弃这份回写,不弹错(数据已经落进当初那扇窗了)。
    const savedWindowId = curWindowId;
    const myGen = genRef.current;
    noteSavingRef.current = true;
    setNoteSaving(true); setNoteError('');
    try {
      const res = await fetch(`${base}/api/oc/desk/windows/${savedWindowId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: noteDraft, note_depth: depth }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '保存失败(服务端没确认成功)');
      if (curWindowIdRef.current === savedWindowId && genRef.current === myGen) {
        setWin((w) => (w ? { ...w, note: noteDraft, note_depth: depth } : w));
        setNoteOpen(false);
      }
    } catch (e: any) {
      if (curWindowIdRef.current === savedWindowId && genRef.current === myGen) {
        setNoteError(e.message || '保存失败');
      }
    }
    finally { noteSavingRef.current = false; setNoteSaving(false); }
  }

  // ── 🎬 状态板面板(补排期工单:S4当时贴的"只读,S5才能改"标签作废,这里补上手动编辑) ──
  const [boardOpen, setBoardOpen] = useState(false);
  // 键名可编辑范围(解除"不要求改键名"的老限制):现在不管顶层键还是对象展开出
  // 来的子键,都给输入框——唯一锁死的是 STATE_BOARD_KEYS 那5个协议键(装配引擎 STATEBOARD_
  // INSTRUCTION 钉死的固定名,改了模型那边就对不上)。protocolLocked 在 boardToRows() 建行那一刻
  // 就按"这行原本的键名是不是那5个之一"算死,之后不随她怎么编辑而改变——不能用"当前键名文本"
  // 实时判断,否则她往别的键里刚好打出"位置"两个字,那一格会在她眼皮底下突然从输入框冻成label,
  // 手感很怪。isNew 这个老字段彻底退役(它原来唯一的活——"新行给输入框,旧行给label"——现在
  // 全部并进 protocolLocked 这一条判断里,两套规则打架不如合成一套)。
  //
  // rawKind/raw/touched:机器路径
  // (parseStateBoard)能落数字/布尔/null/嵌套对象/混类型数组,手动面板不能因为"没显示成好看的
  // 文本框"就把这些形状在round-trip里悄悄改写成字符串——没被碰过的行,保存时用raw原样吐回
  // (类型/结构分毫不动);只有她真的编辑过的行才落成字符串(array行照旧例外:isArray=true的
  // 那类专门按顿号/逗号切回字符串数组,这条是S4就有的老家法,F3没改这段)。
  // 四类:'string'(纯字符串,老样子)/'stringArray'(纯字符串数组,顿号联合显示,touched后按
  // 分隔符切回数组)/'object'(普通对象,新增——展开成子行编辑,见下方 BoardSubRow)/'other'
  // (数字/布尔/null/混类型数组——显示成JSON.stringify文本,配一个"原始类型"徽章提醒:这行一旦
  // 被编辑,保存后就会永久变成字符串,回不去了)。
  //
  // 'object'行怎么做到"没碰过就原样吐回,碰过也只字符串化真正被碰过的那个子键"(这次工单的
  // 铁律,展开→重建这一趟不许偷偷改类型或键序):
  //   ① row.raw 永远是这一行最初从服务端读到的那个对象原件,不会被 subRows 的任何编辑动到——
  //      subRows 只是拿来喂UI的一份平行拷贝(各自带自己的 id/raw/touched)。
  //   ② row.touched 这里的含义从"值被改了"变成"这个对象的结构有没有变"(改子键名/改子值/
  //      加子行/删子行都会把它拨成true;只有它是false,保存时才会直接用 row.raw 整个吐回,
  //      这时候连 subRows 长什么样都不重要)。
  //   ③ row.touched 一旦是true,保存时改从 subRows 逐个重建:每个子行自己也有 raw/touched——
  //      只有 sr.touched(即那个子行的"值"被编辑过)才落 sr.value 字符串,没碰值的子键(哪怕
  //      隔壁子键被改了、哪怕自己被改了名字)照样落 sr.raw,原类型不丢。子行数组本身顺序从建
  //      成到保存全程只增删不重排,所以改名不会让任何一行跳位(顶层/子行统一靠数组下标定位,
  //      react key 用生成时分配的稳定 id,不用键名文本当身份——键名文本会变,id 不会)。
  type BoardRawKind = 'string' | 'stringArray' | 'object' | 'other';
  // 子行(仅 rawKind==='object' 的行才有):value/rawKind/raw/touched 语义跟顶层的'string'/'other'
  // 两支完全对齐,只是少了'stringArray'(嵌套对象里的字符串数组线上目前没有这个形状,真出现
  // 了也按'other'兜底显示JSON文本,不做特殊识别——没必要为假设中的形状加分支)。第二层再嵌套的
  // 对象/数组不递归展开(线上数据没有第二层,先别为空中楼阁做树形编辑器),统一
  // 走 rawKind='other' 的JSON文本+徽章老路子。
  // keyTouched:键名也得有自己的"碰过没有"标记。原来保存时无条件 row.key.trim(),
  // 于是板子里原本带首尾空格的键(` foo `)——哪怕一个字没动——保存后会被静默改成 `foo`,
  // 那就是在破"没碰过就原样吐回"的铁律,只不过破在键名这一侧、验收时只盯着值那一侧看漏了。
  // 子键更容易中招:只要碰了任一个兄弟子行,整个对象走重建分支,没碰过的子键也一起被 trim。
  // 现在:没改过名的键**原样吐回,一个字符都不动**;只有真的改过名才 trim(那是她自己打的字,
  // 首尾空格几乎肯定是手滑,替她收掉是帮忙)。校验也用同一把尺子,免得标红和落库两套口径。
  type BoardSubRow = { id: string; key: string; value: string; rawKind: 'string' | 'other'; raw: any; touched: boolean; keyTouched: boolean };
  type BoardRow = {
    id: string; key: string; value: string; rawKind: BoardRawKind; raw: any; touched: boolean; keyTouched: boolean;
    protocolLocked: boolean; // 见上方大注释:这5个协议键的键名格锁死不给编辑
    subRows?: BoardSubRow[]; // 仅 rawKind==='object' 时存在
  };
  // 这一行最终会用哪个键名落库/参与校验。没改过名=原样(连空格都留),改过=trim。
  const effKey = (it: { key: string; keyTouched: boolean }): string => (it.keyTouched ? it.key.trim() : it.key);
  const [boardDraft, setBoardDraft] = useState<BoardRow[]>([]);
  const [boardDirty, setBoardDirty] = useState(false);
  const [boardSaving, setBoardSaving] = useState(false);
  // 互斥闸不能读 boardSaving/sending 这两个 state——setState 不
  // 同步落到当前闭包,同一tick双击保存/保存刚起飞就send/send先占了sendingRef但state还没来得及
  // 更新,这些窗口都会让闸形同虚设。boardSavingRef 才是"这一刻锁到底占没占"的真相,state 只管UI
  // 显示(按钮文案/disabled),两者分工别混——同 sendingRef/setSending 那对的老家法。
  const boardSavingRef = useRef(false);
  const [boardError, setBoardError] = useState('');
  const [boardArm, setBoardArm] = useState<string | null>(null);
  // 🔄 状态板刷新:按最后一楼**改过之后的**正文重算一份板,填进草稿等她确认。
  // refreshArm 是"会盖掉草稿,再点一次"的两段确认——只在草稿脏的时候才需要问;
  // boardRefreshingRef 跟 boardSavingRef 同款:互斥闸必须读 ref 不读 state(setState 不同步落到
  // 当前闭包,同一 tick 双击就穿了),state 只管按钮文案/disabled。
  const [boardRefreshing, setBoardRefreshing] = useState(false);
  const boardRefreshingRef = useRef(false);
  const [refreshArm, setRefreshArm] = useState(false);
  const refreshArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [boardRefreshNotice, setBoardRefreshNotice] = useState('');
  // 刷新令牌:世界代数只认得"换窗/离窗",认不出"同一扇窗但面板已经关了"。
  // 干净状态下点刷新→立刻关面板→响应回来照样灌进 boardDraft 并标脏,变成一份**看不见的脏草稿**
  // ——之后离窗被闸拦下,她还不知道是谁在拦。关面板/开面板/切窗都把这个号拨新,过期的响应作废。
  const boardRefreshSeqRef = useRef(0);
  // 一处清理,三个地方共用:关面板(resetBoardState)、开面板、组件卸载。确认标记不许跨面板生命周期
  // 活下来——不然"上次开着面板时问过一次"会被这次的第一下点击直接消费掉。
  function clearBoardRefreshArm() {
    if (refreshArmTimer.current) { clearTimeout(refreshArmTimer.current); refreshArmTimer.current = null; }
    setRefreshArm(false);
    setBoardRefreshNotice('');
  }
  useEffect(() => () => { if (refreshArmTimer.current) clearTimeout(refreshArmTimer.current); }, []);
  const boardCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 草稿只在开面板那一刻拍快照,生成收尾/对账会把 win.state_board 换成
  // 模型新板,草稿原地不动——这时如果点保存,整份基于旧板的草稿会把模型刚写的新板盖掉。
  // boardBaseRef 记"草稿现在基于哪份板"(JSON串,不用引用比较——引用每次 loadWindow 都换,
  // JSON串才是真正关心的"内容有没有变");boardConflict 是"基线跟当前 win.state_board 对不上,
  // 且草稿还脏"这一态的显式标记,跟 boardDirty 分开放(dirty=草稿被动过,conflict=动过的草稿
  // 撞上了别处的新写入,两个维度不能合并成一个布尔,合并了就分不清"单纯在编辑"和"编辑完发现
  // 底下地基换了"这两种情况)。
  const boardBaseRef = useRef<string>('{}');
  const [boardConflict, setBoardConflict] = useState(false);
  // 时光带是顶栏独立浮窗（排在导演小纸条之前）。rev 是后台折叠的乐观锁；保存时服务端会拒绝
  // 基于旧 rev 的草稿，避免生成收尾恰好新增一段时把手改内容静默盖来盖去。
  const [timelineOpen, setTimelineOpen] = useState(false);
  // 🌍 世界书浮窗。它和时光带/状态板同一族互斥,见 toggleLorePanel。
  const [loreOpen, setLoreOpen] = useState(false);
  // ⚠️loreOpenRef 不是冗余:离窗协议 requestLeave 挂在 useImperativeHandle(...,[])
  // 上,闭包永远停在首帧——那里读 loreOpen 这个 state 永远是 false,左廊切门/「家」链接这两条
  // 出口上的世界书保护会整个失效。同族的 boardDirtyRef/timelineDirtyRef 当初就是为这个立的。
  const loreOpenRef = useRef(false);
  useEffect(() => { loreOpenRef.current = loreOpen; }, [loreOpen]);
  // 浮窗里有没有没保存的编辑(核心记忆分块草稿 / 条目行内编辑器)。这两样原来住在文具盒里,
  // 由抽屉壳的 guardedClose 两段确认保着;抬进浮窗之后那层保护得在这里重新搭一遍,不然
  // 点关闭/去开时光带就把她填了一半的字冲了。
  const [loreDirty, setLoreDirty] = useState(false);
  const loreDirtyRef = useRef(false);
  useEffect(() => { loreDirtyRef.current = loreDirty; }, [loreDirty]);
  // 关浮窗的两段确认:有草稿时第一次点只把话说出来,3.5s 内再点一次才真关(照文具盒 discardArm
  // 同款窗口)。
  //
  // ⚠️拆成"问(loreGate)"和"动手(resetLoreState)"两半,不是洁癖:
  // 一次离窗动作上串着好几道闸(状态板 → 世界书 → 文具盒),每道背后都是一份可能没保存的草稿。
  // 如果世界书这一道**边问边关**,就会出现"世界书已经被丢弃关掉了,后面文具盒那道闸却拦下、
  // 人根本没走成"——白丢一份草稿。所以:所有闸先只问不动手,全部点头之后才真的动手。
  // 确认绑定到**具体动作**(同 boardArmRef,理由见那边):一次确认不许被别的入口顺手消费掉——
  // 脏着点「← 返回」亮起确认、人不走了回去接着编,3.5s 内点「时光带」不该被当成"她已经确认过"。
  const [loreArm, setLoreArm] = useState<string | null>(null);
  const loreArmRef = useRef<string | null>(null);
  const loreCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 只问不动手:true=这一关放行(没开着、或没脏、或这个动作已经确认过);false=拦下并亮确认。
  // 全程读 ref 不读 state,理由同 loreOpenRef 那段(requestLeave 停在首帧闭包)。
  function loreGate(action: string): boolean {
    if (!loreOpenRef.current) return true;
    if (!loreDirtyRef.current) return true;
    if (loreArmRef.current !== action) {
      loreArmRef.current = action;
      setLoreArm(action);
      if (loreCloseTimer.current) clearTimeout(loreCloseTimer.current);
      loreCloseTimer.current = setTimeout(() => { loreArmRef.current = null; setLoreArm(null); }, 3500);
      setDeskError('世界书里有没保存的编辑——再点一次就丢弃并关闭');
      return false;
    }
    return true;
  }
  // 真动手:关掉浮窗并复位。只许在所有闸都点过头之后调。
  function resetLoreState() {
    if (loreCloseTimer.current) { clearTimeout(loreCloseTimer.current); loreCloseTimer.current = null; }
    loreArmRef.current = null; setLoreArm(null);
    loreDirtyRef.current = false; setLoreDirty(false);
    loreOpenRef.current = false; setLoreOpen(false);
  }
  // 给"世界书是这一路上唯一一道闸"的入口用(浮窗自己的关闭钮):问完立刻动手,没有后手会反悔。
  function requestLoreClose(): boolean {
    if (!loreGate('close')) return false;
    resetLoreState();
    return true;
  }
  useEffect(() => () => { if (loreCloseTimer.current) clearTimeout(loreCloseTimer.current); }, []);
  // (原来这里有个 lastLoreHits:倒着找最后一楼的报告、把命中名单喂给世界书浮窗。实测后撤掉
  //  那一栏了——"可以直接点透视的",同一份信息不值得在两处排两遍。计算跟着 UI 一起拆,不留孤儿。)
  const [timelineDraft, setTimelineDraft] = useState<string[]>([]);
  const [timelineDirty, setTimelineDirty] = useState(false);
  const [timelineSaving, setTimelineSaving] = useState(false);
  const timelineSavingRef = useRef(false);
  const [timelineError, setTimelineError] = useState('');
  const timelineBaseRevRef = useRef(0);
  useEffect(() => { boardDirtyRef.current = boardDirty; }, [boardDirty]);
  useEffect(() => { timelineDirtyRef.current = timelineDirty; }, [timelineDirty]);
  useEffect(() => { boardArmRef.current = boardArm; }, [boardArm]);
  // 徽章文案用:'array'专指混类型/非纯字符串数组(纯字符串数组走 rawKind='stringArray',不算这里)
  function rawTypeLabel(v: any): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }
  // 建单个子行(仅供 boardToRows 的 object 分支调):跟顶层 rawKind='string'/'other' 那两支判断
  // 逻辑一字不差地照抄一遍——子行的"是不是字符串"跟顶层的"是不是字符串"是同一个问题,没必要
  // 另写一套。不识别 stringArray/object(任务点6:只展开一层,第二层的数组/对象一律落 'other'
  // 走JSON文本+徽章老路)。
  function objectToSubRow(k: string, v: any): BoardSubRow {
    if (typeof v === 'string') return { id: genBoardRowId(), key: k, value: v, rawKind: 'string', raw: v, touched: false, keyTouched: false };
    let text: string;
    try { text = JSON.stringify(v); } catch { text = String(v); }
    return { id: genBoardRowId(), key: k, value: text, rawKind: 'other', raw: v, touched: false, keyTouched: false };
  }
  function objectToSubRows(obj: Record<string, any>): BoardSubRow[] {
    return Object.keys(obj).map((k) => objectToSubRow(k, obj[k]));
  }
  function boardToRows(board: Record<string, any>): BoardRow[] {
    const keys = Object.keys(board);
    const shown = keys.length ? keys : STATE_BOARD_KEYS;
    return shown.map((k) => {
      const v = board[k];
      // protocolLocked 只在"建行的这一刻"按原始键名算一次,之后不随文本框里打了什么字重算——
      // 见类型声明处大注释,这是为了不让"她刚好打出一个协议键的名字"这种巧合把输入框冻成label。
      //
      // 这里有个绕过:板子里**缺**某个协议键时,把普通行改名成那个协议名,
      // 这一草稿周期内它仍可编辑(保存重开才锁上)。**明知不修,理由如下**——三条路各自的代价:
      //   ①改成按当前文本实时算 → 她手打"衣装"打到一半框子突然冻住,手感更差
      //   ②改成禁止改名成协议名   → 协议键真的缺了(新窗/被误删)她就再也补不回来了
      //   ③维持现状               → 只是这一草稿周期内少了个UI软锁,数据侧毫无风险
      // 数据侧为什么安全:协议键**已存在**时想再改一行同名,重名校验会当场标红拦住,覆盖不了;
      // 而协议键缺失时改一行补回来,正是想要的行为。所以这是个纯外观问题,①②都比它更糟。
      const protocolLocked = (STATE_BOARD_KEYS as readonly string[]).includes(k);
      if (typeof v === 'string') return { id: genBoardRowId(), key: k, value: v, rawKind: 'string', raw: v, touched: false, keyTouched: false, protocolLocked };
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        return { id: genBoardRowId(), key: k, value: v.join('、'), rawKind: 'stringArray', raw: v, touched: false, keyTouched: false, protocolLocked };
      }
      // 这次工单核心:普通对象(非null非数组)不再拿JSON裸文本糊弄——那格根本编辑
      // 不了,展开成子行。row.raw 留住原对象引用不动,子行是平行拷贝,详见类型声明处大注释③段。
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        return { id: genBoardRowId(), key: k, value: '', rawKind: 'object', raw: v, touched: false, keyTouched: false, protocolLocked, subRows: objectToSubRows(v) };
      }
      let text: string;
      try { text = JSON.stringify(v); } catch { text = String(v); }
      return { id: genBoardRowId(), key: k, value: text, rawKind: 'other', raw: v, touched: false, keyTouched: false, protocolLocked };
    });
  }
  // 重名/空名校验(任务点4+7):顶层键名跟对象展开出来的子键名复用同一套判定——两者本质是
  // 同一个问题"这一组 {key} 里有没有重复或空的名字"。传参既能喂 boardDraft 整体,也能喂某个
  // object行的 subRows,不区分层级。边打边校验(每次渲染都基于当前草稿重算,不等保存那一刻
  // 才发现——等保存时才发现的话,后一个重名会静默覆盖前一个,数据无声丢失)。
  function findBadKeyIndexes(items: { key: string; keyTouched: boolean }[]): Set<number> {
    // 用 effKey 而不是无条件 trim:标红的口径必须和落库的口径逐字一致,否则会出现
    // "界面说这两行不重名、保存后却重名"(或反过来)这种最难查的错位。
    const trimmed = items.map(effKey);
    const countMap = new Map<string, number>();
    for (const k of trimmed) if (k) countMap.set(k, (countMap.get(k) || 0) + 1);
    const bad = new Set<number>();
    trimmed.forEach((k, idx) => { if (!k || (countMap.get(k) || 0) > 1) bad.add(idx); });
    return bad;
  }
  function toggleBoardPanel() {
    if (boardOpen) { closeBoardPanel(); return; }
    // 先全问(世界书 → 时光带 → 小纸条),都点头了才动手
    if (!loreGate('board')) return;
    if (timelineOpen && !boardGate('board')) return;
    if (noteOpen) {
      const noteDirty = noteDraft !== (win?.note || '') || noteDepthDraft !== (win?.note_depth ?? 3);
      if (noteDirty) { setNoteError('先保存或取消小纸条，再打开状态板'); return; }
    }
    resetLoreState();
    if (timelineOpen) resetBoardState();
    setNoteOpen(false);
    const board = win?.state_board || {};
    setBoardDraft(boardToRows(board));
    boardBaseRef.current = JSON.stringify(board);
    boardDirtyRef.current = false; boardArmRef.current = null;
    setBoardDirty(false); setBoardError(''); setBoardArm(null); setBoardConflict(false);
    boardRefreshSeqRef.current++; // 开面板也拨一次号:上一轮在飞的刷新不许灌进这一轮的草稿
    clearBoardRefreshArm();
    setBoardOpen(true);
  }
  // 🌍 世界书浮窗:跟时光带/状态板同一族互斥——同一时刻顶栏只开一扇。
  // 开它之前照规矩问一句别的窗有没有没存的东西,不然一点「世」就把她的板/带草稿盖没了;
  // 同样是"先全问、都点头了才动手"(理由见 boardGate 那段)。
  function toggleLorePanel() {
    if (loreOpen) { requestLoreClose(); return; }
    if ((boardOpen || timelineOpen) && !boardGate('lore')) return;
    if (noteOpen) {
      const noteDirty = noteDraft !== (win?.note || '') || noteDepthDraft !== (win?.note_depth ?? 3);
      if (noteDirty) { setNoteError('先保存或取消小纸条，再打开世界书'); return; }
    }
    if (boardOpen || timelineOpen) resetBoardState();
    setNoteOpen(false);
    loreOpenRef.current = true; // ref 跟 state 一起就地拨到位:同一 tick 里的离窗协议就能读到
    setLoreOpen(true);
  }
  function toggleTimelinePanel() {
    if (timelineOpen) { closeTimelinePanel(); return; }
    // 先全问(世界书 → 状态板 → 小纸条),都点头了才动手
    if (!loreGate('timeline')) return;
    if (boardOpen && !boardGate('timeline')) return;
    if (noteOpen) {
      const noteDirty = noteDraft !== (win?.note || '') || noteDepthDraft !== (win?.note_depth ?? 3);
      if (noteDirty) { setNoteError('先保存或取消小纸条，再打开时光带'); return; }
    }
    resetLoreState();
    if (boardOpen) resetBoardState();
    setNoteOpen(false);
    const timeline = win?.timeline_state || { segs: [], cutoff: null, rev: 0 };
    setTimelineDraft(Array.isArray(timeline.segs) ? timeline.segs.map((s) => String(s.text || '')) : []);
    timelineBaseRevRef.current = Number(timeline.rev) || 0;
    timelineDirtyRef.current = false; boardArmRef.current = null;
    setTimelineDirty(false); setTimelineError(''); setBoardArm(null);
    setTimelineOpen(true);
  }
  // 「看新板(丢弃草稿)」:冲突态唯一出口——不做自动合并(宁明说不瞎猜,自己改的措辞和模型
  // 刚写的新值可能是同一个字段两种表达,机器猜不出该听谁的),按当前 win.state_board 整个重建
  // 草稿+清脏位+清冲突态+挪基线,回到"干净、跟得上现板"的起点。
  function viewNewBoard() {
    const board = win?.state_board || {};
    setBoardDraft(boardToRows(board));
    boardBaseRef.current = JSON.stringify(board);
    boardDirtyRef.current = false;
    setBoardDirty(false); setBoardError(''); setBoardConflict(false);
  }
  // 对账跟进效应:面板开着时 win.state_board 一旦跟草稿基线对不上——
  //   草稿干净 → 静默跟新(重建rows+挪基线,看到的永远是现板,不用操心);
  //   草稿脏 → 只翻冲突态的牌,不碰草稿一个字(她的输入不能被静默冲掉,即使"冲掉"的理由
  //   是"服务端有更新的数据"——那份更新数据的存在本身才是需要她知道、由她决定怎么处理的事)。
  useEffect(() => {
    if (!boardOpen || !win) return;
    const cur = JSON.stringify(win.state_board || {});
    if (cur === boardBaseRef.current) return; // 没变,跟基线一致,不用理
    if (!boardDirty) {
      setBoardDraft(boardToRows(win.state_board || {}));
      boardBaseRef.current = cur;
      setBoardConflict(false);
    } else {
      setBoardConflict(true);
    }
    // eslint 若在场:boardDirty 特意放进依赖——win 变化这一刻要读到"当时"的脏位,不能读旧闭包
  }, [win, boardOpen, boardDirty]);
  useEffect(() => {
    if (!timelineOpen || !win) return;
    const timeline = win.timeline_state || { segs: [], cutoff: null, rev: 0 };
    const rev = Number(timeline.rev) || 0;
    if (rev === timelineBaseRevRef.current) return;
    if (!timelineDirty) {
      setTimelineDraft(Array.isArray(timeline.segs) ? timeline.segs.map((s) => String(s.text || '')) : []);
      timelineBaseRevRef.current = rev;
      setTimelineError('');
    } else {
      setTimelineError('后台生成了新版时光带；请复制草稿后重新打开，避免覆盖新段落');
    }
  }, [win, timelineOpen, timelineDirty]);
  // 关面板两段确认(照 winDelStage 家法):没改动直接关,改过要点两次(3秒内第二次才生效)。
  //
  // ⚠️拆成"问(boardGate)"和"动手(resetBoardState)"两半,跟世界书那对同构。
  // 原来它是边问边关的:一次「← 返回」上串着状态板 → 世界书 → 文具盒三道闸,状态板这道要是
  // 第二次点被放行、就地把草稿丢了关了,后面文具盒那道再拦下——人根本没走成,状态板的草稿却
  // 已经没了。所以:所有闸先只问不动手,全部点头之后才动手。
  // action 参数是那次确认绑定的动作(见 boardArmRef 声明处):换个动作要重新问一次,一次确认
  // 不许被别的入口顺手消费掉。
  function boardGate(action: string): boolean {
    if (!boardDirtyRef.current && !timelineDirtyRef.current) return true;
    if (boardArmRef.current !== action) {
      boardArmRef.current = action;
      setBoardArm(action);
      if (boardCloseTimer.current) clearTimeout(boardCloseTimer.current);
      boardCloseTimer.current = setTimeout(() => {
        boardArmRef.current = null;
        setBoardArm(null);
      }, 3000);
      return false;
    }
    return true;
  }
  function resetBoardState() {
    if (boardCloseTimer.current) { clearTimeout(boardCloseTimer.current); boardCloseTimer.current = null; }
    boardArmRef.current = null; boardDirtyRef.current = false; timelineDirtyRef.current = false;
    setBoardArm(null); setBoardDirty(false); setTimelineDirty(false); setBoardError(''); setTimelineError('');
    setBoardOpen(false); setTimelineOpen(false);
    // 刷新那套跟着一起收:①确认标记不许跨面板生命周期活下来 ②在飞的刷新响应
    // 作废——否则它回来会往一块已经关掉的面板里灌草稿+标脏,变成看不见的脏位。
    boardRefreshSeqRef.current++;
    clearBoardRefreshArm();
  }
  // 给"状态板/时光带是这一路唯一一道闸"的入口用(两块面板自己的关闭钮)
  function requestBoardPanelClose(action = 'close'): boolean {
    if (!boardGate(action)) return false;
    resetBoardState();
    return true;
  }
  function closeBoardPanel() { requestBoardPanelClose('close'); }
  function closeTimelinePanel() { requestBoardPanelClose('close'); }
  async function saveTimeline() {
    if (!curWindowId || !win) return;
    if (timelineSavingRef.current) { setTimelineError('正在保存,请稍候'); return; }
    if (sendingRef.current) { setTimelineError('生成中,时光带锁定'); return; }
    // 双向互斥:压缩和这里写的是**同一份 timeline_state**。压缩那趟要跑
    // 30~100 秒,期间她完全来得及在面板里改完点保存;两边各自捧着压缩前的旧 rev,后端 CAS 会让其中
    // 一条报冲突——那是"操作白做一次"的体验,不该靠冲突提示兜。改楼动作(mutRef)同理要拦:楼层
    // 编辑/剪楼会经前栅栏裁掉时光带段落,拿旧草稿保存必然撞冲突。两道都放在任何 await 之前。
    if (compressingRef.current) { setTimelineError('正在压缩时光带,等它折完再存(约半分钟)'); return; }
    if (mutRef.current > 0) { setTimelineError('有楼层改动正在保存,稍等一两秒再存'); return; }
    if (timelineDraft.some((s) => !s.trim())) { setTimelineError('时光带段落不能为空'); return; }
    const savedWindowId = curWindowId;
    const myGen = genRef.current;
    timelineSavingRef.current = true; setTimelineSaving(true); setTimelineError('');
    try {
      const res = await fetch(`${base}/api/oc/desk/windows/${savedWindowId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeline_texts: timelineDraft, timeline_rev: timelineBaseRevRef.current }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || `HTTP ${res.status}`);
      if (curWindowIdRef.current === savedWindowId && genRef.current === myGen) {
        setWin((w) => (w ? { ...w, timeline_state: d.state } : w));
        timelineBaseRevRef.current = Number(d.state?.rev) || timelineBaseRevRef.current + 1;
        setTimelineDraft(Array.isArray(d.state?.segs) ? d.state.segs.map((s: any) => String(s.text || '')) : timelineDraft);
        timelineDirtyRef.current = false;
        setTimelineDirty(false);
      }
    } catch (e: any) {
      if (curWindowIdRef.current === savedWindowId && genRef.current === myGen) setTimelineError(e.message || '保存失败');
    } finally {
      timelineSavingRef.current = false; setTimelineSaving(false);
    }
  }
  function updateBoardRowValue(i: number, value: string) {
    // onChange 只在文本真的变了才触发,所以 touched=true 精确对应"动过这一行"——
    // 没点进去/点了没改字的行不会被误标,保存时仍走 raw 原样吐回那条分支。
    // (rawKind==='object' 的行没有这个函数的调用点——它没有顶层value输入框,值全在subRows里。)
    setBoardDraft((rows) => rows.map((r, idx) => (idx === i ? { ...r, value, touched: true } : r)));
    setBoardDirty(true);
  }
  function updateBoardRowKey(i: number, key: string) {
    // 改键名不置 touched:这里的 touched 管的是"值要不要被字符串化",键名是独立维度——保存时
    // 直接读 row.key(此刻的新名字)去装 board[k],跟 row.raw/touched 那条判断完全不冲突,
    // 所以重命名从来不需要额外动 touched,也就不会误伤"没碰过就原样吐回"这条铁律。
    setBoardDraft((rows) => rows.map((r, idx) => (idx === i ? { ...r, key, keyTouched: true } : r)));
    setBoardDirty(true);
  }
  function addBoardRow() {
    // 新行没有"原样"可言,直接当已touched的纯字符串处理
    setBoardDraft((rows) => [...rows, { id: genBoardRowId(), key: '', value: '', rawKind: 'string', raw: '', touched: true, keyTouched: true, protocolLocked: false }]);
    setBoardDirty(true);
  }
  function removeBoardRow(i: number) {
    // 单键小×直接从草稿摘掉,不用两段——"保存"之前这一切都只是草稿,真正落库的动作只有保存本身
    setBoardDraft((rows) => rows.filter((_, idx) => idx !== i));
    setBoardDirty(true);
  }
  // ── object行的子行操作(任务点1-6):四个函数分工跟顶层 updateBoardRowValue/Key/add/removeBoardRow
  // 严格对应,多一件事——每次子行结构变化都要把外层 row.touched 一并拨成 true(见类型声明处大
  // 注释②③段:row.touched 对 object 行的语义是"结构变没变",不拨的话保存时会误走"没碰过"分支,
  // 把她刚改的子行原样吐回去当没发生过)。rowIndex 用来定位是哪个顶层object行,subIndex 定位
  // 是它下面第几个子行,两层下标而不是嵌套查id,道理跟顶层一致——数组顺序全程只增删不重排,
  // 下标天然稳定,不需要额外一层id查找。
  // 🔄 按最后一楼(改过之后的)正文重算状态板。后端只回不写(见 chat/deskBoardRefresh.ts 头注释),
  // 这里把回来的板灌进草稿并标脏——落库仍然是她点「保存状态板」那一下。
  async function refreshBoard() {
    if (!curWindowId) return;
    // 互斥读 ref 不读 state(同 saveBoard 那道闸的理由,见 boardSavingRef 声明处注释)
    if (boardRefreshingRef.current) return;
    if (boardSavingRef.current) { setBoardError('状态板保存中,稍等一两秒再刷新'); return; }
    if (sendingRef.current) { setBoardError('生成中,状态板锁定——这楼模型自己末尾要写板,两边会打架'); return; }
    // 有没保存的草稿就先问一句:刷新会整份盖掉她手上的改动
    if (boardDirtyRef.current && !refreshArm) {
      setRefreshArm(true);
      if (refreshArmTimer.current) clearTimeout(refreshArmTimer.current);
      refreshArmTimer.current = setTimeout(() => setRefreshArm(false), 3500);
      return;
    }
    if (refreshArmTimer.current) { clearTimeout(refreshArmTimer.current); refreshArmTimer.current = null; }
    setRefreshArm(false);

    const savedWindowId = curWindowId;
    const myGen = genRef.current;
    const myTok = ++boardRefreshSeqRef.current;
    boardRefreshingRef.current = true;
    setBoardRefreshing(true); setBoardError(''); setBoardRefreshNotice('');
    try {
      const res = await fetch(`${base}/api/oc/desk/windows/${savedWindowId}/board-refresh`, { method: 'POST' });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '重算失败(服务端没确认成功)');
      const nextBoard = d.board;
      if (!nextBoard || typeof nextBoard !== 'object' || Array.isArray(nextBoard)) {
        throw new Error('重算回来的不是一块板,没敢填进去');
      }
      // 三道落地闸,少一道都会往不该去的地方灌草稿:
      // ①世界代数双证(同 saveBoard 那道跨窗闸):这一趟飞了好几秒,她完全可能已经切窗/离窗。
      // ②刷新令牌:认得出"同一扇窗但面板已经关了/又重开了"——世界代数管不到这一层。
      // ③楼层对账:这份板是照 d.floor_id 那一楼算的。刷新在飞的时候她要是又发了一楼,
      //   模型这楼末尾自己会写一份新板,而手上这份是照**上一楼**算的旧账——灌进去等于拿旧的
      //   盖新的。宁可这次白刷,让她重按一下。
      if (curWindowIdRef.current !== savedWindowId || genRef.current !== myGen) return;
      if (myTok !== boardRefreshSeqRef.current) return;
      // ⚠️严格相等,不许拿 `lastFloor.id &&` 把 undefined 放过去:没有 id = 这一楼还在
      // 流式生成、没落库——那**恰恰是**必须作废的冲突态,不是"没法判断所以放行"。能当刷新基准的
      // 楼层本来就该有 id;没有 id 就证明不了它还是后端算这份板时依据的那一楼。
      const lastFloor = floorsRef.current[floorsRef.current.length - 1];
      if (!lastFloor || lastFloor.id !== d.floor_id) {
        setBoardRefreshNotice('刷的这会儿楼层变了,这份是照旧的那楼算的,已经丢掉——再按一次');
        return;
      }
      setBoardDraft(boardToRows(nextBoard));
      // ⚠️基线**不动**:boardBaseRef 记的是"这份草稿基于哪版已落库的板",而这次重算一个字都没落库。
      // 动了它会让冲突检测把"模型后来又写了新板"这件事看漏。
      boardDirtyRef.current = true;
      setBoardDirty(true);
      setBoardRefreshNotice('已按最后一楼的正文重算,看一眼没问题再点保存');
    } catch (e: any) {
      // 失败分支也要过同样三道闸:否则"点刷新→关面板→重开→旧请求超时回来"会把
      // 上一轮的错误写进新面板,她一脸问号。静默丢弃就好,那一轮已经不属于现在这块面板了。
      if (curWindowIdRef.current !== savedWindowId || genRef.current !== myGen) return;
      if (myTok !== boardRefreshSeqRef.current) return;
      setBoardError(e.message || '重算失败');
    } finally {
      // finally 不看令牌:顶上那道 `if (boardRefreshingRef.current) return` 是同步占锁的,
      // 同一时刻只可能有一趟刷新在飞——所以走到这里的这一趟必然就是锁的主人,该它释放。
      // 反过来若在这儿加令牌判断,楼层一动(令牌被拨新)就没人放锁了,按钮会永久变灰。
      boardRefreshingRef.current = false;
      setBoardRefreshing(false);
    }
  }

  function updateBoardSubRowValue(rowIndex: number, subIndex: number, value: string) {
    setBoardDraft((rows) => rows.map((r, ri) => {
      if (ri !== rowIndex || !r.subRows) return r;
      const subRows = r.subRows.map((sr, si) => (si === subIndex ? { ...sr, value, touched: true } : sr));
      return { ...r, subRows, touched: true };
    }));
    setBoardDirty(true);
  }
  function updateBoardSubRowKey(rowIndex: number, subIndex: number, key: string) {
    // 子行改名一样不碰 sr.touched(同顶层 updateBoardRowKey 的道理:名字和值是独立维度),
    // 但要拨外层 row.touched=true——改名=删旧键+加新键,保存时这个对象必须走"从subRows重建"
    // 分支才能让新名字生效,不能再直接吐 row.raw(那样等于假装改名没发生过)。
    setBoardDraft((rows) => rows.map((r, ri) => {
      if (ri !== rowIndex || !r.subRows) return r;
      const subRows = r.subRows.map((sr, si) => (si === subIndex ? { ...sr, key, keyTouched: true } : sr));
      return { ...r, subRows, touched: true };
    }));
    setBoardDirty(true);
  }
  function addBoardSubRow(rowIndex: number) {
    setBoardDraft((rows) => rows.map((r, ri) => {
      if (ri !== rowIndex || !r.subRows) return r;
      const newSub: BoardSubRow = { id: genBoardRowId(), key: '', value: '', rawKind: 'string', raw: '', touched: true, keyTouched: true };
      return { ...r, subRows: [...r.subRows, newSub], touched: true };
    }));
    setBoardDirty(true);
  }
  function removeBoardSubRow(rowIndex: number, subIndex: number) {
    setBoardDraft((rows) => rows.map((r, ri) => {
      if (ri !== rowIndex || !r.subRows) return r;
      return { ...r, subRows: r.subRows.filter((_, si) => si !== subIndex), touched: true };
    }));
    setBoardDirty(true);
  }
  // 子行删除双确认(家法照 onWinDeleteClick 抄:按id各开一档stage+一份计时器,3秒内点第二次
  // 才真删)。子行id全局唯一(见genBoardRowId),不同object行的子行也不会互相撞档。
  const [boardSubDelStage, setBoardSubDelStage] = useState<Record<string, 0 | 1>>({});
  const boardSubDelTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  function onBoardSubDeleteClick(rowIndex: number, subIndex: number, subId: string) {
    const stage = boardSubDelStage[subId] || 0;
    if (stage === 0) {
      setBoardSubDelStage((s) => ({ ...s, [subId]: 1 }));
      if (boardSubDelTimers.current[subId]) clearTimeout(boardSubDelTimers.current[subId]);
      // 超时撤防时顺手把这条从表里删掉:只 clearTimeout 不 delete 的话,
      // 反复开面板、武装一堆子行删除,这张 ref 表会一直攒着历史 id 不释放。
      boardSubDelTimers.current[subId] = setTimeout(() => {
        delete boardSubDelTimers.current[subId];
        setBoardSubDelStage((s) => ({ ...s, [subId]: 0 }));
      }, 3000);
      return;
    }
    if (boardSubDelTimers.current[subId]) { clearTimeout(boardSubDelTimers.current[subId]); delete boardSubDelTimers.current[subId]; }
    setBoardSubDelStage((s) => ({ ...s, [subId]: 0 }));
    removeBoardSubRow(rowIndex, subIndex);
  }
  // 卸载兜底:走到这儿说明整个打字桌都没了,还在飞的撤防计时器没有任何意义,全清掉。
  useEffect(() => () => {
    for (const t of Object.values(boardSubDelTimers.current)) clearTimeout(t);
    boardSubDelTimers.current = {};
  }, []);
  async function saveBoard() {
    // handler双层闸(UI已经用disabled挡住,这里补一道):冲突态下"保存"钮本该是disabled的,
    // 万一有漏网点击(比如键盘触发/双击间隙),这道闸兜底拒绝——冲突态唯一合法出口是 viewNewBoard。
    if (!curWindowId || boardConflict) return;
    // 互斥闸同抽屉爪那族修法,读ref不读state:setState 不同步落到当前闭包——同一tick
    // 双击保存、保存刚起飞就点发送、发送先同步置了sendingRef但state还没来得及re-render,这些窗口
    // 靠 boardSaving/sending 两个state都挡不住。查锁+占锁必须在任何await/fetch之前同步完成
    // (JS单线程,这几行之间没有yield点,不会被另一次调用插队);state(setBoardSaving)只管UI显示
    // (按钮文案/disabled),不参与互斥判断。
    if (boardSavingRef.current) { setBoardError('正在保存,请稍候'); return; }
    if (sendingRef.current) { setBoardError('生成中,状态板锁定'); return; }
    // PUT打的是这一刻的窗——捕获住,fetch落地时窗口可能已经切了(
    // 点了「← 窗口」切进另一扇窗,新窗加载先完成,这份旧响应才姗姗来迟)。世界代数双证:窗口id
    // (走 curWindowIdRef,理由见它声明处的注释——state闭包在await之后读到的是发起时的旧快照,
    // 不是活的)+ genRef(切窗/返回列表都会++,顺手再验一层,两把尺子任一对不上就不是当初那个世界)。
    const savedWindowId = curWindowId;
    const myGen = genRef.current;
    boardSavingRef.current = true;
    setBoardSaving(true); setBoardError('');
    try {
      // ⚠️用 entries 数组收集、最后 Object.fromEntries 组装,**绝不**往 {} 上直接 obj[k]= 写
      // :键名是用户/模型可控的字符串,一旦出现 `__proto__`,`obj['__proto__']=v`
      // 不会建出自有属性,而是去触发原型 setter——那一键会**静默消失**(JSON.stringify 之后就没了),
      // 还可能顺手污染临时对象的原型。Object.fromEntries 走的是"建自有属性"的语义,`__proto__`
      // 会老老实实变成一个普通的键。这一条对"没碰过就原样吐回"同样致命:那一键根本没被人动过,
      // 却在 round-trip 里蒸发了。
      const seen = new Set<string>();
      const entries: [string, any][] = [];
      for (const row of boardDraft) {
        const k = effKey(row); // 没改过名=原样(空格都留),改过才trim,见 effKey 声明处注释
        if (!k) { setBoardError('有一行键名是空的,填上或者点掉它'); return; }
        if (seen.has(k)) { setBoardError(`键名重复了:${k}`); return; }
        seen.add(k);
        if (row.rawKind === 'object') {
          if (!row.touched) {
            entries.push([k, row.raw]); // 一个子行都没碰过——整个对象原样吐回,连键序都不动(任务铁律)
            continue;
          }
          // 碰过至少一个子行:从 subRows 逐个重建,但没被碰过的子键各自照样走 sr.raw(原类型
          // 不丢)——只有真正编辑过值的子键才字符串化,跟顶层"碰过才变字符串"是同一条家法。
          const subSeen = new Set<string>();
          const subEntries: [string, any][] = [];
          for (const sr of row.subRows || []) {
            const sk = effKey(sr);
            if (!sk) { setBoardError(`「${k}」里有一行键名是空的,填上或者点掉它`); return; }
            if (subSeen.has(sk)) { setBoardError(`「${k}」里键名重复了:${sk}`); return; }
            subSeen.add(sk);
            subEntries.push([sk, sr.touched ? sr.value : sr.raw]);
          }
          entries.push([k, Object.fromEntries(subEntries)]);
        } else if (!row.touched) {
          entries.push([k, row.raw]); // 没碰过——原样吐回,数字还是数字,嵌套还是嵌套,round-trip不脏手
        } else if (row.rawKind === 'stringArray') {
          entries.push([k, row.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)]);
        } else {
          entries.push([k, row.value]); // 碰过就落字符串('string'和'other'碰过统一变文字,F3工单原话)
        }
      }
      const board: Record<string, any> = Object.fromEntries(entries);
      const res = await fetch(`${base}/api/oc/desk/windows/${savedWindowId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state_board: board }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '保存失败(服务端没确认成功)');
      // 落库本身没问题(打的就是 savedWindowId,服务端落的是对的窗)——唯一有害的是接下来这几行
      // 前端回写:它们改的是"当前正显示的窗"的状态,如果已经切走了,这份回写就会把新窗的画面
      // 换成旧窗的板,制造跨窗数据污染。校验不通过就静默丢弃回写——不是无声故障:数据已经正确
      // 落在旧窗服务端了,下次翻回旧窗,canonical loadWindow 自然会把这份新板读回来,不需要
      // 这次逃逸的回写替它办这件事;而当前(新)窗口的画面也因为没被误写而保持干净。
      if (curWindowIdRef.current === savedWindowId && genRef.current === myGen) {
        setWin((w) => (w ? { ...w, state_board: board } : w));
        boardBaseRef.current = JSON.stringify(board); // 存成功=新基线,跟着落库的这份走
        boardDirtyRef.current = false; boardArmRef.current = null;
        setBoardDirty(false); setBoardArm(null);
        // 存完不许自动关面板。原来存成功就 setBoardOpen(false) 把整块收掉,
        // 她连着改好几行时每存一次就得重开一次。存完留在原地(草稿标记已清、基线已换),
        // 想关自己点「关闭」。timelineDirty 那条判断随之作废——本来就是为"关不关"服务的。
        setBoardError('');
      }
    } catch (e: any) {
      // 失败横幅也要过同一道双闸:boardError是组件级共享状态,旧窗的请求失败若无条件
      // 写横幅,会在已经切进的新窗面板上冒出"保存失败"——错误归属串窗,比不报还误导。校验
      // 不过就静默丢弃:那是旧窗的事,与眼前这扇窗无关。
      if (curWindowIdRef.current === savedWindowId && genRef.current === myGen) {
        setBoardError(e.message || '保存失败');
      }
    }
    finally { boardSavingRef.current = false; setBoardSaving(false); } // 持锁方释放:ref先解,state再同步(UI跟着解锁)
  }

  // ── 🔍 每楼剧本透视折叠 ──
  const [reportOpenKeys, setReportOpenKeys] = useState<Set<string>>(new Set());
  function toggleReport(key: string) {
    setReportOpenKeys((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }

  // ── 窗口级「透视下一楼」:拿 composer 里当前写的字裸跑一次 dryrun,不真的发出去 ──
  const [dryrunOpen, setDryrunOpen] = useState(false);
  const [dryrunLoading, setDryrunLoading] = useState(false);
  const [dryrunError, setDryrunError] = useState('');
  const [dryrunReport, setDryrunReport] = useState<FloorReport | null>(null);
  // 请求令牌(任务2b,同族收口):照 switchSeqRef 家法抄,捕获发起时的窗口id——落地前双验
  // "令牌新鲜 && 还在这扇窗",防切窗后旧透视报告糊到composer上。
  const dryrunSeqRef = useRef(0);
  async function doDryrun() {
    if (!curWindowId || !win) return;
    if (dryrunLoading) return; // 重入闸:上一趟还没回来,不再触发新的一趟
    const text = input.trim();
    const savedWindowId = curWindowId;
    const tok = ++dryrunSeqRef.current;
    setDryrunOpen(true); setDryrunReport(null); setDryrunError('');
    if (!text) { setDryrunError('composer 里先写点什么,再来透视~'); return; }
    setDryrunLoading(true);
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const body = {
        project: win.project, recipe_id: win.recipe_id, input: text,
        floors: floors.slice(-12).map((f) => ({ role: f.role, content: f.content })),
        note: win.note, note_depth: win.note_depth,
        state_board: win.state_board, vars: win.vars,
      };
      const res = await fetch(`${base}/api/oc/desk/dryrun`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '装配失败');
      if (tok !== dryrunSeqRef.current || curWindowIdRef.current !== savedWindowId) return; // 令牌过期或已经切窗,这份旧透视报告不许糊到新窗composer上
      setDryrunReport(d.report || null);
    } catch (e: any) {
      if (tok !== dryrunSeqRef.current || curWindowIdRef.current !== savedWindowId) return;
      setDryrunError(e.message || '透视失败');
    } finally {
      if (tok === dryrunSeqRef.current && curWindowIdRef.current === savedWindowId) setDryrunLoading(false);
    }
  }

  // ══════════════════════════ 渲染:写作屏(全屏,Tailwind,同编辑部皮) ══════════════════════════
  if (mode === 'write') {
    const lastAssistantKey = (() => {
      for (let i = floors.length - 1; i >= 0; i--) if (floors[i].role === 'assistant') return floors[i].key;
      return null;
    })();

    // 布局改造:写作屏从"整页早退接管(min-h-screen,body 自己滚)"改成"stage 里的
    // 全高子应用"——h-full 撑满 stage、overflow-hidden 兜住自己;头尾栏改 flex-none(不再需要
    // sticky——现在只有下面 <main> 自己滚,头尾栏本来就不在那段滚动区里,天然不动,不用靠sticky
    // 硬粘)。HeatBg 交给 page.tsx 那一份画,这里不重复画(两层纱罩叠加会变暗)。
    return (
      <div className="relative h-full flex flex-col bg-page text-ink-body overflow-hidden">
        {/* 头栏 z-8(< 侧栏本体z-9,> 背板z-7)——原来这里是 sticky 年代留下的 z-10,
            比侧栏本体(当时z-8)还高,侧栏打开时头栏会盖住侧栏顶端(关闭钮/本窗设置区点不到)。
            归位到统一定序,见 DeskDrawers.tsx 侧栏本体 zIndex 声明处注释。 */}
        <header ref={headerRef} className="flex-none z-[8] bg-page/85 backdrop-blur border-b border-line-soft px-6 py-3 max-[760px]:px-3.5 max-[760px]:pt-3 max-[760px]:pb-[11px]">
          <div className="max-w-2xl mx-auto flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 min-w-0">
              <button onClick={backToList} className="serc pill inline-flex items-center gap-2 text-sm text-ink-body bg-card border border-line-soft px-4 py-1.5 rounded-full whitespace-nowrap">← 返回</button>
              <div className="min-w-0">
                <div className="serc text-lg text-ink-deep truncate">{win?.title || (winLoadLoading ? '…' : '未命名窗口')}</div>
                {win && <div className="ser text-[11px] text-ink2 truncate">{win.project}</div>}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-none">
              {/* 顶栏瘦身:配方下拉/模型下拉已搬进文具盒顶部「本窗设置」区
                  (windowSettings prop 传给下面的 DeskDrawerHub,逻辑一字不改只搬家——switchRecipe/
                  recipeSwitchingRef 那整套互斥+model state 原地留在这个组件里,只是渲染搬走了)。

                  动线重构第一批:顶栏统一成四颗单字钮 + 一道竖线——
                      [文] [世] │ [时] [态]
                  左边两颗是**项目级**(改了影响这个 project 的所有窗),右边两颗是**本窗级**(只影响这一扇)。
                  那道竖线是这次改动里唯一真要传达的信息,比"少一颗按钮"有用得多,所以它是画出来的实线不是留白。
                  单字风格照左廊「架/写/读/谈」,不用 emoji(顺带治了 案2 那个 emoji 渲成灰线稿的老毛病)。
                  「世」= 世界书:第二批才有独立浮窗,这一期先让它直接把文具盒开在世界书那一页
                  (initialTab='lore')——同一个抽屉两个入口,但省掉"文具盒→找世界书"那一跳。
                  📝小纸条已挪到输入框左边(它是"给下一楼的临时指令",跟发送是一件事,不是设置)。*/}
              <button
                onClick={() => setWriteDrawerOpen(true)}
                title="文具盒：本窗设置·积木/配方·正则·核心记忆·导入"
                className="serc inline-flex items-center justify-center shrink-0 cursor-pointer hover:brightness-[.97] transition w-[38px] h-[38px] rounded-xl bg-card border border-line-soft text-sm text-ink-body"
              >
                文
              </button>
              <button
                onClick={toggleLorePanel}
                title="世界书：核心记忆 + 设定/大纲/角色卡·触发关键词"
                className="serc inline-flex items-center justify-center shrink-0 cursor-pointer hover:brightness-[.97] transition w-[38px] h-[38px] rounded-xl bg-card border border-line-soft text-sm text-ink-body"
              >
                世
              </button>
              {/* 项目级 │ 本窗级 的分界线 */}
              <span aria-hidden className="self-stretch w-px my-[3px] bg-line-soft shrink-0" />
              <button
                onClick={toggleTimelinePanel}
                title="时光带（本窗）"
                className="serc inline-flex items-center justify-center shrink-0 cursor-pointer hover:brightness-[.97] transition w-[38px] h-[38px] rounded-xl bg-card border border-line-soft text-sm text-ink-body"
              >
                时
              </button>
              <button
                onClick={toggleBoardPanel}
                title="状态板（本窗）"
                className="serc inline-flex items-center justify-center shrink-0 cursor-pointer hover:brightness-[.97] transition w-[38px] h-[38px] rounded-xl bg-card border border-line-soft text-sm text-ink-body"
              >
                态
              </button>
              {/* ⋯ 菜单(导出正文/立即压缩)。这两个都是"偶尔用一次"的整窗动作,不配占一颗
                  常驻单字钮——顶栏那四颗是每天要按的([文][世]│[时][态]),挤进去会稀释那道竖线
                  想表达的"项目级 vs 本窗级"分组。菜单结构照客厅/编辑部同款(透明背板兜点击关闭)。 */}
              <div className="relative shrink-0">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  title="更多：导出正文 / 立即压缩"
                  className="serc inline-flex items-center justify-center shrink-0 cursor-pointer hover:brightness-[.97] transition w-[38px] h-[38px] rounded-xl bg-card border border-line-soft text-sm text-ink-body"
                >
                  ⋯
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 mt-2 w-52 bg-card border border-line-soft rounded-2xl shadow-lg p-1.5 z-20 text-sm">
                      <button
                        onClick={doExport}
                        disabled={sending}
                        className="serc w-full text-left flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-page text-ink-body disabled:opacity-40"
                      >
                        ↓ 导出正文
                      </button>
                      {/* disabled 跟 doCompress 里的闸口径一致——
                          时光带保存在飞时这颗就是灰的,她不用点一下才知道现在不行。 */}
                      <button
                        onClick={doCompress}
                        disabled={compressing || timelineSaving || sending}
                        className="serc w-full text-left flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-page text-ink-body disabled:opacity-40"
                      >
                        {compressing ? '🌀 压缩中…' : '🌀 立即压缩'}
                      </button>
                      <div className="px-3 pt-1 pb-1.5 text-[11px] text-ink2 leading-snug">
                        把旧楼折进时光带，只留最近 6 层原文；楼层一条不删
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        <main onScroll={onScrollerScroll} className="relative z-[1] flex-1 overflow-y-auto px-6 py-8 max-[760px]:px-4">
          <div className="max-w-2xl mx-auto space-y-5">
            {winDelError && <div className="text-sm text-center" style={{ color: '#c2693f' }}>{winDelError}</div>}
            {/* 下行正则规则表拉取失败的一行淡提示——降级为无操作,不拦楼层照常读写(工单点2) */}
            {downRulesNotice && <div className="text-[11.5px] text-center text-ink2">{downRulesNotice}</div>}
            {/* ⋯ 菜单的回执位。压缩是同步等 30~100 秒的动作,菜单点完就关了,在飞态必须在
                主区可见——不然她只会看到"点了没反应"然后再点一次(第二发被 compressingRef 闸住,
                但那更像坏了)。回执/报错各占一行,压缩期间先不显示上一轮的回执免得读串。 */}
            {compressing && <div className="text-[11.5px] text-center text-ink2">🌀 正在把旧楼折进时光带…（要跑一趟模型，约半分钟，这期间先别发新楼）</div>}
            {!compressing && compressNote && <div className="text-[11.5px] text-center text-ink2">{compressNote}</div>}
            {compressError && <div className="text-sm text-center" style={{ color: '#c2693f' }}>压缩没成：{compressError}</div>}
            {exportError && <div className="text-sm text-center" style={{ color: '#c2693f' }}>导出没成：{exportError}</div>}
            {winLoadLoading && <div className="text-ink2 text-sm text-center">推开这扇窗…</div>}
            {winLoadError && <div className="text-sm text-center" style={{ color: '#c2693f' }}>翻不开：{winLoadError}</div>}
            {!winLoadLoading && !winLoadError && floors.length === 0 && (
              <div className="text-ink2 text-sm text-center py-10">这扇窗还空着～写下第一段吧</div>
            )}

            {floors.map((f, floorIndex) => {
              if (f.role === 'user') {
                return (
                  <div key={f.key} className="flex flex-col items-end gap-1.5">
                    {editingFloorKey === f.key ? (
                      <div className="w-[85%] space-y-2">
                        <textarea
                          value={editDraft} ref={editTextareaRef}
                          onInput={(e) => grow(e.currentTarget, (e.nativeEvent as InputEvent).isComposing === true)}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => onFloorEditKeyDown(e, f)}
                          className="w-full resize-none rounded-[20px] border border-dashed border-dash-line bg-card px-4 py-2.5 text-ink-deep leading-relaxed focus:outline-none"
                        />
                        <div className="flex items-center justify-end gap-3">
                          {editError && <span className="text-[11.5px]" style={{ color: '#c2693f' }}>{editError}</span>}
                          <button onClick={cancelFloorEdit} disabled={editSaving} className="text-xs text-ink2 hover:text-ink-body">取消</button>
                          {/* 任务2:user楼(非最后一楼)点这里先过二段确认,文案里的N实时算——见floorSaveLabel/onFloorSaveClick */}
                          <button onClick={() => onFloorSaveClick(f)} disabled={editSaving || sending || !editDraft.trim()} className="rounded-xl bg-accent hover:brightness-105 text-white text-xs px-4 py-1.5 disabled:opacity-40">
                            {floorSaveLabel(f)}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="max-w-[80%] max-[760px]:max-w-[86%] rounded-[20px] rounded-br-[6px] bg-scale-1 text-ink-deep px-[18px] py-3.5 whitespace-pre-wrap leading-relaxed">
                          {f.content}
                        </div>
                        <FloorActionRow
                          f={f} floorNo={floorIndex + 1} sending={sending} mutBusy={mutCount > 0 || editingFloorKey !== null}
                          onEdit={startFloorEdit} onCopy={(t) => navigator.clipboard?.writeText(t)} onToggleReport={toggleReport}
                          // 任务5:只有"这楼是floors数组里字面上的最后一楼"才传onResend——那正是
                          // "孤儿user楼"的定义(后面没有跟着的assistant楼了),非最后一楼的user楼
                          // 天然不传,不显示重发钮。
                          onResend={f.key === floors[floors.length - 1]?.key ? resendOrphan : undefined}
                        />
                      </>
                    )}
                  </div>
                );
              }

              // 下行(美化)正则管道只跑在"落库settled、非流式中"的 assistant 楼层——当场流式楼
              // (f.streaming,含 send 新占位楼、以及"客厅手感"改造后共用同一条画面路径的 reroll
              // 目标楼)都不进这条路,原因见 deskRender.ts 头注释同一条纪律的后端版本:半截文本喂
              // 正则=十有八九匹配不上/匹配错,折出来的卡片是残的,不如老实显示"在写…"。渲染管线
              // 绝不改写 f.content 本身(展示层变换,楼层落库内容永远原样)。
              const isSettled = !!f.id && !f.streaming;
              // 任务1(老楼层剥壳):在下行正则/兜底折叠之前先剥掉 <content> 包裹壳(镜像后端
              // unwrapContentTag,理由见 deskRender.ts unwrapContentTagClient 头注释)——补丁上线前
              // 落库的老楼层正文整段裹在 <content>...</content> 里,不剥的话 foldProtocolBlocks 会把
              // 整篇小说正文当一个巨大协议块折起来。这一步只影响"美化"这条展示链路,素颜(见下面
              // displayText/最终 splitInlineThinking 调用)照旧显示 f.content 原文,不受这层剥壳影响
              // ——素颜本来就是用来核对"美化有没有把东西折坏"的原文视角。
              const unwrappedContent = isSettled ? unwrapContentTagClient(f.content) : f.content;
              const unwrapMatched = isSettled && unwrappedContent !== f.content;
              const regexedContent = isSettled ? downTransform(f, unwrappedContent) : f.content;
              const downMatched = isSettled && regexedContent !== unwrappedContent;
              // 兜底折叠(任务1)预演:美化视角(用 regexedContent、剥掉规范 <thinking> 后)先算一遍
              // 有没有漏网协议块——哪怕这楼没有一条自定义正则命中,只要还有协议渣,也该 default 美化,
              // 不然"模型发明新标签名"这个任务本要治的病,default 素颜下永远看不见。跟下面 beautify=true
              // 分支要显示的 body 是同一份计算,这里先求出来复用,不重复跑 splitInlineThinking/fold。
              const beautifySplit = isSettled ? splitInlineThinking(regexedContent, false) : null;
              const foldedParts = beautifySplit ? foldTransform(f, beautifySplit.body) : null;
              const foldMatched = !!foldedParts && foldedParts.some((p) => p.type === 'fold');
              // defaultBeautify 现在也认 unwrapMatched(任务1):老楼层剥完壳之后,里头往往已经没有
              // 别的协议渣了(foldMatched 会是 false)、也没配自定义的下行正则(downMatched 也是
              // false)——如果这时还只看 downMatched||foldMatched,default 会判回素颜,而素颜显示的
              // 是未剥壳的 f.content 原文,<content> 标签字面文本又会露出来,治了个寂寞。把"剥壳本身
              // 改动了展示内容"也算进"这楼该不该默认美化"的判断里,default 才会切到美化视角
              // (displayText=regexedContent,已经是剥完壳的版本),不用手动点"美化"才看见干净正文。
              const defaultBeautify = downMatched || foldMatched || unwrapMatched; // 工单原话:default 美化 when any down-rule matched(含兜底折叠命中+剥壳命中)
              const beautify = f.key in beautifyOverrides ? beautifyOverrides[f.key] : defaultBeautify;
              const displayText = isSettled && beautify ? regexedContent : f.content;

              const useBeautifiedSplit = isSettled && beautify && !!beautifySplit;
              const { thinking: inlineThinking, body } = useBeautifiedSplit ? beautifySplit! : splitInlineThinking(displayText, !!f.streaming);
              const thinkingText = [f.thinking, inlineThinking].filter((s) => s && s.trim()).join('\n\n---\n\n');
              const isLast = f.key === lastAssistantKey;
              // 只有真的在美化态时才拆```html卡片/折协议渣——素颜/未落库楼层原样当纯文本显示(哪怕
              // 字面上带着```html围栏或协议残渣标签,那也是模型的原始输出,素颜就该照原样显示;
              // 折叠归在美化侧,理由见 deskRender.ts foldProtocolBlocks 头注释同一条判断)。fold 结果里
              // 的 text 分段还要再过一遍 segmentRendered 拆```html卡片,fold 分段原样透传不递归处理。
              const segments: RenderSegment[] = useBeautifiedSplit && foldedParts
                ? foldedParts.flatMap((p) => (p.type === 'fold' ? [p] : segmentRendered(p.text)))
                : [{ type: 'text' as const, text: body }];
              const beautifyToggle = isSettled && (downMatched || foldMatched || unwrapMatched) ? (
                <button
                  onClick={() => toggleBeautify(f.key, defaultBeautify)}
                  title="下行正则/兜底折叠把这楼改样子了——切回原文看看有没有被折坏"
                  className="serc text-[11px] text-ink2 hover:text-accent"
                >
                  {beautify ? '素颜' : '美化'}
                </button>
              ) : null;

              return (
                <div key={f.key} className="flex flex-col items-start gap-1.5">
                  <div className="max-w-[88%] w-full space-y-2.5">
                    <div className="serc text-[11px] text-ink2 px-1">打字桌</div>
                    {thinkingText && (
                      <details className="text-xs">
                        <summary className="serc inline-flex items-center gap-2 cursor-pointer select-none text-ink-body bg-card/80 border border-dashed border-dash-line rounded-full px-3 py-1 list-none [&::-webkit-details-marker]:hidden">
                          <span className="w-2 h-2 rounded-[3px] bg-scale-2" /> 构思(草稿)
                        </summary>
                        <div className="mt-2 max-w-[85%] max-[760px]:max-w-[92%] border border-dashed border-dash-line rounded-xl bg-card/80 px-4 py-3 whitespace-pre-wrap leading-relaxed text-ink-body">{thinkingText}</div>
                      </details>
                    )}
                    {editingFloorKey === f.key ? (
                      <div className="w-full space-y-2">
                        <textarea
                          value={editDraft} ref={editTextareaRef}
                          onInput={(e) => grow(e.currentTarget, (e.nativeEvent as InputEvent).isComposing === true)}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => onFloorEditKeyDown(e, f)}
                          className="w-full resize-none rounded-[20px] border border-dashed border-dash-line bg-card px-4 py-2.5 text-ink-body leading-relaxed focus:outline-none"
                        />
                        <div className="flex items-center justify-end gap-3">
                          {editError && <span className="text-[11.5px]" style={{ color: '#c2693f' }}>{editError}</span>}
                          <button onClick={cancelFloorEdit} disabled={editSaving} className="text-xs text-ink2 hover:text-ink-body">取消</button>
                          {/* assistant楼:onFloorSaveClick对非user角色直接转confirmFloorEdit,行为跟改动前一字不差 */}
                          <button onClick={() => onFloorSaveClick(f)} disabled={editSaving || sending || !editDraft.trim()} className="rounded-xl bg-accent hover:brightness-105 text-white text-xs px-4 py-1.5 disabled:opacity-40">
                            {floorSaveLabel(f)}
                          </button>
                        </div>
                      </div>
                    ) : !body && segments.length <= 1 ? (
                      <div className="max-w-[85%] max-[760px]:max-w-[92%] rounded-[20px] rounded-bl-[6px] bg-card border border-line-soft shadow-sm text-ink-body px-[22px] py-4 whitespace-pre-wrap leading-[1.9]">
                        <span className="text-ink2">{f.streaming ? '在写…' : ''}</span>
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {segments.map((seg, i) =>
                          seg.type === 'html' ? (
                            // sandbox 升级:allow-scripts(仍不给 allow-same-origin/allow-forms/
                            // allow-popups/allow-top-navigation 任何一项)——取舍记录在 deskRender.ts
                            // buildCardSrcDoc 头注释。卡片自己测高、postMessage 上报,这里用 contentKey
                            // 登记 contentWindow 供上面的 message 监听逐张对号;高度取 cardHeights 里
                            // 报上来的值,没收到消息前继续吃 DESK_CARD_MAX_HEIGHT 旧默认值兜底。
                            (() => {
                              // contentKey=位置+内容指纹(见上面 cardHeights 头注释"必现误杀修复"):
                              // 位置相同但内容变了必须是新身份,React key 用它才能保证合法内容变化
                              // 强制整卸载重挂、而不是原地更新 srcDoc。
                              const contentKey = `${f.key}-seg-${i}#${cheapHash(seg.code)}`;
                              if (killedCards[contentKey]) {
                                // 导航击杀器命中(见上面 onCardIframeLoad 头注释):不重挂 iframe,
                                // 无声守卫=故障家法,横幅必须开口说人话,不许软化文案。
                                return (
                                  <div
                                    key={contentKey}
                                    className="max-w-[85%] max-[760px]:max-w-[92%] rounded-[20px] rounded-bl-[6px] border border-line-soft shadow-sm px-[18px] py-3 text-[12.5px] leading-relaxed"
                                    style={{ background: 'var(--card-bg)', color: '#c2693f' }}
                                  >
                                    这张美化卡的脚本试图向外部地址导航,已被掐断——不影响素颜原文,可疑的话去文具盒正则页把对应规则关掉
                                  </div>
                                );
                              }
                              return (
                                // 去气泡壳——美化卡以前套着聊天气泡的白边/圆角/阴影,
                                // 手机模板等等本身自带设计的srcdoc内容被硬箍在气泡里显得滑稽。改成无边框
                                // 通栏块:不设border/圆角/背景/阴影,宽度放开到跟外层assistant列(88%)
                                // 齐平,让卡片自己的设计说话。overflow-hidden留着(纯技术性:防止测高
                                // 消息到达前用默认高度时iframe内容边角轻微溢出),不算"气泡壳"的一部分。
                                // iframe本体/击杀器/测高协议(下方ref回调+onLoad+postMessage)一概不动。
                                <div
                                  key={contentKey}
                                  className="w-full overflow-hidden"
                                >
                                  <iframe
                                    ref={(el) => {
                                      // 节点身份判断:ref 回调在每次父组件重渲染时都会被
                                      // React 拿当前节点重新调用一遍,不是只在真挂载/真卸载时才响——
                                      // 靠 cardNodesRef 记住"这个 contentKey 上次挂的是哪个节点",
                                      // 只有节点真换了才是真挂载。
                                      if (el) {
                                        if (cardNodesRef.current.get(contentKey) !== el) {
                                          // 真挂载:新 DOM 节点(含"素颜切回美化"这种同 contentKey
                                          // 但物理上是全新元素的重挂)——登记节点/contentWindow,
                                          // load 计数清零,不许沿用旧元素留下的累计值。
                                          cardNodesRef.current.set(contentKey, el);
                                          if (el.contentWindow) cardWindowsRef.current.set(contentKey, el.contentWindow);
                                          cardLoadCountRef.current.set(contentKey, 0);
                                        }
                                        // else:同一节点被重渲染 churn 又调用了一次 ref,原样不动——
                                        // 这正是要修的必现误杀:高度上报/任意父状态更新都会触发这一路,
                                        // 若在这里清零计数,击杀器的记忆会被自己的正常运作洗掉。
                                      }
                                      // el 为 null 时什么都不做(取舍:不再清三个 Map/Record):
                                      // 单看这一次同步调用,分不清这个 null 是"真卸载"还是"重渲染
                                      // churn 的中间态"(React 有时会在换节点前先拿 null 过一遍旧
                                      // 节点的 ref)——错误地把它当真卸载清掉登记,会重演上面同一个
                                      // "记忆被自己冲掉"的坑。改为接受有界累积:条目数上限=本会话
                                      // 出现过的 contentKey 数(去重后,含内容变化产生的历史条目),
                                      // 跟 killedCards 同族,是刻意接受的会话级小垃圾,不做主动清理。
                                    }}
                                    sandbox="allow-scripts"
                                    referrerPolicy="no-referrer"
                                    srcDoc={buildCardSrcDoc(seg.code)}
                                    title="美化卡片"
                                    onLoad={() => onCardIframeLoad(contentKey)}
                                    style={{ width: '100%', height: cardHeights[contentKey] ?? DESK_CARD_MAX_HEIGHT, border: 'none', display: 'block' }}
                                  />
                                </div>
                              );
                            })()
                          ) : seg.type === 'fold' ? (
                            // 协议渣兜底折叠(任务1):样式照抄上面「构思(草稿)」<details> 折叠块的做法
                            // (同一份视觉家法),收起只显示标签名当标题,点开等宽字体+原样换行显示块内
                            // 原文——这是展示层结构,不改楼层落库内容(f.content 永远原样)。
                            <details key={`${f.key}-seg-${i}`} className="text-xs">
                              <summary className="serc inline-flex items-center gap-2 cursor-pointer select-none text-ink-body bg-card/80 border border-dashed border-dash-line rounded-full px-3 py-1 list-none [&::-webkit-details-marker]:hidden">
                                <span className="w-2 h-2 rounded-[3px] bg-scale-2" /> {seg.tag}
                              </summary>
                              <div className="mt-2 max-w-[85%] max-[760px]:max-w-[92%] border border-dashed border-dash-line rounded-xl bg-card/80 px-4 py-3 whitespace-pre-wrap leading-relaxed text-ink-body font-mono text-[12px]">{seg.content}</div>
                            </details>
                          ) : seg.text.trim() ? (
                            <div
                              key={`${f.key}-seg-${i}`}
                              className="max-w-[85%] max-[760px]:max-w-[92%] rounded-[20px] rounded-bl-[6px] bg-card border border-line-soft shadow-sm text-ink-body px-[22px] py-4 whitespace-pre-wrap leading-[1.9]"
                            >
                              {seg.text}
                            </div>
                          ) : null
                        )}
                      </div>
                    )}
                  </div>

                  {editingFloorKey !== f.key && (
                    <FloorActionRow
                      f={f} floorNo={floorIndex + 1} isAssistant sending={sending} mutBusy={mutCount > 0 || editingFloorKey !== null}
                      onEdit={startFloorEdit} onCopy={(t) => navigator.clipboard?.writeText(t)} onToggleReport={toggleReport}
                      extra={beautifyToggle}
                      isLast={isLast} onReroll={reroll}
                    />
                  )}

                  {f.variantsCount > 1 && (
                    <div className="flex items-center gap-2.5 px-1.5 text-xs text-ink2">
                      <button
                        disabled={sending || mutCount > 0 || editingFloorKey !== null || variantBusy[f.key] || f.activeVariant <= 0}
                        onClick={() => switchVariant(f, f.activeVariant - 1)}
                        className="disabled:opacity-30 hover:text-accent"
                      >◀</button>
                      <span className="ser">{f.activeVariant + 1}/{f.variantsCount}</span>
                      <button
                        disabled={sending || mutCount > 0 || editingFloorKey !== null || variantBusy[f.key] || f.activeVariant >= f.variantsCount - 1}
                        onClick={() => switchVariant(f, f.activeVariant + 1)}
                        className="disabled:opacity-30 hover:text-accent"
                      >▶</button>
                    </div>
                  )}
                  {variantError && <div className="text-xs" style={{ color: '#c2693f' }}>{variantError}</div>}

                  {reportOpenKeys.has(f.key) && <FloorReportView report={f.report} />}
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </main>

        {/* 持久错误横幅:跟 floors 数组分开存,canonical reload 换血 floors 也冲不掉这条——
            真出错才会点亮(主动暂停不算),点"知道了"手动收起,或下一轮开跑时自动清空。
            ⚠️原来它是 <main> 滚动流里的第一块,人在底下写字时提醒出在山那头,得翻回去才看得见
            ——而它想说的话("有楼层正在编辑中,先保存或取消再发送""状态板保存中")恰恰全是**你此刻正在
            做的事被拦下了**,看不见等于没说。改成钉在头栏底下不随滚动走。
            z 取 [3]:压过浮窗(z-1)和底栏(z-2)——它要盖住那些才叫"看得见";不许够到头栏 z-[8],
            头栏那几颗钮任何时候都得可点(同前面那套层级家法)。 */}
        {deskError && (
          <div
            className="absolute left-0 right-0 z-[3] px-6 pt-3 max-[760px]:px-3.5 pointer-events-none"
            style={{ top: headerH }}
          >
            <div
              className="max-w-2xl mx-auto flex items-start gap-3 text-sm rounded-2xl border px-4 py-3 shadow-md pointer-events-auto"
              style={{ color: '#c2693f', borderColor: '#c2693f', background: 'var(--card-bg)' }}
            >
              <span className="flex-1">{deskError}</span>
              <button onClick={() => setDeskError('')} className="serc text-xs shrink-0 hover:opacity-70" style={{ color: '#c2693f' }}>知道了</button>
            </div>
          </div>
        )}

        {/* 🌍 世界书浮窗:顶栏「世」。核心记忆置顶(默认收起)+ 全部设定/大纲条目,
            可展开一直改到正文。 */}
        {loreOpen && win && (
          <LoreWindow
            base={base}
            envOk={envOk}
            project={win.project}
            headerH={headerH}
            footerH={footerH}
            onDirtyChange={setLoreDirty}
            onClose={requestLoreClose}
            closeArmed={loreArm === 'close'}
          />
        )}

        {/* 时光带独立浮窗：顺序排在导演小纸条前，不再挤进状态板。 */}
        {timelineOpen && (
          <div
            className="absolute left-0 right-0 z-[1] border-b border-line-soft bg-card shadow-sm px-6 py-4 max-[760px]:px-3.5 overflow-y-auto"
            style={{ top: headerH, maxHeight: `calc(100% - ${headerH}px - ${footerH}px)` }}
          >
            <div className="max-w-2xl mx-auto">
              <div>
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <div>
                    <div className="serc text-sm text-ink-deep">时光带</div>
                    <div className="text-[11px] text-ink2 mt-0.5">
                      {timelineDraft.length
                        ? `${timelineDraft.length}段 · 水位 ${win?.timeline_state?.cutoff ? '已建立' : '未建立'}`
                        : '还没有折叠过；窗口超过20楼后自动生成，最近6楼保留原文'}
                    </div>
                  </div>
                  {sending && <span className="text-[11px] text-ink2">生成中,时光带锁定</span>}
                </div>
                {timelineDraft.length ? (
                  <div className="space-y-2.5">
                    {timelineDraft.map((text, i) => (
                      <label key={`${win?.timeline_state?.segs?.[i]?.upto || i}`} className="block">
                        <span className="serc text-[11px] text-ink2">第 {i + 1} 段</span>
                        <textarea
                          value={text}
                          onChange={(e) => {
                            const value = e.target.value;
                            setTimelineDraft((rows) => rows.map((row, idx) => (idx === i ? value : row)));
                            setTimelineDirty(true);
                          }}
                          disabled={sending || timelineSaving}
                          rows={4}
                          className="mt-1 w-full resize-y rounded-xl border border-line-soft bg-page px-3 py-2 text-xs leading-relaxed text-ink-body focus:outline-none disabled:opacity-50"
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-dash-line px-3 py-3 text-xs text-ink2">暂无时光带正文</div>
                )}
                <div className="flex items-center justify-end gap-3 mt-2.5">
                  {timelineError && <span className="text-[11.5px]" style={{ color: '#c2693f' }}>{timelineError}</span>}
                  <button
                    onClick={saveTimeline}
                    disabled={!timelineDirty || sending || timelineSaving || compressing || !timelineDraft.length}
                    className="rounded-xl bg-accent hover:brightness-105 text-white text-xs px-4 py-1.5 disabled:opacity-40"
                  >
                    {timelineSaving ? '保存中…' : timelineDirty ? '保存时光带' : '时光带已保存'}
                  </button>
                </div>
              </div>
              <div className="flex justify-end mt-3">
                <button onClick={closeTimelinePanel} disabled={timelineSaving} className="text-xs text-ink2 hover:text-ink-body disabled:opacity-40">
                  {/* 只在这次确认确实是冲着"关闭"来的时候才改文案——arm 现在绑定动作(见 boardArmRef) */}
                  {boardArm === 'close' ? '不保存关闭?再点一次' : '关闭'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 📝 导演小纸条抽屉(浮窗:盖在对话内容之上,不随滚动走。自身 overflow-y-auto,
            内容再长也不会伸到头栏/底栏头上)
            ⚠️它**从底栏上方弹出**,不再卡在头栏下方——第一批把那颗钮从顶栏挪到输入框
            左边之后,"按钮在下面、面板从上面掉下来"就成了动线上的断点。规矩统一成**面板从按钮那边出来**:
            顶栏那四颗([文][世][时][态])的面板贴头栏底边,输入框旁边这颗的面板贴底栏上边。
            bottom 用 footerH 量:footer 是 flex-none,iOS 键盘弹起时 visualViewport 变而它自身高度不变,
            所以这个值在键盘弹起时仍然成立——但这条是推断,以 iPad 实测为准(上次光标坑就栽在
            "以为 iOS 会怎样"上,见 grow() 那段)。 */}
        {noteOpen && (
          // 复测仍浅:真凶有两层——①bg-card/60半透明(上轮已改实底) ②HeatBg是
          // position:fixed+zIndex:0的定位元素还自带0.5-0.78渐变纱罩,CSS绘制序里定位元素(z:0)盖在一切
          // 未定位普通内容之上——这块面板原是普通div,整个被压在纱罩底下,所以光改实底没用。头栏清晰
          // 正是因为它sticky(定位)。修法=给面板自己立定位+z层级,跟纱罩平起平坐后按z高低赢回来。
          // z仍取[1]:压过HeatBg的z:0即可,不许够到底栏z-[2]/头栏z-10——浮窗改造后
          // 这块面板挪到 <main> 之后渲染,同 z 值靠 DOM 顺序赢过对话内容,不用再新起更高的层级。
          <div
            // 阴影朝上:shadow-sm 是向下投的,面板改成贴着底栏往上开之后那圈影子
            // 全落在底栏上、还被 z-[2] 的底栏盖掉,朝内容区的这条上沿等于秃的。
            className="absolute left-0 right-0 z-[1] border-t border-line-soft bg-card shadow-[0_-2px_8px_var(--card-shadow)] px-6 py-4 max-[760px]:px-3.5 overflow-y-auto"
            style={{ bottom: footerH, maxHeight: `calc(100% - ${headerH}px - ${footerH}px)` }}
          >
            <div className="max-w-2xl mx-auto">
              <div className="serc text-sm text-ink-deep mb-2">导演小纸条</div>
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="（这段悄悄话会按深度插进近景楼层间,照 ST 作者注释的语义)"
                rows={3}
                className="w-full resize-none rounded-2xl border border-dashed border-dash-line bg-page px-4 py-3 text-sm text-ink-body leading-relaxed focus:outline-none"
              />
              <div className="flex items-center gap-3 mt-2.5 flex-wrap">
                <label className="flex items-center gap-2 text-xs text-ink2">
                  深度
                  <input
                    type="number" min={1} max={10} value={noteDepthDraft}
                    onChange={(e) => setNoteDepthDraft(Number(e.target.value))}
                    className="w-14 text-center rounded-lg border border-line-soft bg-card px-2 py-1 text-xs text-ink-body focus:outline-none"
                  />
                </label>
                <span className="text-[11px] text-ink2">从近景末尾往前数第几层插入(1-10)</span>
                <div className="ml-auto flex items-center gap-3">
                  {noteError && <span className="text-[11.5px]" style={{ color: '#c2693f' }}>{noteError}</span>}
                  <button onClick={() => setNoteOpen(false)} disabled={noteSaving} className="text-xs text-ink2 hover:text-ink-body">取消</button>
                  <button onClick={saveNote} disabled={noteSaving} className="rounded-xl bg-accent hover:brightness-105 text-white text-xs px-4 py-1.5 disabled:opacity-40">
                    {noteSaving ? '保存中…' : '保存'}
                  </button>
                </div>
              </div>

            </div>
          </div>
        )}

        {/* 🎬 状态板可编辑面板(浮窗,同上——补排期工单:S4贴的"只读,S5才能改"标签是过期占位,
            这次补上手动编辑) */}
        {boardOpen && (
          // 同上(R3案二段):实底+定位+z-[1]双管齐下,理由与z校准见小纸条抽屉那段注释
          <div
            className="absolute left-0 right-0 z-[1] border-b border-line-soft bg-card shadow-sm px-6 py-4 max-[760px]:px-3.5 overflow-y-auto"
            style={{ top: headerH, maxHeight: `calc(100% - ${headerH}px - ${footerH}px)` }}
          >
            <div className="max-w-2xl mx-auto">
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <div className="serc text-sm text-ink-deep">状态板</div>
                <div className="flex items-center gap-3">
                  {/* 互斥闸(工单点名):这楼生成还在飞,模型这楼末尾就要写板,手改在这时候保存
                      只会被机器写入路径覆盖——锁编辑口而不是锁保存按钮那一下,免得她敲了半天字才发现白敲 */}
                  {sending && <span className="text-[11px] text-ink2">生成中,状态板锁定</span>}
                  {/* 🔄 按最新正文重算——放在标题这一排、
                      跟底下的「保存」隔开:它是"重新取一份",不是"提交",混在一起容易手滑。
                      有未保存的草稿时第一次点只亮确认(refreshArm),再点一次才真的覆盖——跟本仓
                      别处的两段确认一个路子。 */}
                  <button
                    onClick={refreshBoard}
                    disabled={sending || boardSaving || boardRefreshing}
                    title="按最后一楼(改过之后的)正文重算一份状态板，填进草稿等你确认"
                    className="serc text-[11.5px] rounded-xl border px-3 py-1 disabled:opacity-40"
                    style={{
                      color: refreshArm ? '#c0573f' : 'var(--ink-body)',
                      borderColor: refreshArm ? '#c0573f' : 'var(--line-soft)',
                      background: 'var(--card-bg)',
                    }}
                  >
                    {boardRefreshing ? '重算中…' : refreshArm ? '会盖掉草稿?再点一次' : '↻ 按正文重算'}
                  </button>
                </div>
              </div>
              {boardRefreshNotice && (
                <div className="text-[11.5px] text-ink2 mb-2">{boardRefreshNotice}</div>
              )}
              {/* 冲突态横幅:生成往板上写了新内容,手上的草稿还基于旧板——
                  不自动合并(宁明说不瞎猜),只给一条明路:看新板就整份重载(丢草稿),
                  想留改动就先复制出去,回头重新点开面板照抄回来 */}
              {boardConflict && (
                <div className="flex items-center gap-3 flex-wrap mb-2.5 text-[11.5px] rounded-xl border px-3 py-2" style={{ color: '#c2693f', borderColor: '#c2693f', background: 'var(--card-bg)' }}>
                  <span className="flex-1">生成往板上写了新内容,你的草稿基于旧板——点"看新板"丢弃草稿重载,或复制你的改动后重来</span>
                  <button onClick={viewNewBoard} className="serc shrink-0 rounded-lg border px-2.5 py-1" style={{ color: '#c2693f', borderColor: '#c2693f' }}>看新板(丢弃草稿)</button>
                </div>
              )}
              {/* 重名/空名边打边校验(任务点4+7):topBadKeys 标顶层,每个object行自己的subBadKeys
                  在下面map里当场算——两者都算进 boardHasKeyErrors,任一处有问题就整块锁保存按钮
                  (保存时后一个重名会静默覆盖前一个,数据无声丢失,所以必须在她还在打字的时候就
                  拦住,不能拖到点保存那一刻才发现)。 */}
              {(() => {
                const topBadKeys = findBadKeyIndexes(boardDraft);
                const boardHasKeyErrors = topBadKeys.size > 0 || boardDraft.some((r) => r.rawKind === 'object' && findBadKeyIndexes(r.subRows || []).size > 0);
                return (
                  <>
                    <div className="rounded-2xl border border-dashed border-dash-line overflow-hidden">
                      {boardDraft.map((row, i) => {
                        const keyBad = topBadKeys.has(i);
                        const keyInputCls = `serc w-24 flex-none rounded-lg border bg-page px-2 py-1 text-xs text-ink-body focus:outline-none disabled:opacity-50 ${keyBad ? 'border-[#c2693f]' : 'border-line-soft'}`;
                        if (row.rawKind === 'object') {
                          const subRows = row.subRows || [];
                          const subBadKeys = findBadKeyIndexes(subRows);
                          return (
                            <div key={row.id} className={`px-3 py-2 ${i > 0 ? 'border-t border-dashed border-dash-line' : ''}`}>
                              <div className="flex items-center gap-2">
                                {row.protocolLocked ? (
                                  <div className="serc w-24 flex-none text-xs text-ink2" title="装配引擎钉死的固定键名,不给改">{row.key}</div>
                                ) : (
                                  <input
                                    value={row.key}
                                    onChange={(e) => updateBoardRowKey(i, e.target.value)}
                                    disabled={sending || boardSaving}
                                    className={keyInputCls}
                                  />
                                )}
                                <span className="flex-1 text-[11px] text-ink2">对象·{subRows.length}项(展开成子行编辑,见下)</span>
                                <button
                                  onClick={() => removeBoardRow(i)}
                                  disabled={sending || boardSaving}
                                  title="连这个键带下面所有子行一起删掉(保存前都是草稿)"
                                  className="shrink-0 leading-none text-[11px] text-ink2 hover:text-[#c2693f] disabled:opacity-30"
                                >删整项</button>
                              </div>
                              <div className="mt-1.5 ml-1 pl-2.5 border-l-2 border-dashed border-dash-line space-y-1.5">
                                {subRows.map((sr, si) => {
                                  const subKeyBad = subBadKeys.has(si);
                                  return (
                                    <div key={sr.id} className="flex items-center gap-2">
                                      <input
                                        value={sr.key}
                                        onChange={(e) => updateBoardSubRowKey(i, si, e.target.value)}
                                        placeholder="键名"
                                        disabled={sending || boardSaving}
                                        className={`serc w-20 flex-none rounded-lg border bg-page px-2 py-1 text-[11px] text-ink-body focus:outline-none disabled:opacity-50 ${subKeyBad ? 'border-[#c2693f]' : 'border-line-soft'}`}
                                      />
                                      <input
                                        value={sr.value}
                                        onChange={(e) => updateBoardSubRowValue(i, si, e.target.value)}
                                        placeholder="—"
                                        disabled={sending || boardSaving}
                                        className="flex-1 min-w-0 rounded-lg border border-line-soft bg-page px-2 py-1 text-[11px] text-ink-body focus:outline-none disabled:opacity-50"
                                      />
                                      {/* 只展开一层(任务点6):子值本身还是对象/数组/数字/布尔/null——
                                          同顶层'other'一个路数,JSON文本+徽章,不递归往下拆 */}
                                      {sr.rawKind === 'other' && (
                                        <span
                                          title="这个子键原本不是字符串;编辑这一行会让它保存后变成文字,回不去原类型"
                                          className="shrink-0 text-[10px] text-ink2 border border-dashed border-dash-line rounded-full px-1.5 py-0.5 whitespace-nowrap"
                                        >
                                          原始类型:{rawTypeLabel(sr.raw)}{sr.touched ? '(已编辑→将存为文字)' : ''}
                                        </span>
                                      )}
                                      <button
                                        onClick={() => onBoardSubDeleteClick(i, si, sr.id)}
                                        disabled={sending || boardSaving}
                                        title="删掉这一子行(保存前都是草稿)"
                                        className="shrink-0 leading-none text-[11px] text-ink2 hover:text-[#c2693f] disabled:opacity-30"
                                      >{boardSubDelStage[sr.id] === 1 ? '确定删?' : '删'}</button>
                                    </div>
                                  );
                                })}
                                <button onClick={() => addBoardSubRow(i)} disabled={sending || boardSaving} className="text-[11px] text-ink2 hover:text-ink-body disabled:opacity-40">＋加一子行</button>
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div key={row.id} className={`flex items-center gap-2 px-3 py-2 ${i > 0 ? 'border-t border-dashed border-dash-line' : ''}`}>
                            {row.protocolLocked ? (
                              <div className="serc w-24 flex-none text-xs text-ink2" title="装配引擎钉死的固定键名,不给改">{row.key}</div>
                            ) : (
                              <input
                                value={row.key}
                                onChange={(e) => updateBoardRowKey(i, e.target.value)}
                                placeholder="键名"
                                disabled={sending || boardSaving}
                                className={keyInputCls}
                              />
                            )}
                            <input
                              value={row.value}
                              onChange={(e) => updateBoardRowValue(i, e.target.value)}
                              placeholder={row.rawKind === 'stringArray' ? '顿号、或逗号分隔多个' : '—'}
                              disabled={sending || boardSaving}
                              className="flex-1 min-w-0 rounded-lg border border-line-soft bg-page px-2 py-1 text-xs text-ink-body focus:outline-none disabled:opacity-50"
                            />
                            {/* 数字/布尔/null/混类型数组这类"非字符串原始值"显示成
                                JSON文本编辑,提前提示"这行一旦被改,保存后就永久变字符串了"
                                (嵌套对象已经在上面单独分支展开成子行,不会走到这条'other'分支来) */}
                            {row.rawKind === 'other' && (
                              <span
                                title="这个键原本不是字符串;编辑这一行会让它保存后变成文字,回不去原类型"
                                className="shrink-0 text-[10px] text-ink2 border border-dashed border-dash-line rounded-full px-1.5 py-0.5 whitespace-nowrap"
                              >
                                原始类型:{rawTypeLabel(row.raw)}{row.touched ? '(已编辑→将存为文字)' : ''}
                              </span>
                            )}
                            <button
                              onClick={() => removeBoardRow(i)}
                              disabled={sending || boardSaving}
                              title="删掉这一行(保存前都是草稿)"
                              className="shrink-0 leading-none text-xs text-ink2 hover:text-[#c2693f] disabled:opacity-30"
                            >删</button>
                          </div>
                        );
                      })}
                      {!boardDraft.length && <div className="px-3 py-2 text-xs text-ink2">板子是空的,点"＋加一行"手动开一个键</div>}
                    </div>
                    <div className="flex items-center gap-3 mt-2.5 flex-wrap">
                      <button onClick={addBoardRow} disabled={sending || boardSaving} className="text-xs text-ink2 hover:text-ink-body disabled:opacity-40">＋加一行</button>
                      {boardHasKeyErrors && <span className="text-[11.5px]" style={{ color: '#c2693f' }}>有键名是空的或者重复了,标红的那几格先改掉</span>}
                      <div className="ml-auto flex items-center gap-3">
                        {boardError && <span className="text-[11.5px]" style={{ color: '#c2693f' }}>{boardError}</span>}
                        <button onClick={closeBoardPanel} disabled={boardSaving} className="text-xs text-ink2 hover:text-ink-body">
                          {boardArm === 'close' ? '不保存关闭?再点一次' : '取消'}
                        </button>
                        <button
                          onClick={saveBoard}
                          disabled={sending || boardSaving || boardConflict || boardHasKeyErrors}
                          title={sending ? '生成中,状态板锁定' : boardConflict ? '草稿基于旧板,先看新板或放弃保存' : boardHasKeyErrors ? '有键名是空的或者重复了' : undefined}
                          className="rounded-xl bg-accent hover:brightness-105 text-white text-xs px-4 py-1.5 disabled:opacity-40"
                        >
                          {boardSaving ? '保存中…' : sending ? '生成中锁定' : boardConflict ? '有冲突,不能保存' : boardHasKeyErrors ? '键名有问题' : '保存'}
                        </button>
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* 🔍 透视下一楼:结果展示(轻量弹层,点遮罩关) */}
        {dryrunOpen && (
          <div className="fixed inset-0 z-30 flex items-center justify-center px-6 box-border max-[760px]:px-2.5" onClick={() => setDryrunOpen(false)}>
            <div className="absolute inset-0 backdrop-blur-sm" style={{ background: 'rgba(50,55,40,0.4)' }} />
            <div className="relative w-full flex flex-col overflow-hidden" style={{ maxWidth: 560, maxHeight: '82vh', background: 'var(--card-bg)', borderRadius: 22, boxShadow: '0 20px 50px var(--card-shadow2)' }} onClick={(e) => e.stopPropagation()}>
              <div className="flex-none flex items-center justify-between" style={{ padding: '20px 24px 14px' }}>
                <span className="serc" style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink-deep)' }}>透视下一楼</span>
                <button onClick={() => setDryrunOpen(false)} className="serc leading-none cursor-pointer hover:opacity-70" style={{ fontSize: 13, color: 'var(--ink2)', background: 'none', border: 'none' }}>关闭</button>
              </div>
              <div style={{ margin: '0 24px', borderTop: '1px dashed var(--dash-line)' }} />
              <div className="flex-1 overflow-y-auto" style={{ padding: '16px 24px 22px' }}>
                {dryrunLoading ? (
                  <div style={{ fontSize: 13, color: 'var(--ink2)' }}>正在裸跑装配…</div>
                ) : dryrunError ? (
                  <div style={{ fontSize: 13, color: '#c2693f' }}>{dryrunError}</div>
                ) : dryrunReport ? (
                  <FloorReportView report={dryrunReport} />
                ) : null}
              </div>
            </div>
          </div>
        )}

        {/* 📖 收进章节草稿弹窗已整个拆除,不单独收一段原文进草稿箱——不留死代码。 */}

        <footer ref={footerRef} className="chat-inputbar flex-none z-[2] bg-page/85 backdrop-blur border-t border-line-soft px-6 pt-4 pb-5 max-[760px]:px-3.5">
          <div className="max-w-2xl mx-auto flex items-end gap-2.5">
            <button
              onClick={doDryrun}
              disabled={!curWindowId}
              title="透视下一楼(裸看装配结果,不真的发)"
              className="serc rounded-[18px] bg-card border border-line-soft hover:brightness-[.97] text-ink-body text-sm w-12 h-12 shrink-0 flex items-center justify-center disabled:opacity-40"
            >
              透视
            </button>
            {/* 📝 导演小纸条——它写的是"给下一楼的临时指令",
                跟按下发送是同一件事,不是"设置"。跟透视钮并排站在输入框左手边,顺手就够得着。
                面板本体仍是那个浮窗,toggleNoteDrawer 一字未动;右上角那颗小圆点(有没存的纸条)照旧。*/}
            <button
              onClick={toggleNoteDrawer}
              title="导演小纸条：给下一楼的临时指令"
              className="serc relative rounded-[18px] bg-card border border-line-soft hover:brightness-[.97] text-ink-body text-sm w-12 h-12 shrink-0 flex items-center justify-center"
            >
              纸条
              {win?.note?.trim() && <span className="absolute top-1.5 right-1.5 w-[6px] h-[6px] rounded-full bg-accent" />}
            </button>
            {/* 这层relative容器专给@候选下拉当锚点——只裹textarea本体(flex-1从textarea挪到这层容器上,
                textarea自己改w-full),不是整条footer行,这样浮层"锚在输入框正上方"才不会被
                左边透视/纸条按钮、右边发送按钮的宽度带偏。 */}
            <div className="relative flex-1">
              {/* @候选下拉(规格⑦):bottom-full+mb-2锚在输入框正上方;z-[3]沿用文件里既有的
                  "压过footer(z-[2])、不够贴头栏z-[8]/侧栏z-[9]"这套换算(小纸条/时光带那几处浮层同款),
                  抽屉更高不受影响。候选项的blur/click时序用"onMouseDown里preventDefault"——桌面上让
                  textarea压根不失焦、onBlur可以立刻关菜单;⚠️不许换成onPointerDown:iOS对被
                  preventDefault的pointerdown会连click一起吞掉,移动端就点不中了。 */}
              {atMenuVisible && (
                <div className="absolute left-0 right-0 bottom-full mb-2 z-[3] max-h-56 overflow-y-auto rounded-[14px] border border-line-soft bg-card text-sm text-ink-body shadow-lg py-1" role="listbox">
                  {atCandidates.map((name, i) => (
                    <div
                      key={name}
                      role="option"
                      aria-selected={i === atIdxSafe}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertAtCandidate(name)}
                      className={`px-3 py-2 cursor-pointer truncate ${i === atIdxSafe ? 'bg-accent/10' : 'hover:bg-accent/10'}`}
                    >
                      {name}
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={composerRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // 组字中的input事件不重算菜单(规格②)——nativeEvent.isComposing在"正敲拼音/挑候选词"
                  // 期间是true,只有上屏那一下(compositionend跟着触发的input事件)才是false,那次onChange
                  // 自然会带着最终文本重算一遍,不用另外再挂compositionend去重算。
                  if (!(e.nativeEvent as InputEvent).isComposing) recomputeAtMenu(e.currentTarget);
                }}
                onInput={(e) => grow(e.currentTarget, (e.nativeEvent as InputEvent).isComposing === true)}
                onSelect={(e) => { if (!composingRef.current) recomputeAtMenu(e.currentTarget); }}
                onCompositionStart={() => { composingRef.current = true; setAtMenuOpen(false); }} // 组字一开始就收菜单:不给"组字中点旧候选"留窗口,指针路径的IME破坏面从根上封掉
                onCompositionEnd={() => { composingRef.current = false; }}
                onKeyDown={onComposerKeyDownAt}
                onBlur={() => setAtMenuOpen(false)}
                rows={1}
                placeholder="接着写点什么…"
                className="w-full resize-none rounded-[20px] border border-line-soft bg-card px-[18px] min-h-12 py-3 text-ink-body leading-relaxed focus:outline-none focus:border-accent overflow-y-auto"
              />
            </div>
            {sending && turnKind === 'send' ? (
              <button onClick={() => abortRef.current?.abort()} className="serc rounded-[18px] bg-ink2 hover:brightness-105 text-white text-sm px-7 h-12 shrink-0 flex items-center justify-center">
                ■ 暂停
              </button>
            ) : (
              <button onClick={() => send()} disabled={!input.trim() || sending || mutCount > 0} className="serc rounded-[18px] bg-accent hover:brightness-105 text-white text-sm px-7 h-12 shrink-0 flex items-center justify-center disabled:opacity-40">
                发送
              </button>
            )}
          </div>
        </footer>

        {/* 写作屏抽屉覆盖层(布局改造后本体已改成右侧滑栏,见 DeskDrawers.tsx
            头部注释):复用列表屏同一个 DeskDrawerHub 组件本体,两段确认丢弃守卫+焦点陷阱一概原样
            不动(只在这里多挂一份、多传一组 open/onClose)。project 认 win.project(这扇窗归属的项目,不是列表屏
            tab)——win 还没载入完成时不挂载,防止 project 传空字符串。
            规则热更新闭环(任务3点3):onRegexChanged 复用 onRegexChangedFromDrawer——它已经是
            "改了正则/删了预设/导了新预设包→清 downRulesFetchedForRef+downRulesVerRef+downCacheRef
            +敲 downRulesReloadNonce 触发重拉"那一整套(声明处见上文),原来只有列表屏抽屉接得到,
            这里原样接上第二路。抽屉里的改动(RegexTab/BlocksTab/ImportTab)存成功那一刻就会调用
            这个回调,不需要等"关闭"这个动作单独触发——调完美化正则,只要点了保存,downCacheRef
            已经作废,foldCacheRef 的输入(bodyText 派生自 regexedContent)也会跟着变,不用额外清
            foldCacheRef。同一套机制也覆盖"列表屏关抽屉后进窗吃到新规则":enterWindow() 本来就会
            无条件重置 downRulesFetchedForRef/downCacheRef 强制重拉(见该函数),不是这次新加的。 */}
        {win && (
          <DeskDrawerHub
            ref={drawerRef}
            base={base} envOk={envOk} project={win.project}
            open={writeDrawerOpen} onClose={() => setWriteDrawerOpen(false)}
            onRegexChanged={onRegexChangedFromDrawer}
            // 任务2(顶栏瘦身):本窗设置(配方/模型下拉)只在写作屏打开的文具盒里出现——
            // 逻辑一字不改只搬家,switchRecipe/recipeSwitchingRef那整套互斥+model state仍然
            // 活在这个组件里,这里只是把渲染委托给 DeskDrawerHub。列表屏那颗文具盒(下面
            // project=project那个调用点)没有当前窗,不传这个 prop。
            windowSettings={{
              recipeId: win.recipe_id,
              recipeOptions,
              onSwitchRecipe: switchRecipe,
              recipeSwitching,
              recipeSwitchNotice,
              model,
              modelOptions: DESK_MODELS,
              onPickModel: pickModel,
              sending,
            }}
          />
        )}
      </div>
    );
  }

  // ══════════════════════════ 渲染:窗口列表屏(page.tsx 同款样式常量) ══════════════════════════
  // 布局改造:打字桌不再是整页早退接管——现在是 page.tsx 里 stage 内的一个"全高子应用",
  // 左廊(rail)是它的邻居而不是被它盖住的东西。外壳从"minHeight:100vh 整页流"改成"height:100%
  // 撑满 stage + 自己内部滚动"(HeatBg 交给 page.tsx 那一份画,这里不重复画,免得两层纱罩叠加变暗);
  // overflow:hidden 顺手兜住下面文具盒(DeskDrawerHub)侧栏滑入/滑出动画那段还没滑到位的溢出部分,
  // 不让它在过渡途中戳出这个容器的右边界。
  return (
    <div style={{ position: 'relative', height: '100%', boxSizing: 'border-box', background: 'var(--page-bg)', fontFamily: 'var(--font-sans)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '34px 28px 72px' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>

        {/* 下面 DeskDrawerHub 的点外部关闭用 absolute
            inset-0 的 invisible 背板(z:7)盖住这整个容器——这一行头栏原来没定位/没z-index(静态
            定位天然垫底),drawer 开着时背板会截胡鼠标点击,"← 书架"钮实际上按不到。四审时补了
            z-index,但当时抄成了 z-10,盖过了侧栏本体(彼时z-8),侧栏顶部的关闭钮/本窗设置区
            反而被头栏吃了点击——五审定序统一改成 z-8(< 侧栏本体现在的z-9,> 背板z-7):头栏按钮
            全程可点、不被背板截胡,同时不再盖住打开着的侧栏顶端。 */}
        <div style={{ position: 'relative', zIndex: 8, display: 'flex', alignItems: 'center', gap: 15, marginBottom: 26, flexWrap: 'wrap' }}>
          <button className="serc pill" onClick={leaveToShelfFromList} style={pillStyle}>← 书架</button>
          <div>
            <div className="serc" style={{ fontSize: 24, color: 'var(--ink-deep)', lineHeight: 1 }}>打字桌</div>
            <div className="ser" style={{ fontSize: 11, letterSpacing: 2.5, color: 'var(--ink2)', marginTop: 3 }}>TYPING DESK · STUDY</div>
          </div>
          <button
            className="serc"
            onClick={() => setDrawerOpen(true)}
            title="文具盒：积木/配方·世界书·正则·核心记忆·导入"
            style={{ ...pillStyle, marginLeft: 'auto' }}
          >
            文具盒
          </button>
          <button className="serc" onClick={openWizard} style={btnPrimaryStyle}>+ 开新窗</button>
        </div>

        {/* 项目 tab */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
          {projects.map((p) => {
            const active = p === project;
            return (
              <button
                key={p}
                className="serc"
                onClick={() => setProject(p)}
                style={{
                  ...pillStyle,
                  background: active ? 'var(--scale-3)' : 'var(--card-bg)',
                  color: active ? 'var(--card-bg)' : 'var(--ink-body)',
                  border: active ? '1px solid transparent' : '1px solid var(--line-soft)',
                }}
              >
                {p}
              </button>
            );
          })}
        </div>

        {winDelError && <div style={{ fontSize: 12.5, color: '#c2693f', marginBottom: 12 }}>{winDelError}</div>}

        {winListLoading ? (
          <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)' }}>正在翻这屋的窗户…</div>
        ) : winListError ? (
          <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: '#c2693f' }}>翻不开：{winListError}</div>
        ) : windows.length === 0 ? (
          <div className="card" style={{ ...glassCardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)' }}>这个项目还没开过窗~点右上角开第一扇</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {windows.map((w) => (
              <div key={w.id} onClick={() => enterWindow(w.id)} className="card" style={{ ...cardStyle, padding: '18px 20px', cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <span className="serc" style={{ fontSize: 15.5, color: 'var(--ink-deep)' }}>{w.title || '未命名窗口'}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onWinDeleteClick(w.id); }}
                    className="serc"
                    style={{
                      fontSize: 11, flex: 'none', border: 'none', background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                      color: (winDelStage[w.id] || 0) === 1 ? '#c2693f' : 'var(--ink2)',
                    }}
                  >
                    {(winDelStage[w.id] || 0) === 1 ? '真的删?再点一次' : '删除'}
                  </button>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 8 }}>{w.floor_count} 楼 · {fmtWin(w.updated_at)} 更新</div>
              </div>
            ))}
          </div>
        )}

        {/* + 开新窗 向导(三步:①项目=当前tab ②配方 ③标题可选) */}
        {wizardOpen && (
          <div className="fixed inset-0 z-30 flex items-center justify-center px-6 box-border max-[760px]:px-2.5" onClick={() => setWizardOpen(false)}>
            <div className="absolute inset-0 backdrop-blur-sm" style={{ background: 'rgba(50,55,40,0.4)' }} />
            <div className="relative w-full flex flex-col overflow-hidden" style={{ maxWidth: 480, maxHeight: '86vh', background: 'var(--card-bg)', borderRadius: 22, boxShadow: '0 20px 50px var(--card-shadow2)' }} onClick={(e) => e.stopPropagation()}>
              <div className="flex-none flex items-center justify-between" style={{ padding: '22px 26px 16px' }}>
                <span className="serc" style={{ fontSize: 17, fontWeight: 600, color: 'var(--ink-deep)' }}>+ 开一扇新窗</span>
                <button onClick={() => setWizardOpen(false)} className="serc leading-none cursor-pointer hover:opacity-70" style={{ fontSize: 13, color: 'var(--ink2)', background: 'none', border: 'none' }}>关闭</button>
              </div>
              <div style={{ margin: '0 26px', borderTop: '1px dashed var(--dash-line)' }} />
              <div className="flex-1 overflow-y-auto" style={{ padding: '20px 26px 26px' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink2)', letterSpacing: 1.5, marginBottom: 6 }}>① 项目</div>
                {wizProjManual ? (
                  <div style={{ display: 'flex', gap: 6, marginBottom: 22 }}>
                    <input value={wizProjName} onChange={(e) => setWizProjName(e.target.value)} placeholder="新项目名字" style={inputStyle} autoFocus />
                    <button
                      type="button"
                      className="serc"
                      onClick={() => { const p = wizProjName.trim(); if (p) { manualProjectsRef.current.add(p); setProjects((ps) => (ps.includes(p) ? ps : [...ps, p])); setProject(p); } setWizProjManual(false); }}
                      style={{ fontSize: 12.5, color: 'var(--card-bg)', background: 'var(--scale-2)', border: 'none', borderRadius: 12, padding: '0 14px', cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap' }}
                    >
                      用这个
                    </button>
                    <button type="button" className="serc" onClick={() => setWizProjManual(false)} style={{ fontSize: 11.5, color: 'var(--ink2)', background: 'none', border: 'none', cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap' }}>
                      选现有
                    </button>
                  </div>
                ) : (
                  <select
                    value={project}
                    onChange={(e) => {
                      if (e.target.value === '__new_project__') { setWizProjManual(true); setWizProjName(''); return; }
                      setProject(e.target.value);
                    }}
                    style={{ ...inputStyle, cursor: 'pointer', marginBottom: 22 }}
                  >
                    {projects.map((p) => <option key={p} value={p}>{p}</option>)}
                    <option value="__new_project__">＋新建项目…</option>
                  </select>
                )}

                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink2)', letterSpacing: 1.5, marginBottom: 8 }}>② 配方</div>
                {wizRecipesLoading ? (
                  <div style={{ fontSize: 13, color: 'var(--ink2)', marginBottom: 22 }}>正在翻配方本…</div>
                ) : wizRecipesError ? (
                  <div style={{ fontSize: 13, color: '#c2693f', marginBottom: 22 }}>翻不开：{wizRecipesError}</div>
                ) : wizMiniOpen ? (
                  <div style={{ marginBottom: 22, background: 'var(--scale-0)', borderRadius: 16, padding: '16px 18px' }}>
                    <div style={{ fontSize: 12.5, color: 'var(--ink2)', marginBottom: 10 }}>这个项目还没配方,就地建一份~</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <input value={wizMiniName} onChange={(e) => setWizMiniName(e.target.value)} placeholder="配方名字,比如「日常线」" style={inputStyle} />
                      {wizPresetsLoading ? (
                        <div style={{ fontSize: 12.5, color: 'var(--ink2)' }}>翻预设包…</div>
                      ) : wizPresetsError ? (
                        <div style={{ fontSize: 12.5, color: '#c2693f' }}>{wizPresetsError}</div>
                      ) : wizPresets.length === 0 ? (
                        <div style={{ fontSize: 12.5, color: 'var(--ink2)' }}>还没导过预设包——去导入器先导一份(面板功能尚未提供,现在只能手动跑)</div>
                      ) : (
                        <select value={wizMiniPresetId} onChange={(e) => setWizMiniPresetId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                          {wizPresets.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.block_count}块）</option>)}
                        </select>
                      )}
                      <div style={{ display: 'flex', gap: 8 }}>
                        {(['light', 'heavy'] as const).map((wt) => (
                          <button
                            key={wt}
                            onClick={() => setWizMiniWeight(wt)}
                            style={{
                              flex: 1, fontSize: 13, padding: '9px 14px', borderRadius: 12, cursor: 'pointer',
                              background: wizMiniWeight === wt ? 'var(--scale-2)' : 'var(--card-bg)',
                              color: wizMiniWeight === wt ? 'var(--card-bg)' : 'var(--ink-body)',
                              border: wizMiniWeight === wt ? '1px solid transparent' : '1px solid var(--line-soft)',
                            }}
                          >
                            {wt === 'light' ? '轻(1-2k薄system)' : '重(完整预设)'}
                          </button>
                        ))}
                      </div>
                      {wizMiniError && <div style={{ fontSize: 12, color: '#c2693f' }}>{wizMiniError}</div>}
                      <button
                        onClick={createMiniRecipe}
                        disabled={wizMiniCreating || !wizMiniName.trim() || !wizMiniPresetId}
                        style={{ ...btnPrimaryStyle, opacity: wizMiniCreating || !wizMiniName.trim() || !wizMiniPresetId ? 0.6 : 1 }}
                      >
                        {wizMiniCreating ? '建配方中…' : '建这份配方'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginBottom: 10 }}>
                    <select value={wizRecipeId} onChange={(e) => setWizRecipeId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                      {/* 拉全量后下拉混着所有项目的配方,跨项目同名配方
                          看着一模一样分不清——照BlocksTab同款规则,project非空的老配方(历史痕迹)
                          追加`·{project}`,新配方project=''不带这段。 */}
                      {wizRecipes.map((r) => <option key={r.id} value={r.id}>{r.name}（{r.weight === 'light' ? '轻' : '重'}{r.project ? `·${r.project}` : ''}）</option>)}
                    </select>
                    <button onClick={openMiniCreate} style={{ fontSize: 12, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 }}>+ 另建一份配方</button>
                  </div>
                )}

                {!wizMiniOpen && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink2)', letterSpacing: 1.5, margin: '18px 0 8px' }}>③ 标题(可选)</div>
                    <input value={wizTitle} onChange={(e) => setWizTitle(e.target.value)} placeholder="不填就叫「未命名窗口」" style={{ ...inputStyle, marginBottom: 18 }} />

                    {wizError && <div style={{ fontSize: 13, color: '#c2693f', marginBottom: 12 }}>{wizError}</div>}
                    <button
                      onClick={createWindow}
                      disabled={!wizRecipeId || wizCreating}
                      style={{ ...btnPrimaryStyle, width: '100%', padding: '11px 18px', opacity: !wizRecipeId || wizCreating ? 0.6 : 1 }}
                    >
                      {wizCreating ? '开窗中…' : '开窗 & 进去写'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      </div>

      {/* 文具盒(改右侧滑栏,见 DeskDrawers.tsx):挂在滚动区外面,跟它做兄弟——不进
          overflow-y-auto 那层滚动,贴住这个外壳的右边(它自己 position:absolute top/right/bottom:0),
          不会被列表滚动带着跑,也不会盖住左廊(左廊是这个组件的邻居,不在这个 relative 容器里面)。 */}
      <DeskDrawerHub ref={drawerRef} base={base} envOk={envOk} project={project} open={drawerOpen} onClose={() => setDrawerOpen(false)} onRegexChanged={onRegexChangedFromDrawer} />
    </div>
  );
});

export default TypingDesk;
