// 打字桌装配引擎：assembleDesk 负责装配，deskDryrun 只展示结果、不调用模型。
// 从远到近：[配方积木前段] → 剧情核心记忆 → 往事区 → 近期章总结 → 时光带 → 近景
// → [配方积木后段]
// → 导演小纸条 → 状态板+在场角色卡压轴 → 本楼输入。
// 时光带属于故事水流；memories 是世界书/角色卡唯一正本。
//
// 队列以 chatHistory 占位块劈两半:前段(pre)进 system 数组、打 cache_control ephemeral 1h(照
// chat/editorial.ts 的块序手法,是稳定前缀),后段(post)贴进 tail 里状态板之前——注意 post 不进
// cache,因为它排在故事流之后,内容里可能已经掺了跟本楼强相关的东西,硬缓存它没意义。
//
// 稳定前缀必须确定：同窗同输入逐字节一致，禁止加入时钟等调用间变化的数据。

import type { Ai, VectorizeIndex } from '../storage/vectorize.ts';
import { applyMacros, applyUpRegex, matchLoreKeys } from '../tools/deskMacro.ts';
import type { DeskRegexRule } from '../tools/deskMacro.ts';
import { addMentionedCharactersToPresence, buildLoreScanCorpus, resolveAtMentionIds } from '../core/loreTrigger.ts';
import { DESK_TIMELINE_KEEP } from '../core/deskLimits.ts';
import type { DeskAssetStorage, DeskStoryStorage, SemanticSearchAdapter } from '../core/storage.ts';

export interface DeskAssembleEnv {
  OC_DB?: D1Database;
  OC_VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  deskAssets?: DeskAssetStorage;
  deskStory?: DeskStoryStorage;
  semantic?: SemanticSearchAdapter;
}

export interface AssembleFloor {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssembleParams {
  project: string;
  recipeId: string;
  input: string;
  floors?: AssembleFloor[];
  note?: string;
  noteDepth?: number;
  stateBoard?: Record<string, any>;
  vars?: Record<string, string>;
  // 调用方传入已渲染的时光带；本模块不读取其 D1/CAS 状态。
  timeline?: string;
}

// 状态板指令是稳定 system 前缀的一部分。协议围栏必须位于回复末尾，否则按正文处理。
// 所有字段按本楼终态更新；失效伏笔应移除，未收伏笔最多七条。
const STATEBOARD_INSTRUCTION =
  '（系统提示,不是台词)每楼正文结束后,请另起一段用 ```stateboard 围栏输出更新后的状态板 JSON,' +
  '键固定为在场角色/衣装/位置/关系/时间地点五项;五项均按本楼结束时刻的实际状态如实更新——人物离场就从「在场角色」移除(仅被提及、回忆、口述的人物不计入在场),场景移动了「位置」「时间地点」要跟着走,更衣了「衣装」要改;某项这楼确实没有变化,就把当前值原样带一遍,不要省略这个块。' +
  '若板子里已有「未收伏笔」键,每楼同步维护它:新埋下的线索、未兑现的约定、悬而未答的问题添进去,已收线的移除,已经失效或被剧情绕过的也一并移除;全键最多保留7条,超出时合并同类、优先保留对后续剧情最要紧的;注意区分"计划未执行"和"事件已发生",整个键不许自行删除;板上没有这个键就不要自己发明。' +
  '这个围栏必须是这次回复的最后一行结束,围栏之后不许再写任何字。';

// ===== token 粗估：字符数/3 上取整，不接 tokenizer =====
export function estTokens(text: string): number {
  return Math.ceil(String(text || '').length / 3);
}

// ===== 剧情核心记忆解析:oc_state 的 desk_core:<project> 值可能是 JSON(数组/对象)或纯文本 =====
// JSON 形态兼容两种部署者可能存的形状:数组(每项是字符串或 {content}对象)、对象(值当同一件事收集)。
// 都解析不出内容就原样当纯文本返回——这一列本来就是"部署者手写全局梗概",没必要对格式较真。
export function parseCoreMemory(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    const collect = (v: any): string => (typeof v === 'string' ? v : String(v?.content ?? ''));
    if (Array.isArray(parsed)) {
      return parsed.map(collect).filter(Boolean).join('\n\n');
    }
    if (parsed && typeof parsed === 'object') {
      return Object.values(parsed).map(collect).filter(Boolean).join('\n\n');
    }
  } catch {
    // 不是合法 JSON,原样当纯文本走
  }
  return String(raw);
}

// 往事区：topK 只限定候选池，minScore 控制相关性，maxChapters 控制注入体积。
// ⚠️分数口径:OC_VECTORIZE 索引的度量是 **cosine**(wrangler vectorize get 确认),分数越高越像,
//   1=一模一样。要是哪天换成 euclidean,比较方向得整个反过来,别照抄这里的 >=。
// 参数从 oc_state(desk_recall:<project>)读取，可按真实分数分布即时调节。
export const RECALL_DEFAULTS = { topK: 8, minScore: 0.55, maxChapters: 3 };

// 世界书分类由此处单一常量定义，装配与管理端不得另写字面量。
export const LORE_CATEGORIES = ['world', 'outline'] as const;
export const LORE_CATEGORY_SQL = LORE_CATEGORIES.map((c) => `'${c}'`).join(', ');
export type RecallSettings = typeof RECALL_DEFAULTS;

// 坏设置一律退默认、绝不抛:这一层再怎么歪也不该让整条装配断掉(同 parseCoreMemory 的宽容口径)。
// 三个数都夹在合理区间里——手滑把 minScore 填成 6 会导致往事区永远空着,夹回 1 至少还有个上限语义。
export function parseRecallSettings(raw: string | null | undefined): RecallSettings {
  const out = { ...RECALL_DEFAULTS };
  if (!raw) return out;
  try {
    const j = JSON.parse(raw);
    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const k = num(j?.topK); if (k !== null) out.topK = Math.min(50, Math.max(1, Math.round(k)));
    const s = num(j?.minScore); if (s !== null) out.minScore = Math.min(1, Math.max(0, s));
    const m = num(j?.maxChapters); if (m !== null) out.maxChapters = Math.min(20, Math.max(0, Math.round(m)));
  } catch {
    // 不是合法 JSON 就当没设过
  }
  return out;
}

// ===== 状态板「在场角色」取纯文本 =====
// 角色卡的可靠触发通道。只取这一个字段、绝不把整块状态板拿来扫——「衣装:露肩长裙」里那个"露"
// 会把「露」的角色卡勾出来,那就等于把子串误伤原样搬了个家。
// 在这个小字段内部仍用子串匹配(不做等值切分):模型经常写成「露（受伤）」「露、寻」这类花样,
// 等值匹配会把真命中打死,而这个字段短且结构化,误伤概率远低于散文正文。
// 仅在「在场角色」字段内递归收集字符串与对象键，兼容模型形状漂移；深度和条数必须设闸。
export function presenceText(presenceRaw: any): string {
  // 每层容器循环都要复查 200 条上限；对象用 for...in 避免 Object.entries 全量物化。
  const CAP = 200;
  const out: string[] = [];
  const walk = (v: any, depth: number): void => {
    if (depth > 4 || out.length >= CAP) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) {
      for (const x of v) { if (out.length >= CAP) return; walk(x, depth + 1); }
      return;
    }
    if (v && typeof v === 'object') {
      for (const k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        if (out.length >= CAP) return;
        out.push(k);
        if (out.length >= CAP) return;
        walk((v as any)[k], depth + 1);
      }
      return;
    }
    // 数字/布尔/null 一律忽略——它们不可能是角色名
  };
  walk(presenceRaw, 0);
  return out.join('\n');
}

// ===== 章节号自然排序:照 tools/reading.ts naturalCompare 的思路抄一份(workerd 的 ICU 裁剪版
//   对 localeCompare numeric 选项不可靠,手搓"数字段数值比、文字段码位比"),各文件各自持有一份是
//   本仓既有风格(reading.ts 自己也是从 study.ts 抄的),不额外抽公共 util。=====
export function naturalCompareChapterNo(x: string, y: string): number {
  const seg = (s: string) => s.match(/\d+|\D+/g) || [];
  const xs = seg(x), ys = seg(y);
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const a = xs[i], b = ys[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b);
    if (an && bn) {
      const d = Number(a) - Number(b);
      if (d !== 0) return d;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

// ===== 队列积木(desk_blocks 的装配用视图) =====
export interface QueueBlockRow {
  identifier: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  marker: boolean;
  queue_pos: number | null;
  enabled_default: boolean;
}

export interface EffectiveBlock extends QueueBlockRow {
  effEnabled: boolean;
  effPos: number;
}

// recipe.overrides 生效开关/排序:override.enabled 优先于积木自身 enabled_default,override.pos
// 优先于积木自身 queue_pos——只留 in_queue 的积木(queue_pos !== null 是判据,库存备用块不参与装配),
// 按生效开关过滤、按生效顺序升序排。
export function buildEffectiveQueue(
  blocks: QueueBlockRow[],
  overrides: Record<string, { enabled?: boolean; pos?: number }>
): EffectiveBlock[] {
  return blocks
    .filter((b) => b.queue_pos !== null && b.queue_pos !== undefined)
    .map((b) => {
      const ov = overrides?.[b.identifier] || {};
      const effEnabled = ov.enabled !== undefined ? !!ov.enabled : b.enabled_default;
      const effPos = ov.pos !== undefined ? Number(ov.pos) : (b.queue_pos as number);
      return { ...b, effEnabled, effPos };
    })
    .filter((b) => b.effEnabled)
    .sort((a, b) => a.effPos - b.effPos);
}

export function buildOrderedQueue(
  blocks: QueueBlockRow[],
  overrides: Record<string, { enabled?: boolean; pos?: number }>
): EffectiveBlock[] {
  return blocks
    .filter((b) => b.queue_pos !== null && b.queue_pos !== undefined)
    .map((b) => {
      const ov = overrides?.[b.identifier] || {};
      return {
        ...b,
        effEnabled: ov.enabled !== undefined ? !!ov.enabled : b.enabled_default,
        effPos: ov.pos !== undefined ? Number(ov.pos) : (b.queue_pos as number),
      };
    })
    .sort((a, b) => a.effPos - b.effPos);
}

// 以 chatHistory 占位块劈队列——找不到就整队列当 pre(理论上真实预设一定带这个保留字,
// 找不到大概率是测试用的残缺样本,退化成"全当前段"好过直接炸)。
export function splitQueueAtChatHistory<T extends { identifier: string }>(
  queue: T[]
): { pre: T[]; post: T[]; found: boolean } {
  const idx = queue.findIndex((b) => b.identifier === 'chatHistory');
  if (idx === -1) return { pre: queue, post: [], found: false };
  return { pre: queue.slice(0, idx), post: queue.slice(idx + 1), found: true };
}

// ===== 状态板渲染:对象→紧凑结构化文本,不追求花哨,给模型读的不是给人看的排版 =====
export function renderStateBoard(board: Record<string, any> | null | undefined): string {
  if (!board || typeof board !== 'object') return '';
  const keys = Object.keys(board);
  if (!keys.length) return '';
  const lines = keys.map((k) => {
    const v = (board as any)[k];
    const val = Array.isArray(v) ? v.join('、') : (v && typeof v === 'object' ? JSON.stringify(v) : String(v));
    return `${k}: ${val}`;
  });
  return `[状态板]\n${lines.join('\n')}`;
}

// ===== 导演小纸条按深度插入近景楼层；空楼层由调用方在 afterParts 兜底 =====
export function spliceNote(
  floorLines: string[],
  note: string,
  depth: number
): { floorLines: string[]; insertedInFloors: boolean } {
  if (!note || floorLines.length === 0) {
    return { floorLines, insertedInFloors: false };
  }
  const idx = Math.max(0, floorLines.length - depth);
  const out = floorLines.slice();
  out.splice(idx, 0, `[导演小纸条] ${note}`);
  return { floorLines: out, insertedInFloors: true };
}

// ===== assembleDesk:主装配函数(唯一碰 D1/Vectorize 的地方,内部纯逻辑都委托给上面导出的纯函数) =====
export async function assembleDesk(env: DeskAssembleEnv, params: AssembleParams): Promise<any> {
  const project = typeof params.project === 'string' ? params.project.trim() : '';
  const recipeId = typeof params.recipeId === 'string' ? params.recipeId.trim() : '';
  const input = String(params.input || '');
  if (!project) return { success: false, error: 'project 必填' };
  if (!recipeId) return { success: false, error: 'recipeId 必填' };

  const floors = Array.isArray(params.floors) ? params.floors : [];
  const noteDepthRaw = Number(params.noteDepth);
  const noteDepth = Number.isFinite(noteDepthRaw) && noteDepthRaw >= 0 ? noteDepthRaw : 3;
  const stateBoard = params.stateBoard && typeof params.stateBoard === 'object' ? params.stateBoard : {};
  const windowVars: Record<string, string> = params.vars && typeof params.vars === 'object' ? { ...params.vars } : {};

  // D1/Vectorize storage is always the caller's responsibility to construct and inject (see
  // DeskAssembleEnv above) — this module never reaches into examples/cloudflare/ itself.
  const assets = env.deskAssets;
  const story = env.deskStory;
  if (!assets || !story) return { success: false, error: 'Desk assembly storage is not configured.' };
  const semantic = env.semantic;
  let recipe;
  try {
    recipe = await assets.getRecipe(recipeId);
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  if (!recipe) return { success: false, error: '配方不存在' };

  try {
    if (!await assets.hasPreset(recipe.presetId)) return { success: false, error: '配方绑定的预设包不存在' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  const overrides = recipe.overrides;
  const regexIds = recipe.regexIds;

  // {{user}}/{{char}} 优先取 vars.persona/char，缺失时使用通用占位。
  const ctxUser = windowVars.user || windowVars.persona || '你';
  const ctxChar = windowVars.char || '角色';
  const runMacro = (text: string): string => {
    const r = applyMacros(text, { user: ctxUser, char: ctxChar, vars: windowVars });
    Object.assign(windowVars, r.vars); // 变量池随 setvar 按文档序滚动更新,后面的块读得到前面块 set 的值
    return r.text;
  };

  // 上行正则规则(只喂 floors,见 deskMacro.ts 头注释的应用范围铁律)
  let regexRules: DeskRegexRule[] = [];
  if (regexIds.length) {
    try {
      regexRules = await assets.listRegex(regexIds);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // 世界书/角色卡直接读取 memories 本体；category 与 lore_enabled 是入场闸门。
  // ORDER BY id 提供稳定字节序，但不承诺创建顺序；若需要人工顺序应新增 sort_order。
  let loreRows: any[] = [];
  try {
    loreRows = (await assets.listLore(project)).map((entry) => ({ ...entry,
      is_char: entry.isCharacter, trigger_mode: entry.triggerMode }));
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  // content 是注入正本；具名函数统一两个调用点的取值语义。
  const loreContent = (row: any): string => String(row.content || '');

  // Keyword recall follows the same six-floor safety overlap retained by the timeline.
  const scanCorpus = buildLoreScanCorpus(input, floors, DESK_TIMELINE_KEEP);
  const atHitIds = resolveAtMentionIds(input, loreRows.map((row) => ({
    id: String(row.id), name: String(row.name || ''), keys: row.keys || [],
  })));
  const atHit = (row: any): boolean => atHitIds.has(String(row.id));

  const loreHitNames: string[] = [];
  const renderWorldInfo = (position: 'before' | 'after'): string => {
    const hits = loreRows.filter((r) => !r.is_char && r.position === position && (!!r.constant || atHit(r) || matchLoreKeys(scanCorpus, r.keys)));
    const parts: string[] = [];
    for (const h of hits) {
      const raw = loreContent(h);
      const rendered = runMacro(raw);
      if (rendered.trim()) {
        parts.push(rendered);
        loreHitNames.push(h.name);
      }
    }
    return parts.join('\n\n');
  };

  // 酒馆标准角色槽:按在场名单/近景命中角色,有结构化字段就精确投槽；旧卡只有content时仅回退
  // 到Description,绝不把同一整段复制进Personality/Scenario造成重复。
  addMentionedCharactersToPresence(
    stateBoard,
    loreRows.filter((row) => row.is_char && atHit(row)).map((row) => ({
      id: String(row.id), name: String(row.name || ''), keys: row.keys || [],
    })),
  );
  const presenceRaw = (stateBoard || {})['在场角色'] ?? (stateBoard || {}).presence;
  const presenceCorpus = presenceText(presenceRaw);
  // presence 模式只看结构化在场名单；scan 模式另看正文子串，避免单字角色名被散文误触。
  const activeCards = loreRows.filter((c) => {
    if (!c.is_char) return false;
    if (atHit(c)) return true;
    const names = [c.name, ...(c.keys || [])].filter(Boolean);
    if (matchLoreKeys(presenceCorpus, names)) return true;
    if (c.trigger_mode === 'presence') return false;
    return matchLoreKeys(scanCorpus, names);
  });
  const inSceneCardNames = activeCards.map((c) => c.name);
  const renderCharacterField = (field: 'description' | 'personality' | 'scenario' | 'mes_example'): string => {
    const parts: string[] = [];
    for (const card of activeCards) {
      const structured = typeof card.fields?.[field] === 'string' ? card.fields[field] : '';
      const raw = structured || (field === 'description' ? loreContent(card) : '');
      const rendered = runMacro(raw);
      if (rendered.trim()) parts.push(`【${card.name}】\n${rendered}`);
    }
    return parts.join('\n\n');
  };

  const system: Array<{ text: string; cache: boolean }> = [];
  const preBlocksReport: Array<{ identifier: string; name: string; tokensEst: number }> = [];
  const postBlocksReport: Array<{ identifier: string; name: string; tokensEst: number }> = [];
  const preTailParts: string[] = [];
  let postTailParts: string[] = [];
  const roleText = (role: string, text: string): string => {
    if (role === 'user') return text;
    if (role === 'assistant') return `[Assistant message]\n${text}`;
    return `[System instruction]\n${text}`;
  };
  let includeHistory = true;

  if (recipe.weight === 'light') {
    // 轻配方仅使用 light_system，不装配队列。
    const text = runMacro(String(recipe.lightSystem || ''));
    if (text.trim()) {
      system.push({ text, cache: true });
      preBlocksReport.push({ identifier: 'light_system', name: '轻配方system', tokensEst: estTokens(text) });
    }
  } else {
    let rows: QueueBlockRow[] = [];
    try {
      rows = (await assets.listQueueBlocks(recipe.presetId)).map((block) => ({ ...block,
        queue_pos: block.queuePos, enabled_default: block.enabledDefault }));
    } catch (err: any) {
      return { success: false, error: err.message };
    }

    const orderedQueue = buildOrderedQueue(rows, overrides);
    const historyBlock = orderedQueue.find((b) => b.identifier === 'chatHistory');
    includeHistory = historyBlock ? historyBlock.effEnabled : true;
    const split = splitQueueAtChatHistory(orderedQueue);
    const pre = split.pre.filter((b) => b.effEnabled);
    const post = split.post.filter((b) => b.effEnabled);

    const renderBlock = async (b: EffectiveBlock): Promise<string> => {
      if (b.marker) {
        if (b.identifier === 'worldInfoBefore') return renderWorldInfo('before');
        if (b.identifier === 'worldInfoAfter') return renderWorldInfo('after');
        if (b.identifier === 'charDescription') return renderCharacterField('description');
        if (b.identifier === 'charPersonality') return renderCharacterField('personality');
        if (b.identifier === 'scenario') return renderCharacterField('scenario');
        if (b.identifier === 'chatExamples') return renderCharacterField('mes_example');
        if (b.identifier === 'personaDescription') return runMacro(String(windowVars.persona_description || ''));
        // 其余保留字占位块(main 等)原样走宏替换,不做特殊展开
        return runMacro(String(b.content || ''));
      }
      return runMacro(String(b.content || ''));
    };

    let preTailStarted = false;
    for (const b of pre) {
      const text = await renderBlock(b);
      if (text.trim()) {
        // 模型后端没有“历史中途再插一条真 system”的共同合同。稳定前缀里的连续 system 保持顶层；
        // 一旦预设先出现 user/assistant，后续块全部留在 tail 并带角色标签，
        // 至少严格保住 Prompt Manager 的相对顺序，不把后来的system偷提到前面。
        if (b.role === 'system' && !preTailStarted) system.push({ text, cache: true });
        else {
          preTailStarted = true;
          preTailParts.push(roleText(b.role, text));
        }
        preBlocksReport.push({ identifier: b.identifier, name: b.name, tokensEst: estTokens(text) });
      }
    }
    for (const b of post) {
      const text = await renderBlock(b);
      if (text.trim()) {
        postTailParts.push(roleText(b.role, text));
        postBlocksReport.push({ identifier: b.identifier, name: b.name, tokensEst: estTokens(text) });
      }
    }
  }

  // 状态板指令追加在 system 稳定前缀末尾(轻/重两态都要),见文件顶 STATEBOARD_INSTRUCTION 注释
  system.push({ text: STATEBOARD_INSTRUCTION, cache: true });

  // ===== 故事水流：近期章→时光带→近景，中间不插非故事块 =====

  // 剧情核心记忆
  let coreText = '';
  if (includeHistory) {
    try {
      coreText = parseCoreMemory(await story.getState(`desk_core:${project}`));
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // 近期章(先算,供往事区去重——同一章不能既在"近期"又在"往事")
  // 当前篇常驻一章，老篇章走向量召回；按章号自然序选取，不依赖补录时间。
  const RECENT_CHAPTER_COUNT = 1;
  // summary 仅作嵌入检索键，注入优先用 content、为空时回退 summary；单章最多 12000 码点。
  const CHAPTER_INJECT_CAP = 12000;
  const chapterBody = (c: any): string => {
    const body = String(c.content || '').trim() || String(c.summary || '');
    return Array.from(body).slice(0, CHAPTER_INJECT_CAP).join('');
  };
  let recentChapterNos: string[] = [];
  let recentChapterIds = new Set<string>();
  let recentText = '';
  if (includeHistory) try {
    const recentRows = await story.listPublishedChapters(project);
    // 自然序等价时以 created_at、id 稳定决胜；等价章号全部加入去重集合。
    // content/summary 均为空的章节不得占常驻名额。
    const rows = recentRows.slice()
      .filter((r: any) => String(r.content || '').trim() || String(r.summary || '').trim())
      .sort((a: any, b: any) =>
        naturalCompareChapterNo(String(b.chapterNo || ''), String(a.chapterNo || ''))
        || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
        || String(b.id || '').localeCompare(String(a.id || '')));
    const recentSorted = rows.slice(0, RECENT_CHAPTER_COUNT)
      .sort((a: any, b: any) => naturalCompareChapterNo(String(a.chapterNo || ''), String(b.chapterNo || '')));
    recentChapterNos = recentSorted.map((c: any) => c.chapterNo);
    recentChapterIds = new Set(recentSorted.map((c: any) => c.id));
    for (const picked of recentSorted) {
      for (const r of rows) {
        if (naturalCompareChapterNo(String(r.chapterNo || ''), String(picked.chapterNo || '')) === 0) recentChapterIds.add(r.id);
      }
    }
    recentText = recentSorted.map((c: any) => [c.title, chapterBody(c)].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  // 往事区:embed 本楼输入,查 chsum 向量,过滤掉已经在"近期章"里的,过及格线,按章号升序装配
  let pastText = '';
  let recalledChapterNos: string[] = [];
  // 透视用的候选账:过线的、没过线的、被硬顶挤掉的,全列出来带分数——部署者要调及格线,得先看见
  // 真实分布长什么样,不能让她拿拍脑袋的数字盲调(这也是这次改动里最该留下的那部分)。
  const recallCandidates: Array<{ chapterNo: string; score: number; passed: boolean; reason?: string }> = [];
  let recall: RecallSettings = { ...RECALL_DEFAULTS };
  if (includeHistory) {
    try {
      recall = parseRecallSettings(await story.getState(`desk_recall:${project}`));
    } catch (e) {
      // 读设置失败退默认,不为一次 D1 抖动打断装配(同下面向量召回失败的退化口径)
      console.error('[deskAssemble] 读召回设置失败,退默认', e);
    }
  }
  if (includeHistory && input.trim() && semantic && recall.maxChapters > 0) {
    try {
      // 向量候选先过取，完成去重与水合过滤后再截到 topK。
      const fetchK = Math.min(50, Math.max(recall.topK, recall.topK * 2));
      const matches = await semantic.search(input, { limit: fetchK, filter: { project, category: 'chsum' } });
      const scoreById = new Map<string, number>();
      const ids: string[] = [];
      for (const m of matches) {
        const cid = String(m.id).replace(/^chsum_/, '');
        if (recentChapterIds.has(cid)) continue; // 常驻章不许在往事区再出一次
        const prev = scoreById.get(cid);
        // 同一章多条向量时留最高分那条。显式取 max,不靠"入口先按分数排过"这个前提——
        // 那个前提一旦哪天被改掉,这里会静默取到低分那条。
        if (prev !== undefined) { if (m.score > prev) scoreById.set(cid, m.score); continue; }
        scoreById.set(cid, m.score);
        ids.push(cid);
      }
      if (ids.length) {
        const hydrate = await story.getPublishedChapters(ids, project);
        // SQL TRIM 只作粗筛，最终以 JS trim 判断空白。
        const alive = hydrate.slice()
          .filter((r: any) => String(r.content || '').trim() || String(r.summary || '').trim());
        // 取舍按分数(像不像),不按章号——章号只决定最后进剧本的阅读顺序。
        // 并列分数以章号自然序、id 字典序决胜，保证缓存前缀确定。
        const ranked = alive.slice().sort((a: any, b: any) =>
          (scoreById.get(b.id) || 0) - (scoreById.get(a.id) || 0)
          || naturalCompareChapterNo(String(a.chapterNo || ''), String(b.chapterNo || ''))
          || String(a.id || '').localeCompare(String(b.id || '')));
        // 上面过取的部分在这里截掉:真候选池 = 去重+水合之后分数最高的 topK 篇
        const pool = ranked.slice(0, recall.topK);
        const picked: any[] = [];
        for (const r of pool) {
          const score = scoreById.get(r.id) || 0;
          const overLine = score >= recall.minScore;
          const roomLeft = picked.length < recall.maxChapters;
          if (overLine && roomLeft) picked.push(r);
          recallCandidates.push({
            chapterNo: String(r.chapterNo || ''),
            score: Math.round(score * 1000) / 1000, // 报告用三位小数,省得透视里糊一屏浮点尾巴
            passed: overLine && roomLeft,
            ...(overLine ? (roomLeft ? {} : { reason: '超出上限' }) : { reason: '低于及格线' }),
          });
        }
        const sorted = picked.slice()
          .sort((a: any, b: any) => naturalCompareChapterNo(String(a.chapterNo || ''), String(b.chapterNo || '')));
        pastText = sorted.map((c: any) => [c.title, chapterBody(c)].filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
        recalledChapterNos = sorted.map((c: any) => c.chapterNo);
      }
    } catch (e) {
      // 向量召回失败按"往事区空着"退化,不让一次 Vectorize 抖动打断整条装配
      console.error('[deskAssemble] 往事区向量召回失败,按空往事继续', e);
    }
  }

  // 时光带:S3 接入(chat/deskTimeline.ts renderTimelineText 的输出,调用方在拿到真实折叠正文
  // 后传进来);没传/传空串按"这窗还没折过"处理,故事流照样连续,不占位糊弄。
  const timelineText = includeHistory && typeof params.timeline === 'string' ? params.timeline : '';

  // 导演纸条按 noteDepth 插入近景楼层；无楼层时放在 post-blocks 后、状态板前。
  const floorLines = floors.map((f) => {
    const speaker = f.role === 'user' ? ctxUser : ctxChar;
    return `${speaker}：${applyUpRegex(f.content || '', regexRules)}`;
  });
  const noteText = params.note ? runMacro(String(params.note)) : '';
  const spliced = spliceNote(floorLines, noteText, noteDepth);
  const noteInsertedInFloors = spliced.insertedInFloors;
  const floorsText = includeHistory ? spliced.floorLines.join('\n\n') : '';

  const streamParts = includeHistory
    ? [coreText, pastText, recentText, timelineText, floorsText].filter((s) => s && s.trim())
    : [];

  // ===== 故事流之后:配方积木后段 → 导演小纸条(若没插进近景) → 状态板+压轴角色卡 → 本楼输入 =====
  const afterParts: string[] = [...postTailParts];
  if (noteText && (!includeHistory || !noteInsertedInFloors)) afterParts.push(`[导演小纸条] ${noteText}`);

  const stateBoardText = renderStateBoard(stateBoard);
  if (stateBoardText) afterParts.push(stateBoardText);

  afterParts.push(input); // 本楼输入殿后

  const tail = [...preTailParts, ...streamParts, ...afterParts].filter((s) => s && s.trim()).join('\n\n');

  const blocksReport = [...preBlocksReport, ...postBlocksReport];
  const loreHits = Array.from(new Set([...loreHitNames, ...inSceneCardNames]));
  const layers = {
    core: estTokens(coreText),
    past: estTokens(pastText),
    recent: estTokens(recentText),
    timeline: estTokens(timelineText),
    floors: estTokens(floorsText),
    tail: estTokens(tail),
  };
  // 酒馆标准槽体重秤：只报实际装入的内容。chatHistory 对应咱家的完整故事水流；其余标准槽
  // 从已经渲染并入队的积木报告取值，同名槽若异常重复则相加，不拿出厂空壳冒充注入量。
  const standardSlotIds = new Set([
    'worldInfoBefore', 'charDescription', 'charPersonality', 'scenario', 'worldInfoAfter',
    'chatExamples', 'personaDescription',
  ]);
  const standardSlots: Record<string, number> = {};
  for (const b of blocksReport) {
    if (standardSlotIds.has(b.identifier)) standardSlots[b.identifier] = (standardSlots[b.identifier] || 0) + b.tokensEst;
  }
  if (includeHistory) standardSlots.chatHistory = estTokens(streamParts.join('\n\n'));
  const systemChars = system.reduce((n, s) => n + s.text.length, 0);
  const totalEst = Math.ceil((systemChars + tail.length) / 3);

  return {
    success: true,
    system,
    tail,
    report: {
      blocks: blocksReport,
      loreHits,
      recalledChapters: recalledChapterNos,
      recallCandidates, // 全部候选(含落选的)+分数,给部署者调及格线用
      recallSettings: recall,
      recentChapters: recentChapterNos,
      layers,
      standardSlots,
      totalEst,
    },
  };
}

// ===== POST /api/oc/desk/dryrun:裸看装配结果,不调模型 =====
export async function deskDryrun(env: DeskAssembleEnv, body: any): Promise<any> {
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };
  const project = body.project;
  const recipeId = body.recipe_id;
  const input = body.input;
  if (typeof project !== 'string' || !project.trim()) return { success: false, error: 'project 必填' };
  if (typeof recipeId !== 'string' || !recipeId.trim()) return { success: false, error: 'recipe_id 必填' };
  if (typeof input !== 'string') return { success: false, error: 'input 必须是字符串' };

  return assembleDesk(env, {
    project,
    recipeId,
    input,
    floors: Array.isArray(body.floors) ? body.floors : [],
    note: typeof body.note === 'string' ? body.note : '',
    noteDepth: body.note_depth,
    stateBoard: body.state_board && typeof body.state_board === 'object' ? body.state_board : {},
    vars: body.vars && typeof body.vars === 'object' ? body.vars : {},
    // S3 接入后 dryrun 也能裸看时光带拼接位置(可选,不给就当没折过);真实折叠正文来自
    // chat/deskTimeline.ts renderTimelineText,这里只透传字符串,不在 dryrun 里现跑折叠。
    timeline: typeof body.timeline === 'string' ? body.timeline : '',
  });
}
