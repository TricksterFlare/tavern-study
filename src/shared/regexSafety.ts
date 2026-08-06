// src/shared/regexSafety.ts
// 从 tools/desk.ts 机械搬迁:isPatternUnsafe 连同它唯一依赖的私有辅助(常量+两个 helper 函数)
// 一起搬过来——这几个 helper 在原文件里除了给 isPatternUnsafe 用之外没有第二个调用方,
// 拆开搬只会把同一份逻辑摔成两半,所以整段"灾难性回溯启发式"小节原样落到这个新文件,
// 只有 isPatternUnsafe 对外 export,helper/常量维持原先的模块私有可见性。逻辑一行未改。

// ===== 灾难性回溯启发式(工单 Fix2b,Day94 round-3 复审加固,widened;单人已鉴权应用,力度按比例来)=====
// 不是形式证明(prover),只挑几类最经典的危险形状,粗网眼——过度误伤只会把某条规则降级成
// disabled(可恢复),漏判才是真代价。RE2 换血(线性时间引擎)是记录在工单里的正式 won't-do:
// 单人自托管应用,ReDoS 面只来自部署者自己导入的预设,风险面不值得为它换正则引擎。
//
// 网眼一:嵌套量词——形如 (X+)+ / (X*)* / (X+)* / (X*)+(含 {n,} 无上限形式),即"量词组的内容
//   本身以量词收尾,组外紧跟量词"。
// 网眼二(round-3 新增):量词组内的歧义交替——组本身被 +/*/{n,} 量词包住,且组内顶层 | 分支
//   要么(a)有一支是另一支的前缀或与之相同(如 (a|aa)+;(a|a)+ 更是教科书级 2^n 例子——每个
//   字符都有两条等价路径,回溯树指数分叉,抽查时把早前的错误豁免撤掉了),
//   要么(b)有一支自己就是 X?/X*/X+ 形式的可选/量化原子(如 (a|a?)+、(a?|b)*,该分支自身就带
//   不确定的"要不要吃这个字符")。分支互不相关且都不带内部量词(如 (foo|bar)+、
//   (https?|ftp)+ 的 "https?|ftp" 部分)判定安全放行——纯字符串前缀/内部量词检测,不识别"共享
//   首字符类"这类更精细的形状,是故意留白的粗糙,不是漏洞。
//   ⚠️网眼二只认"组本身被量词包住"这个前提——(https?|ftp)://这种组后面接的不是量词而是普通
//   字面量的,连"是否歧义"都不判,组不量化就没有指数回溯的土壤,原样放行。
const UNBOUNDED_QUANT = String.raw`(?:[+*]|\{\d+,\})`;
const NESTED_QUANT_RE = new RegExp(String.raw`\([^()]*${UNBOUNDED_QUANT}\)${UNBOUNDED_QUANT}`);
// 扁平(不含嵌套括号)、被 +/*/{n,} 量词包住的组,连同组内容一起捕获——只对这类组的顶层 | 分支
// 再做前缀/自量化检查(见 hasAmbiguousQuantifiedAlternation)。
const QUANTIFIED_ALT_GROUP_RE = new RegExp(String.raw`\(([^()]*)\)${UNBOUNDED_QUANT}`, 'g');

// 组内容按顶层 | 拆分后的歧义判定(见网眼二 a/b 两条件)。不处理转义 `\|`——粗网眼,过度误伤
// 只会让某条规则被摁灭,不是安全问题。
function isAmbiguousAlternation(groupContent: string): boolean {
  const alts = groupContent.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
  if (alts.length < 2) return false;
  // (b) 某一支自身就是 X?/X*/X+(如 "a?"/"b*"/"c+"),该支自带不确定要不要吃字符
  if (alts.some((a) => a.length >= 2 && /[?*+]$/.test(a))) return true;
  // (a) 某支是另一支的前缀或与之相同("a"/"aa"、"a"/"a"都算——等值分支=每字符两条等价路径,
  // 正是 2^n 回溯的标准形状,没有豁免)
  for (let i = 0; i < alts.length; i++) {
    for (let j = i + 1; j < alts.length; j++) {
      const a = alts[i], b = alts[j];
      if (a.startsWith(b) || b.startsWith(a)) return true;
    }
  }
  return false;
}

function hasAmbiguousQuantifiedAlternation(s: string): boolean {
  QUANTIFIED_ALT_GROUP_RE.lastIndex = 0; // 模块级 g 正则,每次调用前重置游标,防止跨调用状态串味
  let m: RegExpExecArray | null;
  while ((m = QUANTIFIED_ALT_GROUP_RE.exec(s))) {
    const content = m[1];
    if (content.includes('|') && isAmbiguousAlternation(content)) return true;
  }
  return false;
}

export function isPatternUnsafe(find: string): boolean {
  const s = String(find || '');
  return NESTED_QUANT_RE.test(s) || hasAmbiguousQuantifiedAlternation(s);
}
