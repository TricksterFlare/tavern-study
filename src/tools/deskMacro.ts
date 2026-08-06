// src/tools/deskMacro.ts
// desk · 打字桌宏引擎 + 上行正则管道(Day94 S2施工工单):纯文本变换,不碰 D1/env。
// 施工工单§0铁律1"不搬酒馆的楼,学酒馆的方言"——这里吃 ST 的宏方言子集和正则替换字符串方言,
// 原生盖在咱家自己的装配管线上(chat/deskAssemble.ts 调用这两组函数,不逆向依赖)。
//
// 纯函数(applyMacros/applyUpRegex/matchLoreKeys)不碰 D1/env,verify_desk_assemble.mjs
// 直接复制这几个函数体对着真实预设样本跑断言,改这里记得把验证脚本也搬一遍。
//
// isPatternUnsafe 从 shared/regexSafety.ts 借来复用(工单Fix2b纵深防御,同一份"疑似灾难性回溯"
// 判定逻辑只许一处定义)——该模块是纯函数,这条 import 不引入 D1/env 依赖,不算破例。

import { isPatternUnsafe } from '../shared/regexSafety.ts';

// ===== 宏引擎:ST 方言子集 {{user}}/{{char}}/{{setvar::name::value}}/{{getvar::name}}/{{trim}} =====
//
// {{setvar::name::value}} 落变量池、渲染成空串;{{getvar::name}} 读变量池(没设过=空串);
// 未识别的宏(如 {{time}}/{{roll:1d6}})原样保留,不瞎猜、不吞掉——这是"方言子集"而非"全量实现"的边界。
//
// 单趟正则 + 回调函数处理 {{user}}/{{char}}/{{setvar}}/{{getvar}}(trim 留给第二趟,原因见下):
// JS 的 String.replace 配全局正则时回调按从左到右的文档序依次触发,setvar 的副作用(改 vars)
// 天然按文档序发生——这正是工单要的"变量池随 setvar 在文档序里滚动更新"。
export interface MacroCtx {
  user: string;
  char: string;
  vars: Record<string, string>;
}

const MACRO_RE = /\{\{([\s\S]*?)\}\}/g;

export function applyMacros(text: string, ctx: MacroCtx): { text: string; vars: Record<string, string> } {
  const vars: Record<string, string> = { ...ctx.vars };

  let out = String(text || '').replace(MACRO_RE, (full: string, inner: string) => {
    if (inner === 'user') return ctx.user;
    if (inner === 'char') return ctx.char;
    if (inner === 'trim') return full; // 占位不动,第二趟专门处理(需要保留原始位置去剥周围空白)
    if (inner.startsWith('setvar::')) {
      const parts = inner.split('::');
      const name = parts[1] ?? '';
      const value = parts.slice(2).join('::'); // value 本身可能含 '::' 字面量,拼回去别拆丢
      if (name) vars[name] = value;
      return ''; // setvar 永远渲染成空串
    }
    if (inner.startsWith('getvar::')) {
      const name = inner.slice('getvar::'.length);
      return vars[name] ?? '';
    }
    return full; // 未识别宏:原样保留,不动它
  });

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
