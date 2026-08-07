// src/tools/desk.ts
// 打字桌预设、正则、世界书导入与列表数据层。
// 表结构定稿在 schema/oc_migration_003_desk.sql(工单§2),业务口径见工单§4 S1。
//
// 家法照抄 study.ts 头注释那套:id 生成 `${prefix}_${Date.now()}_${rand}`,请求体解析用
// `.catch(()=>null)` 兜底非法 JSON,响应统一 {success:true,...} / {success:false,error}。
//
// ⚠️预设包不可变(工单§0铁律6):每次 import/preset = 一个新包,绝不覆盖旧包;配方以后钉在具体
//   包 id 上,新版另导新包,两版并存,S1 不做"认版本"这种聪明事。
// ⚠️凭据洗盘铁律(工单§0铁律3):import/settings 只许摘录白名单里明确列出的字段,任何候选字段名
//   先过 POISON_KEY_RE(key/token/secret/password/credential 模式)才敢碰——样本 horae 配置里躺过
//   明文 Gemini key(autoSummaryApiKey),这条闸是有前科的真实红线,不是防御性编程凑数。
//
// 纯解析函数(parsePresetBlocks/parsePresetRegex/parsePresetParams/parseGlobalRegex/
// parseRegexWhitelist/parseHoraeTemplates/splitRegexLiteral/classifyDirection/deepScrub/
// validateRegexFlags)故意写成不碰D1/env、只吃/吐普通对象——verify_desk_import.mjs 直接复制
// 这几个函数体对着真实样本跑计数,两边必须是同一份逻辑,改这里记得把验证脚本也搬一遍。

import { upsertVector } from '../storage/vectorize';
import type { Ai, VectorizeIndex } from '../storage/vectorize';
import { isPatternUnsafe } from '../shared/regexSafety';
import { embedMemory } from './study';
import type { CharacterCard } from '../core/characterCard';

interface DeskEnv {
  OC_DB: D1Database;
  OC_VECTORIZE: VectorizeIndex;
  AI: Ai;
}

const POISON_KEY_RE = /key|token|secret|password|credential/i;

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function safeJsonStringify(v: any): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return '{}';
  }
}

// 导入器 400 必须指出具体字段与实际类型。
// 只给已经存在的硬校验失败换措辞用的小料,不新增校验闸(工单原话:只改报错文案质量,不放宽任何
// 校验——同理也不趁手加新的拒收条件,免得把过去能导进来的边缘形状意外锁死)。
function describeType(v: any): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// 凭据洗盘铁律的第二道闸(defense-in-depth,不是唯一防线):递归扫任意 JSON 值,键名撞上
// POISON_KEY_RE 的一律把值换成 '[scrubbed]'(只认键名,不认内容——block content 这类字段
// 键名本身不是敏感词,原样放行)。depth>50 的子树**整棵换成打码标记**——放行会给"埋在第51层的
// 深度限制必须覆盖对象 key，正常预设不会触及该上限。
export function deepScrub(value: any, depth = 0): { value: any; scrubbed: number } {
  if (depth > 50) return { value: '[scrubbed:depth]', scrubbed: 1 };
  if (Array.isArray(value)) {
    let scrubbed = 0;
    const out = value.map((v) => {
      const r = deepScrub(v, depth + 1);
      scrubbed += r.scrubbed;
      return r.value;
    });
    return { value: out, scrubbed };
  }
  if (value && typeof value === 'object') {
    let scrubbed = 0;
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (POISON_KEY_RE.test(k)) {
        out[k] = '[scrubbed]';
        scrubbed++;
      } else {
        const r = deepScrub(v, depth + 1);
        scrubbed += r.scrubbed;
        out[k] = r.value;
      }
    }
    return { value: out, scrubbed };
  }
  return { value, scrubbed: 0 };
}

// ===== 正则字面量拆分:ST 的 findRegex 常是 "/pattern/flags" 这种 JS 正则字面量整串字符串,
// desk_regex 表 find/flags 是分开两列,这里按"首尾斜杠"拆开(flags 只能是合法正则修饰符,
// 不然说明这根本不是字面量格式,原样整串存进 find、flags 留空,不瞎猜)。=====
export function splitRegexLiteral(literal: any): { find: string; flags: string } {
  const s = String(literal || '');
  if (s.length >= 2 && s[0] === '/') {
    const lastSlash = s.lastIndexOf('/');
    if (lastSlash > 0) {
      const flags = s.slice(lastSlash + 1);
      if (/^[a-z]*$/i.test(flags)) {
        return { find: s.slice(1, lastSlash), flags };
      }
    }
  }
  return { find: s, flags: '' };
}

// ST 正则脚本的 promptOnly/markdownOnly 两个独立布尔位→咱家 direction 三选一:
// 只 promptOnly=上行(节食);只 markdownOnly=下行(美化);两者都开(样本主流)或都不开
// (ST 语义="不限",两处都跑)统一按 both 落库——都不开不是"哪儿都不生效"。
export function classifyDirection(promptOnly: boolean, markdownOnly: boolean): 'up' | 'down' | 'both' {
  if (promptOnly && !markdownOnly) return 'up';
  if (markdownOnly && !promptOnly) return 'down';
  return 'both';
}

// ===== 预设包解析 =====

export interface ParsedBlock {
  identifier: string;
  name: string;
  role: string;
  content: string;
  marker: boolean;
  injection: Record<string, any>;
  in_queue: boolean;
  queue_pos: number | null;
  enabled_default: boolean;
}

// prompts 数组(积木库全量,identifier 是 UUID 或 main/worldInfoBefore 等保留字)+ prompt_order
// (数组,每份是某个角色/群各自的队列)。⚠️只认 prompt_order 的第一份——SillyTavern 每次对话
// 只会套用"当前角色"对应的那一份 order,取多份 order 的并集在语义上是错的(那是把从没同框过的
// 几个角色的队列拼一起,现实里 ST 从不会这么跑)。若这份预设带了不止一份 order,多出来的份数
// 记进返回值的 ignoredOrders,调用方(deskImportPreset)决定要不要提醒部署者。
// 队列 order 条目的 enabled 独立于积木默认 enabled，导入时必须尊重前者。
// 26条不一致)——上架块的默认开关态用 order 条目的 enabled(队列内override优先),没上架的
// 备用库块用积木自身 enabled。这就是"库⊃队列两层"要保留的东西,别拿积木自身 enabled 一刀切。
export function parsePresetBlocks(raw: any): { blocks: ParsedBlock[]; ignoredOrders: number } {
  const prompts = Array.isArray(raw?.prompts) ? raw.prompts : [];
  const orders = Array.isArray(raw?.prompt_order) ? raw.prompt_order : [];
  const ignoredOrders = orders.length > 1 ? orders.length - 1 : 0;
  const firstOrder = orders.length > 0 ? orders[0] : null;

  // queue_pos = 第一份 order 内部出现顺序的下标,用显式计数器而不是 Map.size——
  // 去重跳过重复 identifier 时 Map.size 不会同步递增,拿它当下标会错位)
  const queuePos = new Map<string, number>();
  const queueEnabled = new Map<string, boolean>();
  let idx = 0;
  const order = Array.isArray(firstOrder?.order) ? firstOrder.order : [];
  for (const o of order) {
    if (!o || typeof o.identifier !== 'string') continue;
    if (queuePos.has(o.identifier)) continue;
    queuePos.set(o.identifier, idx++);
    queueEnabled.set(o.identifier, !!o.enabled);
  }

  const blocks = prompts
    .filter((p: any) => p && typeof p.identifier === 'string')
    .map((p: any) => {
      const identifier = p.identifier;
      const inQueue = queuePos.has(identifier);
      return {
        identifier,
        name: String(p.name || ''),
        role: String(p.role || 'system'),
        content: String(p.content || ''),
        marker: !!p.marker,
        injection: {
          injection_position: p.injection_position ?? null,
          injection_depth: p.injection_depth ?? null,
          injection_order: p.injection_order ?? null,
          forbid_overrides: !!p.forbid_overrides,
          system_prompt: !!p.system_prompt,
        },
        in_queue: inQueue,
        queue_pos: inQueue ? (queuePos.get(identifier) as number) : null,
        enabled_default: inQueue ? !!queueEnabled.get(identifier) : !!p.enabled,
      };
    });

  return { blocks, ignoredOrders };
}

export interface ParsedRegex {
  ext_id: string;
  name: string;
  find: string;
  replace: string;
  flags: string;
  direction: 'up' | 'down' | 'both';
  enabled: boolean;
  meta: Record<string, any>;
}

// 内嵌 extensions.regex_scripts(preset scope,独立 id + disabled 标)
export function parsePresetRegex(raw: any): ParsedRegex[] {
  const scripts = Array.isArray(raw?.extensions?.regex_scripts) ? raw.extensions.regex_scripts : [];
  return parseRegexScripts(scripts);
}

// settings.json 的 extension_settings.regex(global scope,同款字段形状)
export function parseGlobalRegex(raw: any): ParsedRegex[] {
  const scripts = Array.isArray(raw?.extension_settings?.regex) ? raw.extension_settings.regex : [];
  return parseRegexScripts(scripts);
}

// 合法正则修饰符白名单(ES2024):dgimsuvy,不许重复,u/v 不能同开(两者语义互斥)
function validateRegexFlags(flags: string): string | null {
  for (const c of flags) {
    if (!'dgimsuvy'.includes(c)) return `非法正则修饰符: ${c}`;
  }
  if (new Set(flags).size !== flags.length) return '正则修饰符重复';
  if (flags.includes('u') && flags.includes('v')) return 'u 和 v 修饰符不能同时使用';
  return null;
}

function parseRegexScripts(scripts: any[]): ParsedRegex[] {
  return scripts
    .filter((r: any) => r && typeof r.id === 'string')
    .map((r: any) => {
      const { find, flags } = splitRegexLiteral(r.findRegex);

      // 校验只为确认这条正则能不能编译,构造出来的 RegExp 绝不拿去跑任何输入;
      // 校验不过不拒绝整个导入,原样存进库但摁灭(enabled=0)+ meta 记原因,导入照常成功。
      let invalidReason = validateRegexFlags(flags);
      if (!invalidReason) {
        try {
          new RegExp(find, flags);
        } catch (e: any) {
          invalidReason = String(e?.message || '正则编译失败');
        }
      }
      // 编译得过才谈得上"形状疑似灾难性回溯"——编译不过已经摁灭了,不需要再判一次。
      const unsafe = !invalidReason && isPatternUnsafe(find);
      const enabled = (invalidReason || unsafe) ? false : !r.disabled;

      const metaRaw: Record<string, any> = {
        ext_id: r.id, // 冗余存一份进 meta,desk_regex 没有独立 ext_id 列,查重/回链全靠这个
        runOnEdit: !!r.runOnEdit,
        placement: Array.isArray(r.placement) ? r.placement.filter((x: any) => typeof x === 'number') : [],
        substituteRegex: Number(r.substituteRegex) || 0,
        minDepth: typeof r.minDepth === 'number' ? r.minDepth : null,
        maxDepth: typeof r.maxDepth === 'number' ? r.maxDepth : null,
        trimStrings: Array.isArray(r.trimStrings) ? r.trimStrings.filter((x: any) => typeof x === 'string') : [],
      };
      if (invalidReason) {
        metaRaw.invalid = true;
        metaRaw.invalid_reason = invalidReason;
      } else if (unsafe) {
        metaRaw.unsafe = true;
        metaRaw.invalid_reason = '疑似灾难性回溯形状';
      }
      // defense-in-depth:哪怕上面的形状校验漏了什么,meta 落库前再过一遍键名扫描
      const meta = deepScrub(metaRaw).value;

      return {
        ext_id: r.id,
        name: String(r.scriptName || ''),
        find,
        replace: String(r.replaceString || ''),
        flags,
        direction: classifyDirection(!!r.promptOnly, !!r.markdownOnly),
        enabled,
        meta,
      };
    });
}

// 顶层采样参数(部署者说"temperature 等"——固定白名单,别把整个顶层对象倒进去,
// 那里面混着一堆跟"这个包怎么采样"无关的客户端 UI 状态,params 这一列只该装真正影响生成的旋钮)
const SAMPLER_PARAM_KEYS = [
  'temperature', 'frequency_penalty', 'presence_penalty',
  'top_p', 'top_k', 'top_a', 'min_p', 'repetition_penalty',
];
export function parsePresetParams(raw: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of SAMPLER_PARAM_KEYS) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  return out;
}

// ===== settings.json 白名单摘录(凭据洗盘铁律核心) =====

// 形状硬校验,别把整个对象囫囵倒进落库结果——只留 {预设名: string[]} 这一种形状,
// 值不是数组的整条丢,数组里混进的非字符串项(数字/对象/嵌套结构)逐个丢。
export function parseRegexWhitelist(raw: any): Record<string, string[]> {
  const wl = raw?.extension_settings?.preset_allowed_regex;
  const out: Record<string, string[]> = {};
  if (!wl || typeof wl !== 'object') return out;
  for (const [k, v] of Object.entries(wl)) {
    if (POISON_KEY_RE.test(k)) continue; // 毒名键整条拒收——{"apiKey":["secret"]}这种形状合法但名字有毒的不接
    if (!Array.isArray(v)) continue;
    out[k] = v.filter((item: any) => typeof item === 'string');
  }
  return out;
}

// Horae 自动总结相关的几个 prompt 模板字段——固定白名单(不是"所有以Prompt结尾的字段",
// horae 配置里还混着 customTablesPrompt/customRpgPrompt 等 RPG 面板用的模板,跟"自动总结"无关,
// 工单只要"Horae auto-summary prompt template(s)",按名字圈定这五个自动总结管线相关的)。
// 空字符串表示使用内置模板，不应被误判为缺字段。
// 落库仍然如实存空值,S2/S3 真用到时再看是不是要接 horae 的内置默认文案。
const HORAE_TEMPLATE_KEYS = [
  'customSystemPrompt', 'customBatchPrompt', 'customAnalysisPrompt',
  'customCompressPrompt', 'customAutoSummaryPrompt',
];
export function parseHoraeTemplates(raw: any): Record<string, string> {
  const horae = raw?.extension_settings?.horae;
  const out: Record<string, string> = {};
  if (!horae || typeof horae !== 'object') return out;
  for (const k of HORAE_TEMPLATE_KEYS) {
    if (POISON_KEY_RE.test(k)) continue; // 防御性双保险:哪怕白名单手滑混进敏感名也拦一道
    const v = horae[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// ===== import/preset =====

export async function deskImportPreset(env: DeskEnv, raw: any, nameOverride?: string): Promise<any> {
  if (!raw || typeof raw !== 'object') {
    return { success: false, error: `请求体不是合法的预设JSON对象——读到的类型是 ${describeType(raw)}` };
  }
  if (raw.prompts === undefined) {
    return { success: false, error: '不是合法的酒馆预设——缺 prompts 字段(ST预设文件顶层必带的积木数组)' };
  }
  if (!Array.isArray(raw.prompts)) {
    return { success: false, error: `不是合法的酒馆预设——prompts 字段类型不对,应该是数组,实际收到的是 ${describeType(raw.prompts)}` };
  }

  const { blocks, ignoredOrders } = parsePresetBlocks(raw);
  const regex = parsePresetRegex(raw);
  const params = parsePresetParams(raw);

  // 落库前拦重复 identifier(desk_blocks 有 UNIQUE(preset_id, identifier),等 D1 报错才发现太晚)
  const seenIdentifiers = new Set<string>();
  for (const b of blocks) {
    if (seenIdentifiers.has(b.identifier)) {
      return { success: false, error: `预设 prompts 里有重复 identifier: ${b.identifier}` };
    }
    seenIdentifiers.add(b.identifier);
  }

  const id = genId('pk');
  const now = new Date().toISOString();
  const name = (typeof nameOverride === 'string' && nameOverride.trim())
    ? nameOverride.trim()
    : (typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'preset');

  // 洗盘铁律第二道闸:raw_json 落库前先过 deepScrub,键名撞上敏感词的值一律抹掉
  const { value: scrubbedRaw, scrubbed: scrubbedCount } = deepScrub(raw);

  // sort_order 从现有全表最大值后连续分配。
  // 按 parsePresetRegex 输出的数组序(=extensions.regex_scripts 的声明序)递增编号——RegexTab
  // 按来源分组展示时,组内顺序要忠于预设作者原意,不是D1返回行的随机序或后来乱插的号。
  // MAX 后分配存在并发窗口；当前单人导入合同不做全局串行化。
  // 同时命中理论上能算出同一个base、撞出重叠的sort_order号段——跟工单§6"章向量写入全串行化
  // 不做"同一族比例裁定:单人档两手同时点导入的概率≈0,为它上事务化号段分配(悲观锁/版本号)
  // 比例失衡,不做。撞号的最坏后果只是"两批正则的展示序偶然交叉",不影响装配正确性(装配靠
  // enabled+direction过滤,不靠sort_order连续),部署者发现了在RegexTab里拖一下就重新理顺。
  let regexSortBase = 0;
  if (regex.length > 0) {
    try {
      const maxRow = await env.OC_DB.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM desk_regex`).first<any>();
      regexSortBase = Number(maxRow?.m || 0);
    } catch { /* 查不到就从0起,不阻断导入——sort_order只管展示/装配顺序,起点保守不影响正确性 */ }
  }

  const stmts = [
    env.OC_DB.prepare(
      `INSERT INTO desk_presets (id, name, raw_json, params, block_count, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, name, JSON.stringify(scrubbedRaw), safeJsonStringify(params), blocks.length, now),
  ];

  for (const b of blocks) {
    stmts.push(
      env.OC_DB.prepare(
        `INSERT INTO desk_blocks (id, preset_id, identifier, name, role, content, marker, injection, in_queue, queue_pos, enabled_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        `${id}:${b.identifier}`, id, b.identifier, b.name, b.role, b.content,
        b.marker ? 1 : 0, safeJsonStringify(b.injection),
        b.in_queue ? 1 : 0, b.queue_pos, b.enabled_default ? 1 : 0
      )
    );
  }
  regex.forEach((r, i) => {
    stmts.push(
      env.OC_DB.prepare(
        `INSERT INTO desk_regex (id, scope, preset_id, name, find, replace, flags, direction, enabled, meta, sort_order)
         VALUES (?, 'preset', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(genId('rx'), id, r.name, r.find, r.replace, r.flags, r.direction, r.enabled ? 1 : 0, safeJsonStringify(r.meta), regexSortBase + (i + 1) * 10)
    );
  });

  // D1 batch() 硬顶 1000 条语句/次(付费档预算),900留安全线,别顶到红线才报错
  if (stmts.length > 900) {
    return { success: false, error: '积木+正则超过900条,超出单批安全线(付费档D1上限1000/批)' };
  }

  try {
    await env.OC_DB.batch(stmts);
  } catch (err: any) {
    return { success: false, error: err.message, server: true };
  }

  const inQueueCount = blocks.filter((b) => b.in_queue).length;
  const result: any = {
    success: true,
    id,
    name,
    block_count: blocks.length,
    in_queue_count: inQueueCount,
    library_only_count: blocks.length - inQueueCount,
    regex_count: regex.length,
    params,
    created_at: now,
    scrubbed_count: scrubbedCount,
  };
  if (ignoredOrders > 0) {
    result.warning = `预设带${ignoredOrders + 1}份prompt_order,只认第一份`;
  }
  return result;
}

// ===== import/settings =====

export async function deskImportSettings(env: DeskEnv, raw: any): Promise<any> {
  if (!raw || typeof raw !== 'object') {
    return { success: false, error: `请求体不是合法的settings JSON对象——读到的类型是 ${describeType(raw)}` };
  }

  const globalRegex = parseGlobalRegex(raw);
  const whitelist = parseRegexWhitelist(raw);
  const templates = parseHoraeTemplates(raw);
  const now = new Date().toISOString();

  // sort_order 基线取全表当前最大值。
  // DELETE 之前查(见下方 stmts 里那条 DELETE),这样重复导入 settings 不会跟预设正则的号段打架,
  // 新一批全局正则的相对顺序仍按 extension_settings.regex 数组声明序,不因为整套替换被打乱。
  // ⚠️F3裁决(同 deskImportPreset 头上那条注释):MAX查询和批量插入之间的并发窗口不做事务化
  // 分配,与工单§6"章向量写全串行化不做"同族比例裁定,单人档撞号概率≈0,详见上方。
  let regexSortBase = 0;
  if (globalRegex.length > 0) {
    try {
      const maxRow = await env.OC_DB.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM desk_regex`).first<any>();
      regexSortBase = Number(maxRow?.m || 0);
    } catch { /* 查不到就从0起,同 deskImportPreset 的兜底口径 */ }
  }

  // 全局正则曾经只从 settings 导入产生,天然是"替换整套"的语义——先清空 scope='global' 再插新集合,
  // 同一个原子 batch 里做,保证重复导入幂等(不会每次都堆出重复行)。
  // R3案4追加:scope='global' 现在住着两族血统不同的正则——①这里的 settings 家的(没有
  // meta.origin 标记) ②多合一正则合集导入的(meta.origin='bundle',按各自 st_id 单独幂等替换,
  // 见 deskImportRegexBundle)。settings 的"整套替换"语义只该清自己家那批,合集行不是 settings
  // 导入产生的,不该被这一刀带着陪葬——豁免 origin='bundle' 的行,旧 settings 正则(没有这个标记)
  // 照删不误(它们本来就是这次要被整套替换的对象)。
  // json_extract 遇 malformed JSON 会抛错，查询必须先用 json_valid 守门。
  // safeJsonStringify不会产坏meta,但一条历史/人工脏meta行就能让settings整套替换回归500。
  // meta IS NULL OR NOT json_valid(meta) 两条短路在前,坏meta行判定为"没有合法的bundle血统标记"
  // 按settings家处理照删(它本来就不是可辨认的bundle行,删了不算误伤)——短路求值保证一旦命中
  // 这两条,后面的json_extract压根不会被求值,不会因为它去炸SQL。
  const stmts: any[] = [
    env.OC_DB.prepare(`DELETE FROM desk_regex WHERE scope = 'global' AND (meta IS NULL OR NOT json_valid(meta) OR COALESCE(json_extract(meta, '$.origin'), '') != 'bundle')`),
  ];
  globalRegex.forEach((r, i) => {
    stmts.push(
      env.OC_DB.prepare(
        `INSERT INTO desk_regex (id, scope, preset_id, name, find, replace, flags, direction, enabled, meta, sort_order)
         VALUES (?, 'global', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(genId('rx'), r.name, r.find, r.replace, r.flags, r.direction, r.enabled ? 1 : 0, safeJsonStringify(r.meta), regexSortBase + (i + 1) * 10)
    );
  });
  stmts.push(
    env.OC_DB.prepare(`INSERT OR REPLACE INTO oc_state (key, value, updated_at) VALUES ('desk_regex_whitelist', ?, ?)`)
      .bind(safeJsonStringify(whitelist), now)
  );
  stmts.push(
    env.OC_DB.prepare(`INSERT OR REPLACE INTO oc_state (key, value, updated_at) VALUES ('desk_horae_templates', ?, ?)`)
      .bind(safeJsonStringify(templates), now)
  );

  // 三口导入共用同一条900条安全线(付费档D1上限1000/批),别只护着preset口
  if (stmts.length > 900) {
    return { success: false, error: '全局正则超过900条,超出单批安全线(付费档D1上限1000/批)' };
  }

  try {
    await env.OC_DB.batch(stmts);
  } catch (err: any) {
    return { success: false, error: err.message, server: true };
  }

  return {
    success: true,
    global_regex_count: globalRegex.length,
    whitelist,
    horae_template_keys: Object.keys(templates),
  };
}

// ===== import/regex(R3案4:酒馆社区"多合一正则"导出格式)=====
// 顶层就是一个数组,每项是ST正则脚本对象,字段形状跟 extensions.regex_scripts / extension_settings.regex
// 完全一样(id/scriptName/findRegex/replaceString/trimStrings/placement/disabled/markdownOnly/promptOnly/
// runOnEdit/substituteRegex/minDepth/maxDepth)——复用同一套 parseRegexScripts 清洗/归一化管线
// (splitRegexLiteral解字面量/classifyDirection定上下行/validateRegexFlags/isPatternUnsafe/deepScrub凭据
// 洗盘),不另起一套平行清洗(工单原话)。
export interface ParsedRegexBundleItem extends ParsedRegex {
  st_id: string; // = ext_id,冗余一份专属字段名,配合落库的按st_id替换式幂等语义,读起来更直白
}

// 纯函数(同文件头注释那条家法,不碰D1/env):验收脚本直接拿这个函数对着日月西真样本跑,不连库。
export function parseRegexBundle(raw: any): (
  | { ok: true; parsed: ParsedRegexBundleItem[]; skipped: { name: string; reason: string }[]; scrubbed_count: number }
  | { ok: false; error: string }
) {
  if (!Array.isArray(raw)) {
    return { ok: false, error: `不是合法的正则合集——顶层必须是数组,实际收到的是 ${describeType(raw)}` };
  }
  if (raw.length === 0) {
    return { ok: false, error: '正则合集是空数组——没有可导入的正则脚本' };
  }

  const skipped: { name: string; reason: string }[] = [];
  const goodItems: any[] = [];
  let scrubbedCount = 0;
  raw.forEach((item: any, i: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      skipped.push({ name: `第${i + 1}条`, reason: `不是合法的正则脚本对象,实际收到的是 ${describeType(item)}` });
      return;
    }
    if (typeof item.id !== 'string' || !item.id) {
      skipped.push({ name: String(item.scriptName || `第${i + 1}条`), reason: '缺 id 字段(或类型不对)——按id幂等替换需要这个字段' });
      return;
    }
    // 凭据洗盘计数(照preset口收据惯例,defense-in-depth统计):对原始整项扫一遍敏感键名,这个数字
    // 只进收据展示——真正落库用的字段仍是下面 parseRegexScripts 已经清洗过的 meta,不依赖这次扫描。
    scrubbedCount += deepScrub(item).scrubbed;
    goodItems.push(item);
  });

  const parsedBase = parseRegexScripts(goodItems);
  const parsed: ParsedRegexBundleItem[] = parsedBase.map((r) => ({
    ...r,
    st_id: r.ext_id,
    meta: { ...r.meta, origin: 'bundle', st_id: r.ext_id },
  }));

  // 同批合集出现重复 st_id 时必须拒绝，不能猜测覆盖顺序。
  // 静默归并——落库语义是"每条先DELETE同st_id旧行再INSERT",批内重复st_id会导致同一批内后一条的
  // DELETE把同批前一条刚INSERT的行删掉,最终落库行数比收据报的imported_count少,回执与库不符
  // (家法:收据永不说谎)。宁可整批拒收,点名哪些st_id重复+各自的scriptName,让部署者看清楚是不是
  // 手工拼接多合一文件时不小心贴重了一条,去重后重新导入——不做静默归并这种"聪明"事。
  const st_idNames = new Map<string, string[]>();
  for (const r of parsed) {
    const names = st_idNames.get(r.st_id) || [];
    names.push(r.name || '(无名)');
    st_idNames.set(r.st_id, names);
  }
  const dupes = Array.from(st_idNames.entries()).filter(([, names]) => names.length > 1);
  if (dupes.length > 0) {
    const detail = dupes.map(([id, names]) => `${id}(${names.join('、')})`).join('；');
    return { ok: false, error: `同一份合集里出现重复id：${detail}——文件可能是手工拼接的,去重后再导` };
  }

  return { ok: true, parsed, skipped, scrubbed_count: scrubbedCount };
}

// R3案2追加(部署者拍板):导入可以选"挂到哪"——不给 targetPresetId 照旧落 scope='global'(见窗
// 就上妆);给了就落 scope='preset'+preset_id=目标包(只在用该预设的窗生效,跟着配方走,下行
// 渲染端不用改——preset-scoped规则本来就已经按窗口配方的preset过滤,S5b机制原样吃这个新来源)。
export async function deskImportRegexBundle(env: DeskEnv, raw: any, targetPresetId?: string): Promise<any> {
  const parsedResult = parseRegexBundle(raw);
  if (!parsedResult.ok) return { success: false, error: parsedResult.error };
  const { parsed, skipped, scrubbed_count } = parsedResult;

  // target_preset_id 校验(工单原话"字符串,校验包存在,不存在明拒点名")——空串/未传都按"没挂,
  // 走全局"处理,不当错误;给了非空值就必须真实存在,不存在直接拒收,不静默退化成全局(那会让
  // 部署者以为挂上了其实落进了别处)。
  const trimmedTarget = typeof targetPresetId === 'string' ? targetPresetId.trim() : '';
  if (trimmedTarget) {
    try {
      const preset = await env.OC_DB.prepare(`SELECT id FROM desk_presets WHERE id = ?`).bind(trimmedTarget).first<any>();
      if (!preset) return { success: false, error: `target_preset_id 不存在: ${trimmedTarget}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  if (parsed.length === 0) {
    return {
      success: false,
      error: `这份正则合集里${Array.isArray(raw) ? raw.length : 0}条全部解析失败,没有一条能导入——${skipped.map((s) => `${s.name}: ${s.reason}`).join('；')}`,
    };
  }

  // sort_order基线同 deskImportPreset/deskImportSettings 口径:接全表当前MAX往后编号,新一批的
  // 相对顺序照合集数组声明序,不跟其他来源的正则号段相撞。F3并发窗口裁定同款不做事务化(§4″同族)。
  let regexSortBase = 0;
  try {
    const maxRow = await env.OC_DB.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM desk_regex`).first<any>();
    regexSortBase = Number(maxRow?.m || 0);
  } catch { /* 查不到就从0起,同其余两口导入器的兜底口径 */ }

  // 按st_id替换式幂等(工单裁定),R3案2追加"兼顾搬家":同一个原子batch内,每条正则先发一条按
  // st_id匹配的DELETE,再发一条INSERT——重复导入同一份合集不堆重复行。DELETE条件按这次导入
  // 挂不挂预设包分两种:
  //   ①没给targetPresetId(导全局):跟以前一样只清 scope='global' 的旧行。
  //   ②给了targetPresetId(挂某包):必须同时清 scope='global' 的旧行**和**
  //     scope='preset' AND preset_id=目标包 的旧行——部署者的真实场景是"已经导成全局的日月西,
  //     现在想重导搬家到某个包下",若DELETE只认scope='preset'这一半,老的全局行会跟新插的
  //     preset行同时存在,堆成两份(装配时全局那份还在生效,搬家等于白搬)。只清"全局"+"这个
  //     目标包"两处,不碰别的包(preset A→preset B迁移不在这次拍板范围内,不做,免得跨包乱删)。
  // 对历史 malformed JSON 先用 json_valid 守门。
  // 写入路径全走safeJsonStringify不会产坏meta,但库里若躺着一条历史/人工污染的脏meta行,这一句
  // 就能让整个bundle导入回归500。加 meta IS NOT NULL AND json_valid(meta) 双重守卫短路掉——
  // 脏meta行反正不可能是合法的bundle行(st_id提取不出来),天然匹配不上,守卫只是防它把SQL引擎
  // 本身炸掉,不改变"这行会不会被删"的语义。
  // 不加 FK 重建表；导入时用条件写入保证挂靠目标仍存在。
  // 比例失衡"裁定不做,这里用条件写入代替,同deskPresetDelete/deskRecipeCreate的NOT EXISTS/
  // WHERE EXISTS先例):原实现只在批前查一次"target_preset_id存不存在"当快照校验——查完到
  // batch()真正执行这段窗口里,这个包可以被另一个并发请求(deskPresetDelete)删掉,而
  // DELETE(清旧全局行)和INSERT(插新preset行)都不知道这件事照常执行,结果=旧全局行被删了、
  // 新行却插向一个刚消失的幽灵包,规则实质上凭空消失且无从查起。修法:target给定时,批内**每条
  // DELETE和每条INSERT都焊EXISTS(SELECT 1 FROM desk_presets WHERE id=?target)守卫**,让
  // "目标包此刻还在不在"这件事在每条语句真正执行的瞬间被复核,不是信batch()调用前的一次查询
  // 快照。包若中途消失,这批语句全部因EXISTS为假而collectively no-op——旧的全局行原封不动
  // (DELETE没执行),不会插出孤儿行(INSERT没执行)。没给target的全局分支不涉及这个竞态
  // (scope='global'不依赖任何预设包是否存在),行为不变,不额外加EXISTS。
  const deleteSql = trimmedTarget
    ? `DELETE FROM desk_regex WHERE meta IS NOT NULL AND json_valid(meta) AND json_extract(meta, '$.st_id') = ? AND (scope = 'global' OR (scope = 'preset' AND preset_id = ?)) AND EXISTS (SELECT 1 FROM desk_presets WHERE id = ?)`
    : `DELETE FROM desk_regex WHERE scope = 'global' AND meta IS NOT NULL AND json_valid(meta) AND json_extract(meta, '$.st_id') = ?`;
  const insertSql = trimmedTarget
    ? `INSERT INTO desk_regex (id, scope, preset_id, name, find, replace, flags, direction, enabled, meta, sort_order)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM desk_presets WHERE id = ?)`
    : `INSERT INTO desk_regex (id, scope, preset_id, name, find, replace, flags, direction, enabled, meta, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const scope = trimmedTarget ? 'preset' : 'global';
  const presetIdForInsert = trimmedTarget || null;

  const stmts: any[] = [];
  parsed.forEach((r, i) => {
    stmts.push(
      trimmedTarget
        ? env.OC_DB.prepare(deleteSql).bind(r.st_id, trimmedTarget, trimmedTarget)
        : env.OC_DB.prepare(deleteSql).bind(r.st_id)
    );
    const insertValues = [genId('rx'), scope, presetIdForInsert, r.name, r.find, r.replace, r.flags, r.direction, r.enabled ? 1 : 0, safeJsonStringify(r.meta), regexSortBase + (i + 1) * 10];
    stmts.push(
      trimmedTarget
        ? env.OC_DB.prepare(insertSql).bind(...insertValues, trimmedTarget)
        : env.OC_DB.prepare(insertSql).bind(...insertValues)
    );
  });

  // 900条批量线照旧(付费档D1上限1000/批)——每条正则占两条语句(DELETE+INSERT),门槛按语句数算
  if (stmts.length > 900) {
    return { success: false, error: `正则合集导入语句数(${stmts.length},每条正则=1个DELETE+1个INSERT)超过900条单批安全线(付费档D1上限1000/批),分批导入` };
  }

  let results: any[];
  try {
    results = await env.OC_DB.batch(stmts);
  } catch (err: any) {
    return { success: false, error: err.message, server: true };
  }

  // replaced_count:每条DELETE命中的行数之和——搬家场景(全局→挂包)这个数可能是1(旧全局行)+
  // 又清到同一目标包下的旧行(如果之前搬过一次)——正常情况下"清完之后再插"这个不变量保证同一个
  // st_id最终在库里(全局∪目标包这两处并起来看)只剩1行,累加只是如实反映"这次导入顶替掉了几条"。
  let replacedCount = 0;
  let insertedCount = 0;
  for (let i = 0; i < parsed.length; i++) {
    replacedCount += results[i * 2]?.meta?.changes ?? 0;
    insertedCount += results[i * 2 + 1]?.meta?.changes ?? 0;
  }

  // F2批后验收(收据永不说谎):target给定且一条都没插进去(insertedCount===0,parsed非空)——
  // 意味着整批的EXISTS守卫全部落空,目标包在batch()真正执行时已经不存在了。D1 batch()是单个
  // 原子事务,同一批内所有语句看到的是同一份快照,EXISTS对每条DELETE/INSERT的判定结果一致
  // (要么全部为真正常导入,要么全部为假集体no-op),不存在"部分语句插进去、部分没插"这种中间
  // 撕裂态,所以"insertedCount===0"这一个数字就能百分百确定"这批压根没有落库",不用逐条排查。
  // 此时不能照常返回success:true——旧的全局行(如果之前有)因为DELETE同样被EXISTS挡住而原样
  // 保留,部署者会以为"搬家成功"其实全局旧行原封未动、新preset行一条没插,必须明说这次没落库。
  if (trimmedTarget && insertedCount === 0) {
    return { success: false, error: '目标预设包不存在或刚被删掉,这次导入没有落库' };
  }

  return {
    success: true,
    imported_count: parsed.length,
    replaced_count: replacedCount,
    scope,
    preset_id: presetIdForInsert,
    skipped: skipped.map((s) => `${s.name}: ${s.reason}`),
    scrubbed_count,
  };
}

// ===== import/worlds(备用口)=====
// ⚠️工单没配真实世界书样本(只有预设+settings两份),这里按 SillyTavern 通用的 World Info /
// character book 导出形状(entries 是以 uid 为键的对象,每条带 key/content/position/是否禁用)
// 做尽量宽容的解析——真拿到样本前先保证"合法输入不炸、字段缺失有兜底",别的等 S2/S3 有实弹再调。
// 兼容两种请求体形状:{project, entries:{...}} (ST world json 与 project 拼在同一层) 或
// {project, world:{entries:{...}}}(显式包一层)。
export function parseWorldEntries(raw: any): Array<{ name: string; keys: string[]; content: string; position: 'before' | 'after'; enabled: boolean; constant: boolean }> {
  const source = raw?.entries ? raw : raw?.world;
  const entries = source?.entries;
  if (!entries || typeof entries !== 'object') return [];
  const list = Array.isArray(entries) ? entries : Object.values(entries);
  return list
    .filter((e: any) => e && typeof e === 'object')
    .map((e: any) => {
      const rawKeys = Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : []);
      const keys = rawKeys.filter((k: any) => typeof k === 'string');
      // enabled 字段两种写法都见过:直接给 enabled,或者反着给 disable——两个都缺省时默认启用
      const enabled = e.enabled !== undefined ? !!e.enabled : !e.disable;
      // position:0/'before_char'→before, 1/'after_char'→after,其余(包括缺失)沿 schema 默认 before
      const pos = e.position;
      const position: 'before' | 'after' = (pos === 1 || pos === 'after_char' || pos === 'after') ? 'after' : 'before';
      return {
        name: String(e.comment || e.name || ''),
        keys,
        content: String(e.content || ''),
        position,
        enabled,
        constant: !!e.constant,
      };
    });
}

export async function deskImportWorlds(env: DeskEnv, raw: any): Promise<any> {
  if (!raw || typeof raw !== 'object') {
    return { success: false, error: `请求体不是合法的worlds JSON对象——读到的类型是 ${describeType(raw)}` };
  }
  const project = typeof raw.project === 'string' ? raw.project.trim() : '';
  if (!project) {
    return {
      success: false,
      error: raw.project === undefined
        ? '缺 project 字段(前端应该把当前打字桌project拼进请求体)'
        : `project 字段类型不对,应该是非空字符串,实际收到的是 ${describeType(raw.project)}`,
    };
  }

  const entries = parseWorldEntries(raw);
  if (entries.length === 0) {
    // 点名到底是"entries字段没找到"还是"找到了但形状/内容不对"——parseWorldEntries 认
    // {project,entries:{...}} 或 {project,world:{entries:{...}}} 两种包法,这里原样复刻它的取法
    // 来诊断,不是另开一套判断逻辑。
    const source = raw?.entries ? raw : raw?.world;
    let shapeHint: string;
    if (source?.entries === undefined) {
      shapeHint = '顶层 entries 字段和 world.entries 字段都没找到';
    } else if (source.entries === null || typeof source.entries !== 'object') {
      shapeHint = `entries 字段类型不对,应该是对象或数组,实际收到的是 ${describeType(source.entries)}`;
    } else {
      shapeHint = 'entries 字段存在但解析出0条——可能是空的,或者条目形状不是ST的 World Info/character book 格式';
    }
    return { success: false, error: `没解析出任何世界书条目——${shapeHint}` };
  }

  const now = new Date().toISOString();
  // 世界书直接写入 memories；desk_lore 指针层已废除。
  // 就是书架里的一条设定。⚠️副作用要认清楚:**导进来的条目会直接出现在书架上**(以前只躺在
  // 文具盒里)。草案 §四 注意⑤ 记的就是这条——将来导别人的酒馆世界书(几十上百条)会一次性把
  // 书架冲得很满,那时要给导入的条目打来源标签 + 书架能一键筛掉。本次不做,先记着。
  // id 必须用 mem_ 前缀:装配读世界书是 ORDER BY id(见 deskAssemble.ts),换个前缀会让导进来的
  // 条目在剧本里整体排到别处去。
  // 同批导入的 id 必须包含稳定递增量，不能只依赖同毫秒 Date.now()。
  // 同一个同步栈里 map 出来,毫秒极容易撞——一撞,字典序就由随机后缀决定,同一批卡在剧本里的先后
  // 变成随机的。这里改成按下标给每条一个递增的时间戳(baseTs + i),形状仍是 `mem_<13位>_<随机>`,
  // 但同批内严格按文件里的条目顺序排。代价是这些 id 里的毫秒数最多比真实导入时刻晚几十毫秒,
  // 无人依赖它当时间用(created_at 才是时间的正本,那一列仍写真实 now)。
  const baseTs = Date.now();
  const stmts = entries.map((e, i) => {
    const id = `mem_${baseTs + i}_${Math.random().toString(36).slice(2, 11)}`;
    return env.OC_DB.prepare(
      `INSERT INTO memories (id, project, category, title, tags, chapter, content, created_at, updated_at,
                             lore_keys, lore_position, is_char, lore_constant, lore_enabled, lore_fields, trigger_mode)
       VALUES (?, ?, 'world', ?, '[]', '', ?, ?, ?, ?, ?, 0, ?, ?, '{}', 'scan')`
    ).bind(id, project, e.name, e.content, now, now,
           JSON.stringify(e.keys), e.position, e.constant ? 1 : 0, e.enabled ? 1 : 0);
  });

  // 同preset/settings口:900条安全线(付费档D1上限1000/批)
  if (stmts.length > 900) {
    return { success: false, error: '世界书条目超过900条,超出单批安全线(付费档D1上限1000/批)' };
  }

  try {
    await env.OC_DB.batch(stmts);
  } catch (err: any) {
    return { success: false, error: err.message, server: true };
  }

  return { success: true, project, count: entries.length };
}

// ===== import/card(角色卡 V1/V2/V3 → 书架角色卡条目 + 内嵌世界书)=====
// 纯解析在 src/core/characterCard.ts(parseCharacterCard),路由层先 parse 再把 card 传进来——
// 跟其余四口"这里既解析又落库"不同,是因为角色卡解析结果还要给前端回吐 first_mes/
// alternate_greetings(纯展示,不落库),解析器保持纯函数才好被前端/测试单独复用。
//
// category 选 'world':LORE_CATEGORY_SQL 只认 'world'/'outline' 两档,装配引擎按 is_char 区分
// 角色卡跟普通世界书条目,不靠 category(deskAssemble.ts renderWorldInfo 用 !r.is_char 过滤、
// activeCards 用 c.is_char 挑),'outline'是大纲专用,角色卡跟普通世界书条目一样走'world'。
//
// 落两件事:①书架建一条角色卡条目(memories 一行,is_char=1、keys=[名字]、trigger_mode='scan'、
// content=description 当 Description 兜底——跟 deskAssemble renderCharacterField 的回退语义
// 对齐:structured=fields.description 优先,fields 里没有才回退到 content)②内嵌 character_book
// 有 entries → 复用 parseWorldEntries(与 deskImportWorlds 同一份纯函数,形状天然兼容),落成
// is_char=0 的世界书行。
//
// 两步不是一个原子批次(D1 batch() 本来就不能跨两次 prepare/batch 调用合并成一个事务)——角色卡
// 本体先落、世界书条目后落,世界书那批若因超900条/D1报错失败,角色卡本体不回滚,如实把失败原因
// 塞进 warnings 里(照 study.ts create "D1 是源真相,向量失败不回滚"同一条家法:宁可"卡进了、
// 附带的世界书没进"让部署者自己看着办,不做跨批次的"全有或全无")。
// 向量走 study.ts 的 embedMemory(唯一允许拼这份 metadata 的函数,见 study.ts 头注释),
// best-effort、失败不影响这次导入成功与否,只把 vector_ok 如实带回去。
export async function importCharacterCard(env: DeskEnv, card: CharacterCard, projectRaw: any): Promise<any> {
  const project = typeof projectRaw === 'string' ? projectRaw.trim() : '';
  if (!project) {
    return {
      success: false,
      error: projectRaw === undefined
        ? '缺 project 字段(前端应该把当前打字桌project拼进请求体)'
        : `project 字段类型不对,应该是非空字符串,实际收到的是 ${describeType(projectRaw)}`,
    };
  }

  const id = genId('mem');
  const now = new Date().toISOString();

  // lore_fields 只收非空字符串(照 deskPanels.ts normalizeLoreFields 同一口径:空字符串等同没填,
  // 不占一个键)。main_prompt/post_history_instructions 目前装配引擎还没接消费(README 兼容矩阵
  // 如实标注),这里仍然如实落库——将来接上不用回头补数据。
  const fields: Record<string, string> = {};
  if (card.description) fields.description = card.description;
  if (card.personality) fields.personality = card.personality;
  if (card.scenario) fields.scenario = card.scenario;
  if (card.mesExample) fields.mes_example = card.mesExample;
  if (card.systemPrompt) fields.main_prompt = card.systemPrompt;
  if (card.postHistoryInstructions) fields.post_history_instructions = card.postHistoryInstructions;

  try {
    await env.OC_DB.prepare(
      `INSERT INTO memories (id, project, category, title, tags, chapter, content, created_at, updated_at,
                             lore_keys, lore_position, is_char, lore_constant, lore_enabled, lore_fields, trigger_mode)
       VALUES (?, ?, 'world', ?, '[]', '', ?, ?, ?, ?, 'before', 1, 0, 1, ?, 'scan')`
    ).bind(id, project, card.name, card.description, now, now, JSON.stringify([card.name]), safeJsonStringify(fields)).run();
  } catch (err: any) {
    return { success: false, error: err.message, server: true };
  }

  let vectorOk = true;
  try {
    await embedMemory(env, { id, project, category: 'world', title: card.name, content: card.description, created_at: now });
  } catch (err) {
    vectorOk = false;
    console.error('[desk] 角色卡导入向量化失败(D1已落地,不回滚):', err);
  }

  const warnings: string[] = [];
  let bookImported = 0;
  if (card.characterBook && card.characterBook.entries) {
    const entries = parseWorldEntries({ entries: card.characterBook.entries });
    if (entries.length > 900) {
      warnings.push('内嵌世界书条目超过900条,超出单批安全线(付费档D1上限1000/批)——角色卡本体已导入,内嵌世界书条目未导入');
    } else if (entries.length > 0) {
      const baseTs = Date.now();
      const stmts = entries.map((e, i) => {
        const eid = `mem_${baseTs + i}_${Math.random().toString(36).slice(2, 11)}`;
        return env.OC_DB.prepare(
          `INSERT INTO memories (id, project, category, title, tags, chapter, content, created_at, updated_at,
                                 lore_keys, lore_position, is_char, lore_constant, lore_enabled, lore_fields, trigger_mode)
           VALUES (?, ?, 'world', ?, '[]', '', ?, ?, ?, ?, ?, 0, ?, ?, '{}', 'scan')`
        ).bind(eid, project, e.name, e.content, now, now,
               JSON.stringify(e.keys), e.position, e.constant ? 1 : 0, e.enabled ? 1 : 0);
      });
      try {
        await env.OC_DB.batch(stmts);
        bookImported = entries.length;
      } catch (err: any) {
        warnings.push(`角色卡本体已导入,内嵌世界书条目导入失败: ${err.message}`);
      }
    }
  }

  return {
    success: true,
    entry_id: id,
    name: card.name,
    book_imported: bookImported,
    vector_ok: vectorOk,
    warnings,
    first_mes: card.firstMes || undefined,
    alternate_greetings: card.alternateGreetings.length > 0 ? card.alternateGreetings : undefined,
  };
}

// ===== GET /api/oc/desk/presets =====

export async function deskListPresets(env: DeskEnv): Promise<any> {
  try {
    const presets = await env.OC_DB.prepare(
      `SELECT id, name, block_count, created_at, params FROM desk_presets ORDER BY created_at DESC`
    ).all<any>();
    const counts = await env.OC_DB.prepare(
      `SELECT preset_id, SUM(in_queue) AS queue_count, SUM(CASE WHEN in_queue = 0 THEN 1 ELSE 0 END) AS library_count
       FROM desk_blocks GROUP BY preset_id`
    ).all<any>();
    const countMap = new Map((counts.results || []).map((c: any) => [c.preset_id, c]));

    const rows = (presets.results || []).map((p: any) => {
      const c = countMap.get(p.id) as any;
      let params: any = {};
      try { params = p.params ? JSON.parse(p.params) : {}; } catch { params = {}; }
      return {
        id: p.id,
        name: p.name,
        block_count: p.block_count,
        created_at: p.created_at,
        params,
        queue_count: c ? Number(c.queue_count || 0) : 0,
        library_count: c ? Number(c.library_count || 0) : 0,
      };
    });
    return { success: true, count: rows.length, presets: rows };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== 删除预设包 =====
// 预设包不可变(工单§0铁律6)不等于不可删——不可变管的是"导入后内容不会被悄悄改写",删除是
// 部署者主动收摊。护栏:有配方钉在这个包上就拒删并点名配方(不做级联杀配方,先删配方再删包是
// 部署者自己的活);无引用才放行,放行时连坐删掉这个包的积木+内嵌正则(scope='preset')。
// 删除必须在条件语句中再次验证无配方引用，不能只依赖批外查询。
// DELETE"——check-then-delete之间有个窗口,若这中间冒出一个新配方钉住这个包,三条DELETE会照样
// 执行,静默删掉一个"此刻已经被引用"的包,前端还以为删的是干净包。真正的不变量必须焊进DELETE
// 语句本身:三条都带 `AND NOT EXISTS(SELECT 1 FROM desk_recipes WHERE preset_id=?1)`,让
// "有没有配方引用"这件事在同一条语句执行的瞬间被复核,不是batch外面查一次就作数。前面那次
// precheck 依然留着,但降级成"快路径报错文案"——查到就直接点名少跑一次batch往返,查不到不代表
// 真的安全,安全性由下面batch里的 NOT EXISTS 兜底。
export async function deskPresetDelete(env: DeskEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  try {
    const preset = await env.OC_DB.prepare(`SELECT id FROM desk_presets WHERE id = ?`).bind(id).first<any>();
    if (!preset) return { success: false, error: '预设包不存在' };

    // 拍板(部署者,R3工单:配方从project维度升为全桌通用)追记:project列不再是配方的归属维度,
    // 新建的配方一律project=''——(项目「」)这种空名号是纯噪音。改条件拼接:project非空才带
    // 后缀(老配方那批行project还留着历史值,继续提示部署者去哪个项目找过;新配方project=''
    // 不带后缀,干干净净只报配方名)。两处(precheck快路径+recheck竞态兜底)共用同一份格式化,
    // 不写两份会走样的逻辑。
    const formatRecipeRef = (r: any) => {
      const name = r.name || '(无名配方)';
      return r.project ? `${name}(项目「${r.project}」)` : name;
    };
    const precheck = await env.OC_DB.prepare(`SELECT name, project FROM desk_recipes WHERE preset_id = ?`).bind(id).all<any>();
    const precheckNames = (precheck.results || []).map(formatRecipeRef);
    if (precheckNames.length > 0) {
      return { success: false, error: `还有配方钉在这个包上：${precheckNames.join('、')}，先删配方再删包` };
    }

    const stmts = [
      env.OC_DB.prepare(
        `DELETE FROM desk_blocks WHERE preset_id = ?1 AND NOT EXISTS (SELECT 1 FROM desk_recipes WHERE preset_id = ?1)`
      ).bind(id),
      env.OC_DB.prepare(
        `DELETE FROM desk_regex WHERE scope = 'preset' AND preset_id = ?1 AND NOT EXISTS (SELECT 1 FROM desk_recipes WHERE preset_id = ?1)`
      ).bind(id),
      env.OC_DB.prepare(
        `DELETE FROM desk_presets WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM desk_recipes WHERE preset_id = ?1)`
      ).bind(id),
    ];
    // 3条语句,远低于900条D1批量安全线,不需要闸
    const results = await env.OC_DB.batch(stmts);
    const presetDeleted = results[2]?.meta?.changes ?? 0;
    if (presetDeleted === 0) {
      // NOT EXISTS 在batch执行的瞬间拦下了(precheck之后、batch真正跑之前的窗口里冒出了新配方,
      // 或者更罕见——包在这中间被另一个并发请求删掉了)。重查一次给准确报错,不猜。
      const stillThere = await env.OC_DB.prepare(`SELECT id FROM desk_presets WHERE id = ?`).bind(id).first<any>();
      if (!stillThere) return { success: false, error: '预设包不存在' };
      const recheck = await env.OC_DB.prepare(`SELECT name, project FROM desk_recipes WHERE preset_id = ?`).bind(id).all<any>();
      const recheckNames = (recheck.results || []).map(formatRecipeRef);
      return { success: false, error: `还有配方钉在这个包上：${recheckNames.join('、')}，先删配方再删包` };
    }
    return {
      success: true,
      id,
      deleted_block_count: results[0]?.meta?.changes ?? 0,
      deleted_regex_count: results[1]?.meta?.changes ?? 0,
    };
  } catch (err: any) {
    return { success: false, error: err.message, server: true };
  }
}

// ===== GET /api/oc/desk/regex =====

export async function deskListRegex(env: DeskEnv, params?: { scope?: string; preset_id?: string }): Promise<any> {
  const conditions: string[] = [];
  const values: any[] = [];
  if (params?.scope) { conditions.push('scope = ?'); values.push(params.scope); }
  if (params?.preset_id) { conditions.push('preset_id = ?'); values.push(params.preset_id); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    // ORDER BY 以 sort_order 为主，name 与 id 作为确定性副键。
    // 复审:并发导入理论上能撞出同号,name也可能重名,id是唯一值,同号时至少排序结果是确定的、
    // 不会在两次请求间无意义地抖动)。
    const result = await env.OC_DB.prepare(
      `SELECT id, scope, preset_id, name, find, replace, flags, direction, enabled, meta, sort_order FROM desk_regex ${where} ORDER BY scope, sort_order, name, id`
    ).bind(...values).all<any>();
    // meta.invalid/meta.unsafe/meta.invalid_reason 摊平进列表返回值(S5a交付物B4要用:抽屉正则面板
    // 要给坏行显示原因+force确认,原样把 meta 整坨丢给前端不划算——这里挑三个字段摊平)。
    // 下行正则必须返回 find/replace/flags，供前端执行。
    // S5a只是给抽屉面板"看/开关/改名",没打算让前端拿着规则去跑;desk_regex 表里这三列本来就不是
    // 敏感数据(部署者自己导的ST正则,不是凭据),补进响应不违反凭据洗盘铁律(那条铁律管的是
    // key/token/secret 这类字段,不管 find/replace 正文)。
    const rows = (result.results || []).map((r: any) => {
      let meta: any = {};
      try { meta = r.meta ? JSON.parse(r.meta) : {}; } catch { meta = {}; }
      return {
        id: r.id,
        scope: r.scope,
        preset_id: r.preset_id,
        name: r.name,
        find: r.find,
        replace: r.replace,
        flags: r.flags,
        direction: r.direction,
        enabled: !!r.enabled,
        sort_order: Number(r.sort_order || 0),
        invalid: !!meta.invalid,
        unsafe: !!meta.unsafe,
        invalid_reason: meta.invalid_reason || null,
      };
    });
    return { success: true, count: rows.length, regex: rows };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== 章总结向量(工单§4 S2交付物D):backfill 端点 =====
//
// Vectorize 家法(照 study.ts embedMemory 头注释抄,同一条铁律不许各处重开):upsert 是整条覆盖式写入,
// 不是 merge patch——少拼一个 metadata 字段 = 把这条向量原有的 metadata 冲没。所以"重新写一次章总结向量"
// 这件事只许经这一个函数,S2 装配引擎的往事区召回(deskAssemble.ts)只读不写,别在别处再拼一份 metadata。
// id 用 `chsum_<chapter_id>` 前缀(工单§3钉死),跟 study.ts 的记忆向量、章节正文向量(缓建不预支,不存在)
// 物理隔离在同一个索引里靠 category:'chsum' metadata 区分,查询侧(deskAssemble.ts)必须带这个 filter。
// 导出给 tools/reading.ts 的写路径生命周期钩子(update/delete/unpublish)复用——同一条"重新写
// 一次章总结向量只许经这一个函数"的家法,别在 reading.ts 里再拼一份 metadata。
export async function embedChapterSummary(
  env: DeskEnv,
  row: { id: string; title?: string; summary?: string; content?: string; project?: string; chapter_no?: string; created_at?: string }
): Promise<void> {
  const title = String(row.title || '');
  const summary = String(row.summary || '').trim();
  const content = String(row.content || '');
  // summary 是密度 gist，仅作嵌入检索键；content 是实际注入正文。
  // 长文嵌入被稀释);content=整篇篇章总结,是装配注入的本体(deskAssemble.chapterBody)。这里
  // gist优先,老章/没写gist的退到content头部——头部主题密度足够定位坐标。
  // bge-m3 输入先按 4000 码点安全截断，不能切开代理对。
  // 2 token最坏假设下8000留余量) ③仍超限对半递减重试(见下方catch)。只截"检索坐标"的计算输入。
  const EMBED_INPUT_CAP = 4000;
  const cutByCodePoints = (s: string, n: number) => Array.from(s).slice(0, n).join('');
  const key = summary || content;
  const text = cutByCodePoints(`${title}\n${key}`, EMBED_INPUT_CAP);
  const metadata = {
    project: row.project || '',
    category: 'chsum',
    chapter_no: row.chapter_no || '',
    created_at: row.created_at || '',
  };
  try {
    await upsertVector(env.OC_VECTORIZE, env.AI, `chsum_${row.id}`, text, metadata);
  } catch (err) {
    // 极端字符仍超 token 上限时对半重试。
    // 2000码点即使每字3 token也只到6000,必然过线;再失败就是别的毛病,原样抛给上层记failed。
    const half = cutByCodePoints(text, Math.floor(EMBED_INPUT_CAP / 2));
    await upsertVector(env.OC_VECTORIZE, env.AI, `chsum_${row.id}`, half, metadata);
  }
}

// ===== POST /api/oc/desk/backfill-chapter-vectors =====
// 幂等:upsert 本来就是覆盖式写,重复跑不会堆重复向量(同 study.ts studyBackfill 的道理)。
// 只挑 status='published' 且 summary/content 任一非空的章(gist双层拍板后正文也是合法嵌入源)——
// 草稿章剧透未发布内容不该进召回池,两格全空的章 embed 空文本没有意义。project 可选,不给就全库补。
export async function deskBackfillChapterVectors(env: DeskEnv, body: any): Promise<any> {
  const project = body && typeof body.project === 'string' && body.project.trim() ? body.project.trim() : undefined;
  // “有货”口径与 reading/装配一致：纯空白不算内容。
  // 判空删过向量的章重建无意义的标题向量。
  const conditions = [`status = 'published'`, `(TRIM(summary) != '' OR TRIM(content) != '')`];
  const values: any[] = [];
  if (project) {
    conditions.push('project = ?');
    values.push(project);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const result = await env.OC_DB.prepare(
      `SELECT id, title, summary, content, project, chapter_no, created_at FROM oc_chapters ${where}`
    ).bind(...values).all<any>();
    // SQL TRIM 只粗筛，最终以 JS trim 判定所有空白。
    // 绝不给钩子判空删过向量的章重建标题向量。
    const rows = ((result.results || []) as any[])
      .filter((r) => String(r.content || '').trim() || String(r.summary || '').trim());

    let embedded = 0;
    const failed: string[] = [];
    for (const row of rows) {
      try {
        await embedChapterSummary(env, row);
        embedded++;
      } catch (err) {
        console.error(`[desk] backfill 章总结向量失败 id=${row.id}:`, err);
        failed.push(row.id);
      }
    }
    return { success: true, total: rows.length, embedded, failed };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
