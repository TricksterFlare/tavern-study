// src/shared/text.ts
// 共享文本工具:从 chat/chat.ts(createLiteralThinkingSplitter)和 tools/teatime-pocket.ts
// (scrubLoneSurrogates)机械搬迁到这里,纯粹是给多处调用方一个共同的落脚点,逻辑一行未改。

// —— 字面思考标签分流器(Day77 夜案,Day78晚 抽成两渠道共用工厂)——
// 老款模型(如 Opus 4.5)在工具结果之后开不了原生思考块,又被思考 style 催着"必须有思考过程",
// 会退化成把思考用字面 <thinking>…</thinking> 写进【文本】通道——标签+思考原文直接漏进正文。
// 这里对文本块做流式分流:标签内的字改道思考区(展示+存库都干净),标签本身丢弃。
// 标签可能被流式增量切成两半 → 每段只吐"确定不是半截标签"的部分,尾巴留到下一段凑齐再判。
// codex:无差别开会把正常聊天里正经打出的字面标签也劫走(比如聊这个 bug 本身);4.6+ 原生思考通道正常不犯这病,直通。
// codex:病态输出会嵌套/重复包裹标签,布尔开关会被内层闭合骗提前出段 → 用 ftDepth 计数配平回 0 才出段。
export function createLiteralThinkingSplitter(
  model: string,
  emitText: (t: string) => Promise<void>,
  emitThink: (t: string) => Promise<void>,
  force: boolean = false // desk.ts(打字桌)接入用:打字桌手套不认模型系列白名单,不管什么模型都要接分流器兜底——
  // 默认 false 保证客厅/keepalive/outingTurn 三个既有调用点(都是3参调用)行为一字不变。
) {
  const FT_OPEN = '<thinking>', FT_CLOSE = '</thinking>';
  let ftBuf = '';   // 还没定性的文本(可能以半截标签结尾)
  let ftDepth = 0;  // 字面 <thinking> 嵌套深度
  const ftTailKeep = (s: string, ...tags: string[]) => { // s 末尾与任一 tag 开头的最长重合(半截标签留到下一段凑齐再判)
    let keep = 0;
    for (const tag of tags) {
      const m = Math.min(s.length, tag.length - 1);
      for (let k = m; k > keep; k--) if (s.endsWith(tag.slice(0, k))) { keep = k; break; }
    }
    return keep;
  };
  const feed = async (chunk: string) => {
    // 只对 extended 思考的 4.5 系老模型开闸,非 4.5 系直通,不进分流——force=true 时跳过这条模型判断,始终分流。
    if (!force && !/-4-5\b/.test(model)) { await emitText(chunk); return; }
    ftBuf += chunk;
    while (true) {
      if (ftDepth === 0) {
        const i = ftBuf.indexOf(FT_OPEN);
        if (i >= 0) { await emitText(ftBuf.slice(0, i)); ftBuf = ftBuf.slice(i + FT_OPEN.length); ftDepth = 1; continue; }
        const keep = ftTailKeep(ftBuf, FT_OPEN);
        await emitText(ftBuf.slice(0, ftBuf.length - keep));
        ftBuf = ftBuf.slice(ftBuf.length - keep);
        return;
      }
      // 段内:开/闭标签都认、配平深度,配平回 0 才出段——嵌套/重复包裹全吞进思考区,一个标签都不漏回正文
      const io = ftBuf.indexOf(FT_OPEN);
      const ic = ftBuf.indexOf(FT_CLOSE);
      if (io >= 0 && (ic < 0 || io < ic)) {
        await emitThink(ftBuf.slice(0, io)); ftBuf = ftBuf.slice(io + FT_OPEN.length); ftDepth++; continue;
      }
      if (ic >= 0) {
        await emitThink(ftBuf.slice(0, ic)); ftBuf = ftBuf.slice(ic + FT_CLOSE.length); ftDepth--; continue;
      }
      const keep = ftTailKeep(ftBuf, FT_OPEN, FT_CLOSE);
      await emitThink(ftBuf.slice(0, ftBuf.length - keep));
      ftBuf = ftBuf.slice(ftBuf.length - keep);
      return;
    }
  };
  const flush = async () => { // 流结束:尾巴按所在通道清账(未闭合 <thinking> 的残余归思考区,别漏回正文)
    const seg = ftBuf; ftBuf = '';
    if (ftDepth > 0) await emitThink(seg); else await emitText(seg);
  };
  return { feed, flush };
}

// —— UTF-16 安全截断(Day88 冲浪舱死锁案家法:裸 slice 不许出家门;码点数字比较,不写 \uD800 字面量) ——
export function scrubLoneSurrogates(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
    } else if (!(c >= 0xdc00 && c <= 0xdfff)) {
      out += s[i];
    }
  }
  return out;
}
