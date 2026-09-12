// src/tools/deskMacro.ts
// desk · 打字桌宏引擎 + 上行正则管道:纯文本变换,不碰存储/env。
// 只实现 ST 宏方言与正则替换字符串方言的子集,盖在自家装配管线上(chat/deskAssemble.ts 调用,不逆向依赖)。
// isPatternUnsafe 从 shared/regexSafety.ts 复用:"疑似灾难性回溯"判定只许一处定义。

import { isPatternUnsafe } from '../shared/regexSafety.ts';

// ===== 宏引擎:ST 方言子集 {{user}}/{{char}}/{{setvar}}/{{getvar}}/{{addvar}}/{{setglobalvar}}/{{getglobalvar}}/{{addglobalvar}}/{{trim}}/{{// 注释}}/{{lastUserMessage}} =====
// setvar 落变量池、渲染空串;getvar 读池(没设过=空串);addvar 追加到池里已有值之后(两边都是数字则相加),渲染空串——
// 预设"可多选"区靠它叠便签,setvar 是"单选"(后者覆盖前者)。globalvar 三个是 setvar/getvar/addvar 的别名(同一个池)。
// {{// 任意文字}} 是作者注释,渲染空串;{{lastUserMessage}} 渲染本轮输入(ctx 不给就空串)。
// 宏可嵌套(便签值里套宏):配平扫描找真正的闭合,set/add 时先展开 value 再存。未识别的宏原样保留。
export interface MacroCtx {
  user: string;
  char: string;
  vars: Record<string, string>;
  lastUserMessage?: string;
}

// setvar 的 value 递归展开的深度上限,超过就原样保留(防 setvar 套 setvar 无限套)。
const MAX_MACRO_DEPTH = 16;

// 一趟栈配平:算出每个 "{{" 闭合 "}}" 之后的位置(孤儿 "{{" 不进 Map)。整段只扫一遍,O(n)。
function matchMacroBraces(s: string): Map<number, number> {
  const closeOf = new Map<number, number>();
  const stack: number[] = [];
  let j = 0;
  while (j < s.length) {
    if (s.startsWith('{{', j)) { stack.push(j); j += 2; }
    else if (s.startsWith('}}', j)) { const open = stack.pop(); if (open !== undefined) closeOf.set(open, j + 2); j += 2; }
    else { j++; }
  }
  return closeOf;
}

// addvar 语义(照 ST):两边都是纯数字就相加,否则字符串拼接;没设过当空串。
function addValue(prev: string | undefined, inc: string): string {
  const a = prev ?? '';
  const isNum = (s: string) => s.trim() !== '' && Number.isFinite(Number(s));
  if (isNum(a) && isNum(inc)) return String(Number(a) + Number(inc));
  return a + inc;
}

// 单个宏按前缀分派渲染。vars 原地改,setvar/addvar 的副作用按文档序立刻生效。
function renderMacro(inner: string, full: string, ctx: MacroCtx, vars: Record<string, string>, depth: number): string {
  if (inner === 'user') return ctx.user;
  if (inner === 'char') return ctx.char;
  if (inner === 'trim') return full; // 占位不动,第二趟处理
  if (inner === 'lastUserMessage') return ctx.lastUserMessage ?? '';
  if (inner.startsWith('//')) return ''; // 作者注释

  // 只在第一个 "::" 切宏名;setvar 再切一刀拿 name,剩下整段是 value(value 里的字面 "::" 保留)
  const sepIdx = inner.indexOf('::');
  const head = sepIdx === -1 ? inner : inner.slice(0, sepIdx);

  const isSet = head === 'setvar' || head === 'setglobalvar';
  const isAdd = head === 'addvar' || head === 'addglobalvar';
  const isGet = head === 'getvar' || head === 'getglobalvar';
  // 认识的宏名但没带 "::" 参数(如 {{setvar}}):不算合法宏,原样保留
  if ((isSet || isAdd || isGet) && sepIdx === -1) return full;
  if (isSet || isAdd) {
    const rest = inner.slice(sepIdx + 2);
    const nameSep = rest.indexOf('::');
    const name = nameSep === -1 ? rest : rest.slice(0, nameSep);
    const rawValue = nameSep === -1 ? '' : rest.slice(nameSep + 2);
    const expandedValue = scanMacros(rawValue, ctx, vars, depth + 1); // 先展开 value 再存
    if (name) vars[name] = isAdd ? addValue(vars[name], expandedValue) : expandedValue;
    return '';
  }

  if (isGet) {
    const name = inner.slice(sepIdx + 2);
    return vars[name] ?? ''; // 存的时候已展开,这里不再递归(也防自引用死循环)
  }

  return full; // 未识别宏整个原样保留,内部不展开
}

// 核心扫描器:先算好配平表,再从左到右逐个宏渲染。孤儿 "{{" 只原样吐它自己两个字符,后面的宏照常。
function scanMacros(text: string, ctx: MacroCtx, vars: Record<string, string>, depth: number): string {
  const s = String(text || '');
  if (depth > MAX_MACRO_DEPTH) return s;

  const closeOf = matchMacroBraces(s);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const openIdx = s.indexOf('{{', i);
    if (openIdx === -1) { out += s.slice(i); break; }
    out += s.slice(i, openIdx);
    const closeIdx = closeOf.get(openIdx);
    if (closeIdx === undefined) {
      out += '{{'; // 孤儿开括号:原样保留,不当宏处理
      i = openIdx + 2;
      continue;
    }
    const full = s.slice(openIdx, closeIdx);
    const inner = s.slice(openIdx + 2, closeIdx - 2);
    out += renderMacro(inner, full, ctx, vars, depth);
    i = closeIdx;
  }
  return out;
}

export function applyMacros(text: string, ctx: MacroCtx): { text: string; vars: Record<string, string> } {
  const vars: Record<string, string> = { ...ctx.vars };

  let out = scanMacros(String(text || ''), ctx, vars, 0);

  // 第二趟:{{trim}} 剥掉自己位置紧邻的空白/换行(垫底块专用——纯 setvar 的块配 {{trim}} 收尾能整块渲染成空)
  out = out.replace(/\s*\{\{trim\}\}\s*/g, '');

  return { text: out, vars };
}

// ===== 上行正则管道 =====
//
// ⚠️应用范围(工单§3):上行正则只跑在楼层/近景原文上(MoM节食那套4条正则的目标),
// 绝不跑在配方积木文本上——积木是预设作者写好的提示词,不是"聊天记录",节食正则对它没有意义、
// 也不该被误伤。deskAssemble.ts 调用 applyUpRegex 时只喂 floors 的 content,别喂 preBlocks/postBlocks。
export interface DeskRegexRule {
  find: string;
  flags: string;
  replace: string;
  direction: 'up' | 'down' | 'both';
  meta?: { invalid?: boolean; unsafe?: boolean; [k: string]: any };
}

// ReDoS 爆炸半径上限(工单 Fix2a):单块文本封顶 UP_REGEX_CAP 字才喂进正则管道,超出部分原样
// 贴回结果末尾、不参与任何规则——Workers CPU 限时是最后一道兜底,这里是提前收敛"最坏情况一条
// 灾难性回溯正则要扫多少字"这个爆炸半径,单人已鉴权应用力度按比例来,不是给公网设的硬闸。
const UP_REGEX_CAP = 20000;

// ST 替换字符串方言:$1 等反向引用是 JS 原生支持的,不用翻译;{{match}} 是 ST 独有写法,
// 语义等价于 JS 的 $&(整个匹配),这里只翻译这一个符号,其余原样交给 String.replace。
// ⚠️踩坑记录:不能写成 .replace(/\{\{match\}\}/g, '$&')——replace()的字符串替换参数里 $& 是
// JS 自己的特殊语法(指"这次replace匹配到的内容",这里匹配到的就是字面量"{{match}}"本身),
// 结果等于把 {{match}} 原样传回去,什么都没变。必须用函数回调,回调的返回值是字面量插入、
// 不会被二次当成 $ 模式解释,这样才能真正把 {{match}} 换成字面两个字符 $&。
function translateReplaceString(replace: string): string {
  return String(replace || '').replace(/\{\{match\}\}/g, () => '$&');
}

export function applyUpRegex(text: string, rules: DeskRegexRule[]): string {
  const full = String(text || '');
  // 超长楼层文本封顶,只把前 UP_REGEX_CAP 字喂进正则管道,后面原样拼回去(见上方常量注释)
  const capped = full.length > UP_REGEX_CAP;
  let out = capped ? full.slice(0, UP_REGEX_CAP) : full;
  const remainder = capped ? full.slice(UP_REGEX_CAP) : '';
  for (const rule of rules || []) {
    if (rule.direction !== 'up' && rule.direction !== 'both') continue;
    if (rule.meta?.invalid) continue; // S1 落库时已经把编译不过的正则降级禁用+标 invalid,这里跳过不是防御性冗余
    if (isPatternUnsafe(rule.find)) continue; // 纵深防御(工单Fix2b):import 时该摁灭的已经enabled=0进不来这个数组,
    // 这里再挡一道是防"绕开导入路径直接塞规则"(测试构造/以后新入口)——同一形状不该有两条判定逻辑,直接复用 desk.ts 那份。
    try {
      const re = new RegExp(rule.find, rule.flags);
      out = out.replace(re, translateReplaceString(rule.replace));
    } catch {
      continue; // new RegExp 本身炸了(理论上 S1 已经挡过一轮,这里是纵深防御)也不让一条坏正则打断整条流水线
    }
  }
  return capped ? out + remainder : out;
}

// ===== 世界书/角色卡关键词命中 =====
//
// ST 的世界书触发语义是"关键词子串命中即触发"(大小写不敏感),不玩正则/整词匹配那套——
// 简单可靠,跟 S1 导入器解析出来的 desk_lore.keys 形状(字符串数组)直接对得上。
export function matchLoreKeys(corpus: string, keys: string[]): boolean {
  if (!keys || !keys.length) return false;
  const lower = String(corpus || '').toLowerCase();
  return keys.some((k) => {
    const kk = String(k || '').trim().toLowerCase();
    return kk.length > 0 && lower.includes(kk);
  });
}
