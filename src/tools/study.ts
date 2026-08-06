// src/tools/study.ts
// study · 书房 REST 数据层。
//
// 跟只读模型工具面(shelf/study.list 的 MCP 包装)的关系(别合并,口径不同是有意的):
//   模型工具面 = 喂进对话上下文的只读爪,所以处处设闸(预览120字/list上限30/get全文闸30000字截断),
//           防一次查询把书炸进对话上下文。
//   study = 部署者书房页自己用的 REST 接口,人是主体不是模型上下文,口径反过来:
//           list 上限200(翻目录要多看点)、get/更新回填必须是**真全文**,绝不许截断——
//           编辑页面拿一份被截断的正文去保存,等于拿刀切了部署者的稿子,这是数据损失,不是省token。
// 两边各管各的闸,别想着抽公共函数省事——闸值本身就是各自业务的一部分。
//
// 写权限红线:这个文件是部署者 REST 专用的读写口径。模型工具面(MCP shelf 工具)
// 一个字都不动——写权限绝不能从工具面漏给模型,模型对书房永远只读。

import { embedText, upsertVector, queryVectors, deleteVector } from '../storage/vectorize.ts';
import type { Ai, VectorizeIndex } from '../storage/vectorize.ts';

interface StudyEnv {
  OC_DB: D1Database;
  OC_VECTORIZE: VectorizeIndex;
  AI: Ai;
}

interface MemoryRow {
  id: string;
  project?: string | null;
  category?: string | null;
  title?: string | null;
  tags?: string | null; // D1 里存的是 JSON 数组字符串
  chapter?: string | null;
  content?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  // 触发配置六列,跟 src/tools/deskPanels.ts 读的是同一张表同一批列——见文件下方 LORE_* 校验注释。
  lore_keys?: string | null;
  lore_position?: string | null;
  is_char?: number | null;
  lore_constant?: number | null;
  trigger_mode?: string | null;
  lore_fields?: string | null;
}

const CATEGORIES = ['world', 'plot', 'outline', 'session'];
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
const SEARCH_TOPK_DEFAULT = 10;
const SEARCH_TOPK_MAX = 20;

// ===== 触发配置(世界书/角色卡怎么上场)——跟书架正文同一行,可选字段,不发送=行为跟没这功能之前一样 =====
// 校验口径原样照抄 src/tools/deskPanels.ts 的 deskLoreUpdate(世界书 PUT /api/oc/desk/lore/:id 现有实现)。
// 那是真正在改同一批 lore_* 列的另一个入口——两处校验必须长一个样,改一处记得回去核一遍另一处,
// 不然会出现"书架存得进去,浮窗打不开"或反过来的两头打架。
const LORE_POSITIONS = ['before', 'after', 'char'];
const LORE_TRIGGER_MODES = ['scan', 'presence'];
const LORE_FIELD_KEYS = ['description', 'personality', 'scenario', 'mes_example', 'main_prompt', 'post_history_instructions'] as const;

function validateLoreFields(value: any): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'fields 必须是对象';
  for (const [key, field] of Object.entries(value)) {
    if (!(LORE_FIELD_KEYS as readonly string[]).includes(key)) return `fields.${key} 不是支持的角色字段`;
    if (typeof field !== 'string') return `fields.${key} 必须是字符串`;
    if (field.length > 200000) return `fields.${key} 超过20万字上限`;
  }
  return null;
}

function normalizeLoreFields(value: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of LORE_FIELD_KEYS) if (typeof value?.[key] === 'string' && value[key]) out[key] = value[key];
  return out;
}

// lore_fields(JSON对象字符串)安全解析,跟 parseTags 分开写(那个只认数组,这个只认对象)。
function parseLoreFields(raw: any): Record<string, string> {
  try {
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// ===== 向量 metadata 家法(最重要的一段注释,别删)=====
// 这个索引(OC_VECTORIZE)的 metadata 字段是固定的四个:project / category / title / created_at
// (title 截100字防超限)。Vectorize 的 upsert 是整条覆盖,不是合并式 patch——
// Vectorize upsert 会覆盖整份 metadata，任何字段都不能漏拼。
// 所以 create/update/backfill 三处涉及"重新写一次向量"的地方,只许调这一个函数,不许各自拼 metadata。
// 导出给 tools/desk.ts 的角色卡导入器(importCharacterCard)复用——它落库走自己的 INSERT(要多写
// lore_* 那一串世界书/角色卡专属列,studyCreate 的 body 形状没这些字段),但"重新写一次向量"这件事
// 仍然只许经这一个函数,不在 desk.ts 里另拼一份 metadata。
export async function embedMemory(env: StudyEnv, row: MemoryRow): Promise<void> {
  const title = String(row.title || '');
  const content = String(row.content || '');
  const text = `${title}\n${content.slice(0, 8000)}`;
  const metadata = {
    project: row.project || '',
    category: row.category || '',
    title: title.slice(0, 100),
    created_at: row.created_at || '',
  };
  await upsertVector(env.OC_VECTORIZE, env.AI, row.id, text, metadata);
}

// tags 字段(JSON 数组字符串)安全解析成真数组,解析失败/非数组一律回空数组
function parseTags(raw: any): string[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 换行拍平 + 截断成预览(list/search 用,绝不带全文)
function makePreview(content: any, max: number = 200): string {
  return String(content || '').replace(/[\r\n]+/g, ' ').slice(0, max);
}

// project 的规范化:只剥明确污染性的不可见字符再 trim——ZWSP(0x200B)/LRM/RLM(0x200E/F)/WJ(0x2060)/BOM(0xFEFF)。
// 刻意保留 ZWJ/ZWNJ(0x200D/0x200C):它们是 emoji 序列和部分文字的合法组件,笼统剥 \p{Cf} 会把合法名字改坏。
// 守门判空、写入、精确筛选(list/search)三处必须共用同一个 canonical 值——否则 " 项目1 " 和 "项目1"
// project 必须保持原值，避免写入与精确筛选使用不同规范化结果。
// ⚠️源码刻意不写 \u 十六进制转义(Edit 工具 hex 转义会落成真实控制字节的老坑),用 fromCharCode 拼字符集。
const PROJECT_STRIP_RE = new RegExp('[' + String.fromCharCode(0x200B, 0x200E, 0x200F, 0x2060, 0xFEFF) + ']', 'g');
export function normalizeProject(raw: string): string {
  return raw.replace(PROJECT_STRIP_RE, '').trim();
}

// ===== 输入校验:create 全字段 / update 只校验给出的字段(调用方按需传子集)=====
function validateFields(body: any, opts: { requireCategory: boolean; requireProject?: boolean }): string | null {
  if (opts.requireCategory || body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) {
      return `category 必须是 ${CATEGORIES.join('/')} 四选一`;
    }
  }
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || body.title.length > 200) return 'title 必须是字符串,且不超过200字';
  }
  if (body.content !== undefined) {
    if (typeof body.content !== 'string' || body.content.length > 200000) return 'content 必须是字符串,且不超过200000字';
  }
  if (opts.requireProject || body.project !== undefined) {
    if (typeof body.project !== 'string' || !body.project.trim() || body.project.length > 100) {
      return 'project 必须是非空字符串,且不超过100字';
    }
  }
  if (body.chapter !== undefined) {
    if (typeof body.chapter !== 'string' || body.chapter.length > 100) return 'chapter 必须是字符串,且不超过100字';
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) return 'tags 必须是字符串数组';
    if (body.tags.length > 20) return 'tags 最多20个';
    for (const t of body.tags) {
      if (typeof t !== 'string' || t.length > 50) return 'tags 里每一项必须是字符串,且不超过50字';
    }
  }
  // 触发配置六件套——校验口径照抄 deskLoreUpdate,见上面 LORE_* 常量那段注释。
  if (body.keys !== undefined) {
    if (!Array.isArray(body.keys) || body.keys.some((k: any) => typeof k !== 'string')) return 'keys 必须是字符串数组';
  }
  if (body.position !== undefined && !LORE_POSITIONS.includes(body.position)) return 'position 必须是 before/after/char 之一';
  // is_char/constant 必须是严格布尔:角色卡与普通 world 条目走不同装配路径,"false"/{}/1
  // 这类歪形状静默转真会改变提示词摆位——宁拒不猜,跟 deskLoreUpdate 同一口径。
  if (body.is_char !== undefined && typeof body.is_char !== 'boolean') return 'is_char 必须是布尔值';
  if (body.constant !== undefined && typeof body.constant !== 'boolean') return 'constant 必须是布尔值';
  if (body.trigger_mode !== undefined && !LORE_TRIGGER_MODES.includes(body.trigger_mode)) return 'trigger_mode 必须是 scan/presence 之一';
  if (body.fields !== undefined) {
    const fieldsErr = validateLoreFields(body.fields);
    if (fieldsErr) return fieldsErr;
  }
  return null;
}

// ===== studyList:列表(过滤+分页,不带全文)=====
export async function studyList(env: StudyEnv, params: any): Promise<any> {
  const conditions: string[] = [];
  const values: any[] = [];

  if (params?.category) {
    conditions.push('category = ?');
    values.push(params.category);
  }
  // 空字符串是合法的未归档 project；只在参数真的缺席时才不筛项目。
  // 筛选值过同一个 normalizeProject:写入已规范化,原值直筛会"存进去查不回"。
  if (params?.project !== undefined && params?.project !== null) {
    conditions.push('project = ?');
    values.push(typeof params.project === 'string' ? normalizeProject(params.project) : params.project);
  }
  if (params?.keyword) {
    conditions.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)');
    const kw = `%${params.keyword}%`;
    values.push(kw, kw, kw);
  }
  if (params?.tag) {
    // 剥掉输入自带的双引号,防止把 LIKE '%"标签"%' 这个姿势的语义打歪(照 shelf.ts 同款处理)
    const t = String(params.tag).replace(/"/g, '');
    conditions.push('tags LIKE ?');
    values.push(`%"${t}"%`);
  }

  const rawLimit = Number(params?.limit ?? LIST_LIMIT_DEFAULT);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);

  // 排序提供时间、分类与标题三种口径，避免同组内容被时间序拆散。
  // time=最新在前(默认);chapter=按章节号升序(填了 chapter 的排前、空的沉底再按时间;
  //   章节号建议补零对齐如 01上/01下/02,字符串序才不会 10 排在 2 前);title=标题字典序。
  // ⚠️order 只许查表映射,绝不把用户输入拼进 ORDER BY(SQL 注入的经典口子)。
  const ORDER_SQL: Record<string, string> = {
    time: 'created_at DESC',
    chapter: `(chapter IS NULL OR chapter = '') ASC, chapter ASC, created_at ASC`,
    title: 'title ASC',
  };
  const orderSql = ORDER_SQL[String(params?.order || 'time')] || ORDER_SQL.time;

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT id, project, category, title, chapter, tags, created_at, updated_at, content FROM memories ${where} ORDER BY ${orderSql} LIMIT ?`;
  values.push(limit);

  try {
    const result = await env.OC_DB.prepare(sql).bind(...values).all<MemoryRow>();
    const memories = (result.results || []).map((row: any) => ({
      id: row.id,
      project: row.project,
      category: row.category,
      title: row.title,
      chapter: row.chapter,
      tags: parseTags(row.tags),
      created_at: row.created_at,
      updated_at: row.updated_at,
      preview: makePreview(row.content, 200),
    }));
    // chapter 序在 JS 里再排一遍【自然排序】:SQL 的字符串序会把"第5日"排到"第38日"后面
    // 数字标题按自然数值排序，无需调用方手工补零。⚠️不用 localeCompare numeric——
    // Workers 运行时(workerd)的 ICU 裁剪版对它不可靠(实测排不动),手搓"数字段当数字比、
    // 文字段当文字比"的比较器,行为在哪个运行时都一样。空 chapter 沉底、同章节按时间升序。
    if (String(params?.order || '') === 'chapter') {
      const naturalCompare = (x: string, y: string): number => {
        // 把字符串切成 [文字|数字] 交替的段,数字段按数值比,文字段按码位比
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
      };
      memories.sort((a: any, b: any) => {
        const ac = String(a.chapter || ''), bc = String(b.chapter || '');
        if (!ac && !bc) return String(a.created_at || '') < String(b.created_at || '') ? -1 : 1;
        if (!ac) return 1;
        if (!bc) return -1;
        const byChapter = naturalCompare(ac, bc);
        if (byChapter !== 0) return byChapter;
        return String(a.created_at || '') < String(b.created_at || '') ? -1 : 1;
      });
    }
    return { success: true, count: memories.length, memories };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== studyGet:单条完整返回,content 绝不截断(编辑页回填全文用)=====
export async function studyGet(env: StudyEnv, id: string): Promise<any> {
  try {
    const row = await env.OC_DB.prepare(`SELECT * FROM memories WHERE id = ?`).bind(id).first<MemoryRow>();
    if (!row) return { success: false, error: '书房里没有这本' };
    return {
      success: true,
      id: row.id,
      project: row.project,
      category: row.category,
      title: row.title,
      tags: parseTags(row.tags),
      chapter: row.chapter,
      content: String(row.content || ''), // 全文,不截断
      // 触发配置六件套——书架编辑表单靠这几个字段预填「进场方式」一节的现值,
      // 跟世界书浮窗(desk/lore GET)读的是同一张表同一批列,字段名也对齐,不另发明一套命名。
      keys: parseTags(row.lore_keys),
      position: row.lore_position === 'after' ? 'after' : row.lore_position === 'char' ? 'char' : 'before',
      is_char: !!row.is_char,
      constant: !!row.lore_constant,
      trigger_mode: row.trigger_mode === 'presence' ? 'presence' : 'scan',
      fields: parseLoreFields(row.lore_fields),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== studyCreate:新建一条(D1 是源真相,向量失败不回滚不报失败)=====
export async function studyCreate(env: StudyEnv, body: any): Promise<any> {
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };
  if (typeof body.project === 'string') body.project = normalizeProject(body.project);
  const err = validateFields(body, { requireCategory: true, requireProject: true });
  if (err) return { success: false, error: err };

  const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  const now = new Date().toISOString();
  const project = body.project ?? '';
  const category = body.category;
  const title = body.title ?? '';
  const tags = Array.isArray(body.tags) ? body.tags : [];
  const chapter = body.chapter ?? '';
  const content = body.content ?? '';
  // 触发字段可选——没给就落表定义的默认值(examples/cloudflare/schema/init.sql 那六列 DEFAULT),
  // 不发送这几个字段时的建卡结果,跟加这个功能之前完全一样。
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const position = LORE_POSITIONS.includes(body.position) ? body.position : 'before';
  const isChar = typeof body.is_char === 'boolean' ? body.is_char : false;
  const constant = typeof body.constant === 'boolean' ? body.constant : false;
  const triggerMode = LORE_TRIGGER_MODES.includes(body.trigger_mode) ? body.trigger_mode : 'scan';
  const fields = normalizeLoreFields(body.fields);

  try {
    await env.OC_DB.prepare(
      `INSERT INTO memories
       (id, project, category, title, tags, chapter, content, lore_keys, lore_position, is_char,
        lore_constant, trigger_mode, lore_fields, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, project, category, title, JSON.stringify(tags), chapter, content,
      JSON.stringify(keys), position, isChar ? 1 : 0, constant ? 1 : 0, triggerMode, JSON.stringify(fields),
      now, now,
    ).run();
  } catch (dbErr: any) {
    return { success: false, error: dbErr.message };
  }

  // D1 已经落地(源真相)。向量是锦上添花——失败绝不回滚 D1、绝不让这次 create 报失败,
  // 只在响应里如实带 vector_ok,前端拿这个提示"语义搜索暂时找不到,回头 backfill 补"。
  let vectorOk = true;
  try {
    await embedMemory(env, { id, project, category, title, content, created_at: now });
  } catch (vecErr) {
    vectorOk = false;
    console.error('[study] create 向量化失败(D1 已落地,不回滚):', vecErr);
  }

  return {
    success: true,
    vector_ok: vectorOk,
    id,
    project,
    category,
    title,
    tags,
    chapter,
    content,
    keys,
    position,
    is_char: isChar,
    constant,
    trigger_mode: triggerMode,
    fields,
    created_at: now,
    updated_at: now,
  };
}

// ===== studyUpdate:部分更新,给了哪个字段改哪个;正文/标题/标签/项目/分类变了才重新 embed =====
export async function studyUpdate(env: StudyEnv, id: string, body: any): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };
  if (typeof body.project === 'string') body.project = normalizeProject(body.project);
  const err = validateFields(body, { requireCategory: false });
  if (err) return { success: false, error: err };

  const sets: string[] = [];
  const values: any[] = [];
  let needReembed = false;

  if (body.project !== undefined) { sets.push('project = ?'); values.push(body.project); needReembed = true; }
  if (body.category !== undefined) { sets.push('category = ?'); values.push(body.category); needReembed = true; }
  if (body.title !== undefined) { sets.push('title = ?'); values.push(body.title); needReembed = true; }
  if (body.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(body.tags)); needReembed = true; }
  if (body.chapter !== undefined) { sets.push('chapter = ?'); values.push(body.chapter); }
  if (body.content !== undefined) { sets.push('content = ?'); values.push(body.content); needReembed = true; }
  // 触发字段六件套——只在 body 里给了才落 SET(可选=不带就不碰):防回归重点在这一行,
  // "只带 content 更新正文"不许连带把已经配好的触发词/角色卡设置清成默认值。跟上面几个字段
  // 一样不影响 embed(触发配置不进向量 metadata,见 embedMemory 头上那段注释)。
  if (body.keys !== undefined) { sets.push('lore_keys = ?'); values.push(JSON.stringify(body.keys)); }
  if (body.position !== undefined) { sets.push('lore_position = ?'); values.push(body.position); }
  if (body.is_char !== undefined) { sets.push('is_char = ?'); values.push(body.is_char ? 1 : 0); }
  if (body.constant !== undefined) { sets.push('lore_constant = ?'); values.push(body.constant ? 1 : 0); }
  if (body.trigger_mode !== undefined) { sets.push('trigger_mode = ?'); values.push(body.trigger_mode); }
  if (body.fields !== undefined) { sets.push('lore_fields = ?'); values.push(JSON.stringify(normalizeLoreFields(body.fields))); }

  if (sets.length === 0) return { success: false, error: '没给要改的字段' };

  const now = new Date().toISOString();
  sets.push('updated_at = ?');
  values.push(now);
  values.push(id); // WHERE id = ?

  try {
    const meta = await env.OC_DB.prepare(
      `UPDATE memories SET ${sets.join(', ')} WHERE id = ?`
    ).bind(...values).run();
    // 不许先查后写(TOCTOU 空隙):直接看这次 UPDATE 改动了几行来判断存在性
    if (!meta.meta || meta.meta.changes === 0) {
      return { success: false, error: '书房里没有这本' };
    }
  } catch (dbErr: any) {
    return { success: false, error: dbErr.message };
  }

  let vectorOk = true;
  if (needReembed) {
    try {
      // 重新 embed 前把完整行读回来(部分更新只改了几个字段,metadata 四件套必须拼完整的当前态)。
      // ⚠️两个 PUT 并发修改同一条时，慢请求可能用旧版本覆盖新向量。
      // 造成向量与 D1 内容错配——不是数据损坏(D1 恒为源真相),只是语义搜索暂时对不准;单人书房两手同改
      // 同一条概率≈0,且下次编辑或 backfill 即自愈。不为这个上版本号守门,复杂度不值。
      const row = await env.OC_DB.prepare(`SELECT * FROM memories WHERE id = ?`).bind(id).first<MemoryRow>();
      if (row) await embedMemory(env, row);
    } catch (vecErr) {
      vectorOk = false;
      console.error('[study] update 向量化失败(D1 已落地,不回滚):', vecErr);
    }
  }

  return { success: true, vector_ok: vectorOk, id, updated_at: now };
}

// ===== studyDelete:删书 + 尽力删向量(孤儿向量无害,查回来在 D1 join 不到会被过滤掉)=====
// memories 已是唯一正本，删除时无需维护退休的指针层。
export async function studyDelete(env: StudyEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  try {
    const meta = await env.OC_DB.prepare(`DELETE FROM memories WHERE id = ?`).bind(id).run();
    if ((meta.meta?.changes ?? 0) === 0) {
      return { success: false, error: '书房里没有这本' };
    }
  } catch (dbErr: any) {
    return { success: false, error: dbErr.message };
  }

  try {
    await deleteVector(env.OC_VECTORIZE, id);
  } catch (vecErr) {
    // 孤儿向量无害:studySearch 拿 id 回 D1 查不到会被滤掉,不影响正确性,这里只记日志
    console.error('[study] delete 向量删除失败(D1 已删,留孤儿向量,无害):', vecErr);
  }

  return { success: true, id };
}

// ===== studySearch:语义搜索,只认 D1 里真存在的行(向量孤儿滤掉)=====
export async function studySearch(env: StudyEnv, params: any): Promise<any> {
  const q = params?.q;
  if (!q || typeof q !== 'string' || !q.trim()) return { success: false, error: 'q 必填' };

  const rawTopK = Number(params?.topK ?? SEARCH_TOPK_DEFAULT);
  const topK = Math.min(Math.max(Number.isFinite(rawTopK) ? rawTopK : SEARCH_TOPK_DEFAULT, 1), SEARCH_TOPK_MAX);

  // project 筛选语义与 studyList 对齐:参数在场(字符串)就精确筛 canonical 值。
  // ''(未归档)在语义搜索里【刻意不支持】:向量查询按全局 topK 截断后再后筛会漏召回——与其静默给错答案,
  // 不如把边界说清楚(REST 门本就把空串收成 undefined,这条边界对外不可达;真要做未归档语义搜索,
  // 得走哨兵 metadata 或 over-fetch 方案,另立工单)。list 走 D1,未归档照常支持。
  const projParam = typeof params?.project === 'string' ? normalizeProject(params.project) : undefined;
  if (projParam === '') {
    return { success: false, error: '语义搜索暂不支持未归档(空 project)筛选——用 list 精确查未归档,或去掉 project 参数全库搜' };
  }
  const filter: Record<string, any> = {};
  if (projParam) filter.project = projParam;
  if (params?.category) filter.category = params.category;

  let matches: Array<{ id: string; score: number; metadata?: Record<string, any> }>;
  try {
    matches = await queryVectors(env.OC_VECTORIZE, env.AI, q, topK, Object.keys(filter).length ? filter : undefined);
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  if (!matches.length) return { success: true, count: 0, memories: [] };

  const ids = matches.map((m) => m.id);
  const scoreById = new Map(matches.map((m) => [m.id, m.score]));

  try {
    const placeholders = ids.map(() => '?').join(', ');
    const result = await env.OC_DB.prepare(
      `SELECT id, project, category, title, chapter, tags, created_at, updated_at, content FROM memories WHERE id IN (${placeholders})`
    ).bind(...ids).all<MemoryRow>();

    const rows = (result.results || []) as any[];
    const memories = rows
      // 严格后筛:param 在场时只留 project 精确等于 canonical 值的行(''=未归档同样生效),
      // 与 studyList 同一口径;向量侧 filter 空串没挂,这里才是语义的守门人
      .filter((row) => projParam === undefined || row.project === projParam)
      .map((row) => ({
        id: row.id,
        project: row.project,
        category: row.category,
        title: row.title,
        chapter: row.chapter,
        tags: parseTags(row.tags),
        created_at: row.created_at,
        updated_at: row.updated_at,
        preview: makePreview(row.content, 200),
        score: scoreById.get(row.id) ?? 0,
      }))
      // 向量孤儿(D1 里已经没这行了)会因为不在 rows 里而自然被滤掉;这里按 score 降序排一遍
      .sort((a, b) => b.score - a.score);

    return { success: true, count: memories.length, memories };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== studyBackfill:全表补向量(幂等,upsert 本来就是覆盖)=====
export async function studyBackfill(env: StudyEnv): Promise<any> {
  try {
    const result = await env.OC_DB.prepare(
      `SELECT id, title, content, project, category, created_at FROM memories`
    ).all<MemoryRow>();
    const rows = (result.results || []) as MemoryRow[];

    let embedded = 0;
    const failed: string[] = [];
    for (const row of rows) {
      try {
        await embedMemory(env, row);
        embedded++;
      } catch (err) {
        console.error(`[study] backfill 单条向量化失败 id=${row.id}:`, err);
        failed.push(row.id);
      }
    }
    return { success: true, embedded, failed };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
