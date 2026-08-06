// src/tools/reading.ts
// reading · 读书角数据层：oc_chapters 与 oc_comments 的 REST/工具共用口径。
//
// 跟 shelf.ts / study.ts 的关系是同一套家法的第三份抄本(别合并,口径不同是有意的——照抄 study.ts 头注释的道理):
//   REST 那一组(chaptersList/chapterGet/chapterCreate/…)= 部署者书房页自己用,人是主体不是模型上下文,
//     list 上限大(200)、get 必须真全文绝不截断(编辑回填用,截了等于拿刀切部署者的稿子)。
//   bookclub(env,input) = 面向读者的读书角爪,两段式(list 给预览/get 带 id 才读全文)+ 处处设闸,跟 shelf.ts 是同款脾气,
//     只是数据源从 memories 换成 oc_chapters/oc_comments——读书角本来就是"广场",谁进来看到的都是同一份数据。
//
// 写权限红线:章节的创建/更新/删除/发布/撤回只在 REST 这组函数里,不进 bookclub——bookclub 对章节永远只读,
// 唯一的写权限是留言(commentPost),且 author 由调用方硬编码传入,绝不从请求体里读(防调用方冒充宿主身份)。
//
// 章总结向量生命周期钩子(打字桌S2 Fix1):update/delete/unpublish 三处写路径各自 best-effort 同步
// chsum_<id> 向量(delete/unpublish→删向量,update 改了 summary/title 且发布中且非空→重新 embed,
// summary 被改空→删向量)。跟 study.ts embedMemory 同一条家法:D1 是源真相,向量失败绝不回滚/绝不
// 让本次写操作报失败,只 console.error 留痕(参见 desk.ts embedChapterSummary 头注释)。

import { deleteVector } from '../storage/vectorize';
import type { Ai, VectorizeIndex } from '../storage/vectorize';
import { embedChapterSummary } from './desk';
import { normalizeProject } from './study';

interface ReadingEnv {
  OC_DB: D1Database;
  OC_VECTORIZE: VectorizeIndex;
  AI: Ai;
}

export interface CommentAuthor {
  authorId: string;
  authorType: 'owner' | 'ai';
  displayName: string;
}

interface ChapterRow {
  id: string;
  project?: string | null;
  chapter_no?: string | null;
  title?: string | null;
  content?: string | null;
  summary?: string | null;
  status?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  published_at?: string | null;
  comment_count?: number | null;
}

const STATUSES = ['draft', 'published'];
const CHAPTERS_LIST_DEFAULT = 50;
const CHAPTERS_LIST_MAX = 200;
const BOOKCLUB_CHAPTERS_DEFAULT = 10;
const BOOKCLUB_CHAPTERS_MAX = 30;
const COMMENTS_LIST_DEFAULT = 50;
const COMMENTS_LIST_MAX = 100;
const CONTENT_MAX = 30000; // bookclub read 全文闸,口径同 shelf.ts:超了截断,别把一整章塞爆上下文
const COMMENT_MAX_CHARS = 2000;

function clamp(n: any, fallback: number, min: number, max: number): number {
  const v = Number(n);
  return Math.min(Math.max(Number.isFinite(v) ? v : fallback, min), max);
}

// 换行拍平 + 截断成预览(章节列表用,绝不带全文)
function makePreview(content: any, max: number): string {
  return String(content || '').replace(/[\r\n]+/g, ' ').slice(0, max);
}

// 章节号自然排序(照 study.ts 里的手搓比较器思路抄的:workerd 的 ICU 裁剪版对 localeCompare 的 numeric
// 选项不可靠,手搓"数字段按数值比、文字段按码位比"的比较器,行为在哪个运行时都一样)
function naturalCompare(x: string, y: string): number {
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

// ===== 输入校验(照 study.ts validateFields 集中一处的风格;update 只校验给出的字段)=====
function validateFields(body: any): string | null {
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.length > 200) return 'title 必须是字符串,且不超过200字';
  }
  if (body.chapter_no !== undefined) {
    if (typeof body.chapter_no !== 'string' || body.chapter_no.length > 100) return 'chapter_no 必须是字符串,且不超过100字';
  }
  if (body.project !== undefined) {
    if (typeof body.project !== 'string' || body.project.length > 100) return 'project 必须是字符串,且不超过100字(允许空字符串)';
  }
  if (body.summary !== undefined) {
    // summary 承载整篇章节总结，上限 12000 字。
    // (一章=一个主题篇章,浓缩1-5天剧情,存量最长8.4k字)——它就是打字桌常驻/向量召回的正文本体。
    // 嵌入侧有desk.ts embedChapterSummary的4000码点截断护栏兜着,超长不炸嵌入。
    if (typeof body.summary !== 'string' || body.summary.length > 12000) return 'summary 必须是字符串,且不超过12000字';
  }
  if (body.content !== undefined) {
    if (typeof body.content !== 'string' || body.content.length > 500000) return 'content 必须是字符串,且不超过500000字';
  }
  return null;
}

// ===== 章节查询共用内核:REST chaptersList 和 bookclub chapters 动作共用同一段 SQL 拼装,
//   只是 project/status/limit/预览长度不同——这不是 shelf/study 那种"刻意各管各的"分家,
//   两处调用都在这一个文件里、都归我一个人管,拆成私有 helper 纯粹是省得复制一份 SQL 出岔子。=====
async function queryChapters(
  env: ReadingEnv,
  opts: { project?: string; status?: string; limit: number; previewLen: number }
): Promise<any[]> {
  const conditions: string[] = [];
  const values: any[] = [];
  if (opts.project) {
    conditions.push('c.project = ?');
    values.push(opts.project);
  }
  if (opts.status) {
    conditions.push('c.status = ?');
    values.push(opts.status);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // published 视角天然要按章节号读(追更顺序),其余(草稿箱/全量)按创建时间新的在前——
  // 章节号的最终排序在 JS 里用 naturalCompare 再排一遍(SQL 字符串序会把"第5章"排到"第38章"后面,同 study.ts 的坑)。
  const chapterOrder = opts.status === 'published';
  const baseOrderSql = chapterOrder ? 'c.created_at ASC' : 'c.created_at DESC';
  // ⚠️published 视角须先取满上限、自然排序，最后再切 limit。
  // 若 SQL 先按 created_at LIMIT,乱序补写的老章节会被截在窗口外,JS 排序救不回没取到的行——
  // "读者视角漏章"比多取几行贵得多。个人连载全量封顶 CHAPTERS_LIST_MAX(200),取满不心疼。
  const sqlLimit = chapterOrder ? CHAPTERS_LIST_MAX : opts.limit;
  const sql = `SELECT c.id, c.project, c.chapter_no, c.title, c.summary, c.status, c.created_at, c.updated_at, c.published_at, c.content,
      (SELECT COUNT(*) FROM oc_comments cm WHERE cm.chapter_id = c.id) AS comment_count
    FROM oc_chapters c ${where} ORDER BY ${baseOrderSql} LIMIT ?`;
  values.push(sqlLimit);

  const result = await env.OC_DB.prepare(sql).bind(...values).all<ChapterRow>();
  const chapters = (result.results || []).map((row: any) => ({
    id: row.id,
    project: row.project,
    chapter_no: row.chapter_no,
    title: row.title,
    summary: row.summary,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    comment_count: row.comment_count ?? 0,
    preview: makePreview(row.content, opts.previewLen),
  }));

  if (chapterOrder) {
    chapters.sort((a: any, b: any) => {
      const ac = String(a.chapter_no || ''), bc = String(b.chapter_no || '');
      if (!ac && !bc) return String(a.created_at || '') < String(b.created_at || '') ? -1 : 1;
      if (!ac) return 1; // 空章节号沉底
      if (!bc) return -1;
      const byChapter = naturalCompare(ac, bc);
      if (byChapter !== 0) return byChapter;
      return String(a.created_at || '') < String(b.created_at || '') ? -1 : 1;
    });
    return chapters.slice(0, opts.limit); // 排完序才切 limit(取满上限见上面 sqlLimit 注释)
  }
  return chapters;
}

// ===== chaptersList:REST 用,列表(过滤+分页,不带全文,预览200字)=====
export async function chaptersList(env: ReadingEnv, params: any): Promise<any> {
  if (params?.status !== undefined && !STATUSES.includes(params.status)) {
    return { success: false, error: `status 必须是 ${STATUSES.join('/')} 二选一` };
  }
  const limit = clamp(params?.limit, CHAPTERS_LIST_DEFAULT, 1, CHAPTERS_LIST_MAX);
  try {
    const chapters = await queryChapters(env, {
      project: params?.project,
      status: params?.status,
      limit,
      previewLen: 200,
    });
    return { success: true, count: chapters.length, chapters };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== chapterGet:REST 用,单条完整返回,content 绝不截断(编辑页回填全文用)=====
export async function chapterGet(env: ReadingEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  try {
    const row = await env.OC_DB.prepare(`SELECT * FROM oc_chapters WHERE id = ?`).bind(id).first<ChapterRow>();
    if (!row) return { success: false, error: '读书角里没有这一章' };
    return {
      success: true,
      id: row.id,
      project: row.project,
      chapter_no: row.chapter_no,
      title: row.title,
      content: String(row.content || ''), // 全文,不截断
      summary: row.summary,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      published_at: row.published_at,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== chapterCreate:新建一章,默认 draft;若一步到位传 status='published',published_at 当场盖章
//   (避免绕开 chapterPublish 的 COALESCE 语义在别处再插一次 publish 逻辑)=====
export async function chapterCreate(env: ReadingEnv, body: any): Promise<any> {
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };
  const err = validateFields(body);
  if (err) return { success: false, error: err };
  if (body.status !== undefined && !STATUSES.includes(body.status)) {
    return { success: false, error: `status 必须是 ${STATUSES.join('/')} 二选一` };
  }

  // 客户端可提供 ch_ 前缀 id，供网络歧义重试保持幂等。
  // 同 id 撞主键,撞上了查一把:真是同一条(已经建成)就按成功返回带 deduped 标,不造双胞胎章。
  // 不带 id 的老调用方(读书角)行为逐字节不变。
  let id = `ch_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  if (body.id !== undefined) {
    if (typeof body.id !== 'string' || !/^ch_[A-Za-z0-9_]{1,60}$/.test(body.id)) {
      return { success: false, error: 'id 格式不对(须 ch_ 前缀的字母数字下划线)' };
    }
    id = body.id;
  }
  const now = new Date().toISOString();
  const project = typeof body.project === 'string' ? normalizeProject(body.project) : (body.project ?? '');
  const chapterNo = body.chapter_no ?? '';
  const title = body.title ?? '';
  const content = body.content ?? '';
  const summary = body.summary ?? '';
  const status = body.status ?? 'draft';
  const publishedAt = status === 'published' ? now : null;

  try {
    await env.OC_DB.prepare(
      `INSERT INTO oc_chapters (id, project, chapter_no, title, content, summary, status, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, project, chapterNo, title, content, summary, status, now, now, publishedAt).run();
  } catch (dbErr: any) {
    // 撞主键+客户端自带id=幂等重试(上一发其实成功了只是响应丢了):查出同id行按成功返回,不再插一条
    if (body.id !== undefined && /UNIQUE|PRIMARY/i.test(String(dbErr.message || ''))) {
      try {
        const existing = await env.OC_DB.prepare(`SELECT id, status FROM oc_chapters WHERE id = ?`).bind(id).first<any>();
        if (existing) return { success: true, id, status: existing.status, deduped: true };
      } catch { /* 查不动就按原错误报 */ }
    }
    return { success: false, error: dbErr.message };
  }

  // 一步到位建章即发布(打字桌S2重工Fix A):这条路径绕开 chapterPublish,不会触发它那份 publish 钩子,
  // 也不经过 chapterUpdate 的 summary/title/project 触发链——必须在这里单独补一次 best-effort embed。
  // D1 已经落地,向量失败不回滚、不让 create 报失败,只留痕(同文件其它钩子同一条家法)。
  // summary 是嵌入 gist，content 是注入本体；任一非空都应建立向量，嵌入优先 summary。
  if (status === 'published' && (String(summary).trim() || String(content).trim())) {
    try {
      await embedChapterSummary(env, {
        id, title, summary, content, project, chapter_no: chapterNo, created_at: now,
      });
    } catch (vecErr) {
      console.error('[reading] create 章总结向量同步失败(D1 已落地,不回滚):', vecErr);
    }
  }

  return {
    success: true,
    id, project, chapter_no: chapterNo, title, content, summary, status,
    created_at: now, updated_at: now, published_at: publishedAt,
  };
}

// ===== chapterUpdate:部分更新,给了哪个字段改哪个 =====
// ⚠️status 故意不走这里改:发布/撤回走 chapterPublish/chapterUnpublish 专用接口,免得部分更新
//   绕开 published_at 的 COALESCE 语义(撤回重发不重报晨报的不变式,靠"只有一个入口能碰它"守住)。
export async function chapterUpdate(env: ReadingEnv, id: string, body: any): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };
  const err = validateFields(body);
  if (err) return { success: false, error: err };

  const sets: string[] = [];
  const values: any[] = [];
  if (body.project !== undefined) { sets.push('project = ?'); values.push(typeof body.project === 'string' ? normalizeProject(body.project) : body.project); }
  if (body.chapter_no !== undefined) { sets.push('chapter_no = ?'); values.push(body.chapter_no); }
  if (body.title !== undefined) { sets.push('title = ?'); values.push(body.title); }
  if (body.content !== undefined) { sets.push('content = ?'); values.push(body.content); }
  if (body.summary !== undefined) { sets.push('summary = ?'); values.push(body.summary); }

  if (sets.length === 0) return { success: false, error: '没给要改的字段' };

  const now = new Date().toISOString();
  sets.push('updated_at = ?');
  values.push(now);
  values.push(id); // WHERE id = ?

  try {
    const meta = await env.OC_DB.prepare(
      `UPDATE oc_chapters SET ${sets.join(', ')} WHERE id = ?`
    ).bind(...values).run();
    // 不先查后写(TOCTOU 空隙):直接看这次 UPDATE 改动了几行判断存在性
    if (!meta.meta || meta.meta.changes === 0) {
      return { success: false, error: '读书角里没有这一章' };
    }
  } catch (dbErr: any) {
    return { success: false, error: dbErr.message };
  }

  // 章总结向量同步:summary/title/project 真的被这次更新碰过才值得重新算(打字桌S2重工Fix B:project
  // 挪动跟 summary/title 改动同权——embedChapterSummary 是整条记录覆盖式 upsert,metadata.project 直接从
  // 传入行读,project 单独变、summary/title 不变也一样会留一条挂着旧 project 的陈旧向量,必须一并触发。
  // 内容/章节号等字段跟 chsum 向量的 embed 文本/metadata 都无关,别做无意义的重新 embed。D1 已经落地——
  // 向量失败绝不回滚、绝不让 update 报失败,只留痕(同 study.ts embedMemory 家法)。
  // 无 summary 时嵌入源来自 content 头部，因此 content 变化也必须触发重嵌。
  if (body.summary !== undefined || body.title !== undefined || body.project !== undefined || body.content !== undefined) {
    try {
      const row = await env.OC_DB.prepare(`SELECT * FROM oc_chapters WHERE id = ?`).bind(id).first<ChapterRow>();
      const hasKey = !!(String(row?.summary || '').trim() || String(row?.content || '').trim());
      if (row && row.status === 'published' && hasKey) {
        await embedChapterSummary(env, {
          id: row.id, title: row.title || '', summary: row.summary || '', content: row.content || '',
          project: row.project || '', chapter_no: row.chapter_no || '', created_at: row.created_at || '',
        });
      } else {
        // 未发布,或两格都被改空——都不该留着一条陈旧向量继续被召回命中
        await deleteVector(env.OC_VECTORIZE, `chsum_${id}`);
      }
    } catch (vecErr) {
      console.error('[reading] update 章总结向量同步失败(D1 已落地,不回滚):', vecErr);
    }
  }

  return { success: true, id, updated_at: now };
}

// ===== chapterDelete:级联删该章评论(db.batch 两条语句,不先查后写)=====
export async function chapterDelete(env: ReadingEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  try {
    const results = await env.OC_DB.batch([
      env.OC_DB.prepare(`DELETE FROM oc_comments WHERE chapter_id = ?`).bind(id),
      env.OC_DB.prepare(`DELETE FROM oc_chapters WHERE id = ?`).bind(id),
    ]);
    const chapterChanges = results[1]?.meta?.changes ?? 0;
    if (chapterChanges === 0) return { success: false, error: '读书角里没有这一章' };
    // 章没了,它的 chsum 向量也不该继续留着被召回命中——best-effort,D1 已经落地,向量失败不回滚。
    try {
      await deleteVector(env.OC_VECTORIZE, `chsum_${id}`);
    } catch (vecErr) {
      console.error('[reading] delete 章总结向量清理失败(D1 已落地,不回滚):', vecErr);
    }
    return { success: true, id, comments_deleted: results[0]?.meta?.changes ?? 0 };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== chapterPublish:status→published,published_at=COALESCE(published_at, now)(撤回重发不重报晨报)=====
export async function chapterPublish(env: ReadingEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  const now = new Date().toISOString();
  try {
    const meta = await env.OC_DB.prepare(
      `UPDATE oc_chapters SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?`
    ).bind(now, now, id).run();
    if (!meta.meta || meta.meta.changes === 0) return { success: false, error: '读书角里没有这一章' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  // 发布这一刻正是"该有向量却没有"的空窗口起点(打字桌S2重工Fix A):publish 只改 status,
  // 不碰 summary/title,所以不属于 chapterUpdate 那条 summary/title/project 触发链——必须在这里单独补一次。
  // D1 已经落地,向量失败不回滚、不让 publish 报失败,只留痕(同文件其它钩子同一条家法)。
  try {
    const row = await env.OC_DB.prepare(`SELECT * FROM oc_chapters WHERE id = ?`).bind(id).first<ChapterRow>();
    const hasKey = !!(String(row?.summary || '').trim() || String(row?.content || '').trim());
    // 重嵌前再次检查 status，避免并发撤稿后复活草稿向量。
    // 全套版本号串行化调停=工单登记的刻意不做——水化关卡按 status='published' 硬过滤兜住正确性,
    // 残余=陈旧向量浪费一个召回名额,backfill 即调停。
    if (row && row.status === 'published' && hasKey) {
      await embedChapterSummary(env, {
        id: row.id, title: row.title || '', summary: row.summary || '', content: row.content || '',
        project: row.project || '', chapter_no: row.chapter_no || '', created_at: row.created_at || '',
      });
    }
  } catch (vecErr) {
    console.error('[reading] publish 章总结向量同步失败(D1 已落地,不回滚):', vecErr);
  }

  return { success: true, id, status: 'published' };
}

// ===== chapterUnpublish:status→draft,published_at 保留(不清空,下次重发照样不重报)=====
export async function chapterUnpublish(env: ReadingEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  const now = new Date().toISOString();
  try {
    const meta = await env.OC_DB.prepare(
      `UPDATE oc_chapters SET status = 'draft', updated_at = ? WHERE id = ?`
    ).bind(now, id).run();
    if (!meta.meta || meta.meta.changes === 0) return { success: false, error: '读书角里没有这一章' };
    // 撤回成草稿的章不该再被"往事区"召回命中(装配引擎读的是 D1 published 状态,但向量提示本身
    // 也该同步清掉,别留一条指向已撤回内容的死向量)——best-effort,D1 已经落地,向量失败不回滚。
    try {
      await deleteVector(env.OC_VECTORIZE, `chsum_${id}`);
    } catch (vecErr) {
      console.error('[reading] unpublish 章总结向量清理失败(D1 已落地,不回滚):', vecErr);
    }
    return { success: true, id, status: 'draft' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== commentsList:某一章的评论,按 created_at ASC(楼从老到新),limit 默认50夹1~100 =====
// publishedOnly：模型侧 bookclub/corner_comments 只能读取已发布章节。
// 章节撤回成 draft 后,read 拒得掉正文,但楼里的讨论一样会剧透被撤回的内容,published 边界要焊到评论这一层。
// REST(部署者的门)不带这个开关,草稿的楼她自己当然能看。守门焊进查询语句(EXISTS 子查询),不先查后读。
export async function commentsList(env: ReadingEnv, params: any, opts?: { publishedOnly?: boolean }): Promise<any> {
  const chapterId = params?.chapter_id;
  if (!chapterId) return { success: false, error: '缺 chapter_id' };
  const limit = clamp(params?.limit, COMMENTS_LIST_DEFAULT, 1, COMMENTS_LIST_MAX);
  try {
    const gate = opts?.publishedOnly
      ? `AND EXISTS (SELECT 1 FROM oc_chapters ch WHERE ch.id = oc_comments.chapter_id AND ch.status = 'published')`
      : '';
    const result = await env.OC_DB.prepare(
      `SELECT id, chapter_id, author_id, author_type, display_name, content, reply_to, created_at
       FROM oc_comments WHERE chapter_id = ? ${gate} ORDER BY created_at ASC, id ASC LIMIT ?`
    ).bind(chapterId, limit).all<any>();
    if (opts?.publishedOnly && !(result.results || []).length) {
      // 楼是空的可能有两种:真没人留言,或章节不存在/未发布。模型侧统一回后者口径也不对——
      // 查一把章节状态给个诚实的空态(这一步只影响提示文案,不影响守门,守门在上面的 EXISTS)。
      const ch = await env.OC_DB.prepare(`SELECT status FROM oc_chapters WHERE id = ?`).bind(chapterId).first<any>();
      if (!ch || ch.status !== 'published') return { success: false, error: '这一章不存在,或者还没发布' };
    }
    return { success: true, count: result.results?.length ?? 0, comments: result.results || [] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== commentPost:守门焊进写语句(不先查后写)——章节必须存在且已发布,回复的楼必须在这一章 =====
// author 由调用方(服务端)硬编码传入,来源是已认证的调用者身份,绝不收请求体里的 author。
export async function commentPost(env: ReadingEnv, body: any, author: CommentAuthor): Promise<any> {
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };
  const chapterId = body.chapter_id;
  if (!chapterId) return { success: false, error: '缺 chapter_id' };
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return { success: false, error: '留言内容不能为空' };
  if (content.length > COMMENT_MAX_CHARS) return { success: false, error: `留言最多${COMMENT_MAX_CHARS}字` };
  const replyTo = body.reply_to || null;

  const id = `cm_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  const now = new Date().toISOString();

  try {
    const meta = await env.OC_DB.prepare(
      `INSERT INTO oc_comments (id, chapter_id, author_id, author_type, display_name, content, reply_to, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM oc_chapters WHERE id = ? AND status = 'published')
         AND (? IS NULL OR EXISTS (SELECT 1 FROM oc_comments WHERE id = ? AND chapter_id = ?))`
    ).bind(id, chapterId, author.authorId, author.authorType, author.displayName, content, replyTo, now, chapterId, replyTo, replyTo, chapterId).run();
    if (!meta.meta || meta.meta.changes === 0) {
      return { success: false, error: '章节不存在/未发布,或回复的楼不在这一章' };
    }
  } catch (dbErr: any) {
    return { success: false, error: dbErr.message };
  }

  return {
    success: true, id, chapter_id: chapterId,
    author_id: author.authorId, author_type: author.authorType, display_name: author.displayName,
    content, reply_to: replyTo, created_at: now,
  };
}

// ===== commentDelete:REST 馆长删除用 =====
export async function commentDelete(env: ReadingEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  try {
    const meta = await env.OC_DB.prepare(`DELETE FROM oc_comments WHERE id = ?`).bind(id).run();
    if (!meta.meta || meta.meta.changes === 0) return { success: false, error: '这条留言不存在' };
    return { success: true, id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== bookclub 内部动作:chapters/read,只认 published,预览/闸口径比 REST 紧得多(照 shelf.ts 的脾气)=====
async function bookclubChapters(env: ReadingEnv, input: any): Promise<any> {
  const limit = clamp(input?.limit, BOOKCLUB_CHAPTERS_DEFAULT, 1, BOOKCLUB_CHAPTERS_MAX);
  try {
    const chapters = await queryChapters(env, {
      project: input?.project,
      status: 'published',
      limit,
      previewLen: 120,
    });
    return { success: true, count: chapters.length, chapters };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function bookclubRead(env: ReadingEnv, input: any): Promise<any> {
  if (!input?.id) return { success: false, error: 'read 要带 id(先 chapters 翻目录拿 id)' };
  try {
    const row = await env.OC_DB.prepare(
      `SELECT * FROM oc_chapters WHERE id = ? AND status = 'published'`
    ).bind(String(input.id)).first<ChapterRow>();
    if (!row) return { success: false, error: '这一章不存在,或者还没发布' };
    let content = String(row.content || '');
    if (content.length > CONTENT_MAX) {
      const extra = content.length - CONTENT_MAX;
      content = content.slice(0, CONTENT_MAX) + `\n…(内容太长,截断在30000字,后面还有${extra}字)`;
    }
    return {
      success: true,
      id: row.id,
      project: row.project,
      chapter_no: row.chapter_no,
      title: row.title,
      content,
      summary: row.summary,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      published_at: row.published_at,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// === 读书角爪 bookclub:action=chapters(默认,只看published)/read(带id读全文)/comments/comment(留言,author=ai) ===
// 工具描述沿用 shelf.ts 的防串台句式(由 tools.ts 里的 TOOL_DEFS 条目负责写,不在这个文件里)。
export async function bookclub(env: ReadingEnv, input: any): Promise<any> {
  const action = input?.action || 'chapters';
  switch (action) {
    case 'chapters':
      return bookclubChapters(env, input || {});
    case 'read':
      return bookclubRead(env, input || {});
    case 'comments':
      if (!input?.chapter_id) return { success: false, error: 'comments 要带 chapter_id' };
      // 复用该分发器的模型工具只能读取已发布章节。
      return commentsList(env, { chapter_id: input.chapter_id, limit: input.limit }, { publishedOnly: true });
    case 'comment':
      if (!input?.chapter_id) return { success: false, error: 'comment 要带 chapter_id' };
      if (!input?.content) return { success: false, error: 'comment 要带 content' };
      return { success: false, error: '留言必须通过带鉴权上下文的 REST 或 MCP 入口提交' };
    default:
      return { success: false, error: '未知动作' };
  }
}
