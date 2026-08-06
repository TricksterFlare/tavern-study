// src/tools/deskWindows.ts
// 打字桌写作窗与楼层 CRUD。
// 跟 deskRecipes.ts(S2 配方CRUD)分文件放,同一条理由——"部署者拿包缝配方"和"部署者在窗口里写字"
// 是两类活。id 生成/JSON兜底家法照抄 desk.ts/deskRecipes.ts 头注释那套(每文件各自小份复制)。
//
// 楼层编辑/truncate 必须联动时光带双栅栏(工单§4 D):这里只负责"先栅栏、再写、后栅栏"的调用顺序,
// 栅栏本体(CAS/坏形状修复/段数封顶)全在 chat/deskTimeline.ts,别在这里另起一份判断逻辑。

import { invalidateDeskTimelineIfFolded, fenceDeskTimelineAfterWrite, SEED_TIMELINE_STATE, updateDeskTimelineTexts } from '../chat/deskTimeline';
import { scrubLoneSurrogates } from '../shared/text';
import { STATEBOARD_MAX_BYTES } from '../core/stateBoard.ts'; // 手改与机器写入共享同一字节上限(核心纯函数模块,不经 chat/desk.ts 转手)

interface DeskWindowsEnv {
  OC_DB: D1Database;
  [k: string]: any;
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function safeJsonStringify(v: any): string {
  try { return JSON.stringify(v ?? {}); } catch { return '{}'; }
}

function safeJsonParse(raw: any, fallback: any): any {
  if (raw === undefined || raw === null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// 状态板/vars 的形状闸:只收纯对象(拒数组/拒基本类型)——同 chat/desk.ts parseStateBoard 的
// 判据(工单§4 C"Board shape-validate: plain object, reject arrays/primitives"),这里给手改
// PUT /windows/:id 用同一把尺子,别让手改绕开机器写入路径的规矩。
function isPlainObject(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 状态板字节闸必须与机器写入路径 parseStateBoard 完全
// 对齐两条尺子——①顶层纯对象(上面 isPlainObject)②序列化后 UTF-8 字节量≤STATEBOARD_MAX_BYTES,
// 别的都不管。
//
// 手改路径不得另设比机器路径更窄的逐键形状规则。
// round-trip坑):机器路径(parseStateBoard)只验"顶层纯对象+8KB",数字/布尔/null/嵌套对象都能
// 落进板子里——手动闸比机器闸更严,后果是模型写过一次带数字/嵌套值的键之后,部署者想经手动PUT
// 原样保存整块板子(哪怕只改别的键)都会被这条闸卡死,round-trip直接断裂。物理落库层不该比
// 产生数据的那条路径更挑剔,收紧到跟机器闸完全一致——不设键数/单值粒度闸,字节总闸按比例原则
// 已经够用。
function stateBoardTooBig(board: Record<string, any>): boolean {
  try { return new TextEncoder().encode(JSON.stringify(board)).length > STATEBOARD_MAX_BYTES; }
  catch { return true; } // 序列化都失败(循环引用等畸形输入),当超限拒,不放行未知形状糊过闸口
}

const FLOOR_CONTENT_MAX = 50000; // 就地改楼层正文闸口径照 editorial.ts EDIT_ASSISTANT_MAX_LEN 抄一份

// 复合序比较(纯函数,导出给 verify_desk_chat.mjs 镜像断言):row 是否严格排在 anchor 之后——
// 跟 deskWindowTruncate 里内嵌的 SQL 条件 `created_at > ?2 OR (created_at = ?2 AND id > ?3)`
// 是同一条判据的 JS 版本,生产代码走 SQL(D1 侧比较,不用先把整表拉回 worker 内存),这个函数
// 单纯是给验证脚本一份可以直接跑断言的镜像,不在请求路径上被调用。
export function isStrictlyAfterAnchor(row: { created_at: string; id: string }, anchor: { created_at: string; id: string }): boolean {
  return row.created_at > anchor.created_at || (row.created_at === anchor.created_at && row.id > anchor.id);
}

// ===== POST /api/oc/desk/windows =====
export async function deskWindowCreate(env: DeskWindowsEnv, body: any): Promise<any> {
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };
  const project = typeof body.project === 'string' ? body.project.trim() : '';
  const recipeId = typeof body.recipe_id === 'string' ? body.recipe_id.trim() : '';
  if (!project) return { success: false, error: 'project 必填' };
  if (!recipeId) return { success: false, error: 'recipe_id 必填' };
  if (body.title !== undefined && typeof body.title !== 'string') return { success: false, error: 'title 必须是字符串' };

  // 拍板(部署者,配方全桌通用):配方不再钉在project上,任何项目的窗口都能选任何配方——原先这里
  // "配方必须属于这个project"的校验已拆掉,只保留"配方存在"这道底线。
  try {
    const recipe = await env.OC_DB.prepare(`SELECT id FROM desk_recipes WHERE id = ?`).bind(recipeId).first<any>();
    if (!recipe) return { success: false, error: `recipe_id 不存在: ${recipeId}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  const id = genId('dw');
  const now = new Date().toISOString();
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  // 前置 SELECT 只提供即时错误文案，真正不变量必须焊进写语句。
  // 不变量守卫——查完到下面真正INSERT之间有并发窗口,配方可以在这中间被 deskRecipeDelete 删掉
  // (deskRecipeDelete反过来也查"有没有窗口引用"当拒删条件,双方都在查对方此刻的状态,查完到写完
  // 这段窗口天然存在竞态)。照 deskRecipeCreate↔deskPresetDelete 那对的既有口径(条件写入判修A
  // 先例)焊进INSERT本身:INSERT...SELECT...WHERE EXISTS 把"配方此刻还在不在"这件事挪到插入语句
  // 执行的瞬间复核,changes!==1 就说明真撞上了这个窄窗口(或更罕见——查完到INSERT前配方已被删)。
  // FK外键=已裁定不做(工单§6先例),不在这里重开这条路。
  try {
    // timeline_state 显式播种成 SEED_TIMELINE_STATE(不能指望列 DEFAULT '{}' 兜底)——
    // deskTimeline.ts 的 CAS 要求 blob 里一定能 json_extract 出 $.rev,见该文件头注释判断留观。
    const meta = await env.OC_DB.prepare(
      `INSERT INTO desk_windows (id, project, title, recipe_id, note, note_depth, state_board, timeline_state, vars, created_at, updated_at)
       SELECT ?, ?, ?, ?, '', 3, '{}', ?, '{}', ?, ? WHERE EXISTS (SELECT 1 FROM desk_recipes WHERE id = ?)`
    ).bind(id, project, title, recipeId, JSON.stringify(SEED_TIMELINE_STATE), now, now, recipeId).run();
    if (!meta.meta || meta.meta.changes !== 1) {
      return { success: false, error: '配方不存在或刚被删掉' };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  return { success: true, id, project, title, recipe_id: recipeId, note: '', note_depth: 3, state_board: {}, vars: {}, created_at: now, updated_at: now };
}

// ===== GET /api/oc/desk/windows?project= =====
export async function deskWindowList(env: DeskWindowsEnv, params?: { project?: string }): Promise<any> {
  try {
    const project = typeof params?.project === 'string' ? params.project.trim() : params?.project;
    const rows = project
      ? await env.OC_DB.prepare(`SELECT id, project, title, recipe_id, updated_at, created_at FROM desk_windows WHERE project = ? ORDER BY updated_at DESC`).bind(project).all<any>()
      : await env.OC_DB.prepare(`SELECT id, project, title, recipe_id, updated_at, created_at FROM desk_windows ORDER BY updated_at DESC`).all<any>();
    const windows = rows.results || [];
    if (!windows.length) return { success: true, count: 0, windows: [] };

    const ids = windows.map((w: any) => w.id);
    const placeholders = ids.map(() => '?').join(', ');
    const counts = await env.OC_DB.prepare(
      `SELECT window_id, COUNT(*) AS c FROM desk_floors WHERE window_id IN (${placeholders}) GROUP BY window_id`
    ).bind(...ids).all<any>();
    const countMap = new Map((counts.results || []).map((c: any) => [c.window_id, Number(c.c) || 0]));

    return {
      success: true,
      count: windows.length,
      windows: windows.map((w: any) => ({
        id: w.id, project: w.project, title: w.title, recipe_id: w.recipe_id,
        floor_count: countMap.get(w.id) || 0,
        updated_at: w.updated_at, created_at: w.created_at,
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== GET /api/oc/desk/windows/:id =====
export async function deskWindowGet(env: DeskWindowsEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  try {
    const w = await env.OC_DB.prepare(`SELECT * FROM desk_windows WHERE id = ?`).bind(id).first<any>();
    if (!w) return { success: false, error: '写作窗不存在' };
    const floorRows = await env.OC_DB.prepare(
      `SELECT id, role, content, variants, active_variant, thinking, report, created_at FROM desk_floors WHERE window_id = ? ORDER BY created_at ASC, id ASC`
    ).bind(id).all<any>();
    const floors = (floorRows.results || []).map((f: any) => {
      const variants = safeJsonParse(f.variants, []);
      return {
        id: f.id, role: f.role, content: f.content,
        variants_count: Array.isArray(variants) ? variants.length : 0,
        active_variant: f.active_variant,
        thinking: f.thinking || null,
        report: safeJsonParse(f.report, {}),
        created_at: f.created_at,
      };
    });
    return {
      success: true,
      window: {
        id: w.id, project: w.project, title: w.title, recipe_id: w.recipe_id,
        note: w.note, note_depth: w.note_depth,
        state_board: safeJsonParse(w.state_board, {}),
        timeline_state: safeJsonParse(w.timeline_state, SEED_TIMELINE_STATE),
        vars: safeJsonParse(w.vars, {}),
        created_at: w.created_at, updated_at: w.updated_at,
      },
      floors,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== PUT /api/oc/desk/windows/:id:{title?, note?, note_depth?, vars?, recipe_id?, state_board?} =====
export async function deskWindowUpdate(env: DeskWindowsEnv, id: string, body: any): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };

  if (body.title !== undefined && typeof body.title !== 'string') return { success: false, error: 'title 必须是字符串' };
  if (body.note !== undefined && typeof body.note !== 'string') return { success: false, error: 'note 必须是字符串' };
  if (body.note_depth !== undefined && (typeof body.note_depth !== 'number' || !Number.isFinite(body.note_depth) || body.note_depth < 0)) {
    return { success: false, error: 'note_depth 必须是 ≥0 的数字' };
  }
  if (body.vars !== undefined && !isPlainObject(body.vars)) return { success: false, error: 'vars 必须是对象' };
  if (body.state_board !== undefined) {
    if (!isPlainObject(body.state_board)) return { success: false, error: 'state_board 必须是对象' };
    if (stateBoardTooBig(body.state_board)) return { success: false, error: '状态板超过8KB上限(机器路径同款),精简一下' };
  }
  if (body.recipe_id !== undefined && (typeof body.recipe_id !== 'string' || !body.recipe_id.trim())) {
    return { success: false, error: 'recipe_id 必须是非空字符串' };
  }
  if (body.timeline_texts !== undefined) {
    const onlyTimeline = Object.keys(body).every((k) => k === 'timeline_texts' || k === 'timeline_rev');
    if (!onlyTimeline) return { success: false, error: '时光带请单独保存，不要和其它窗口字段混写' };
    try {
      return await updateDeskTimelineTexts(env, id, body.timeline_rev, body.timeline_texts);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  // 窗口存在性底线照旧要查(不管这次PUT改不改recipe_id,都得先确认这个id是真窗口)。
  try {
    const w = await env.OC_DB.prepare(`SELECT id FROM desk_windows WHERE id = ?`).bind(id).first<any>();
    if (!w) return { success: false, error: '写作窗不存在' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  // 拍板(部署者,配方全桌通用):原先这里"配方必须属于这个写作窗所在的project"的校验已拆掉——
  // 配方不再钉project,换窗口的配方时不再受"窗口在哪个项目"限制,只保留"配方存在"这道底线。
  // 此查询只用于快速报错，真正守卫在下方条件写入。
  // UPDATE语句焊的 AND EXISTS(同 deskRecipeUpdate 改 preset_id 的既有口径)。
  if (body.recipe_id !== undefined) {
    try {
      const recipe = await env.OC_DB.prepare(`SELECT id FROM desk_recipes WHERE id = ?`).bind(body.recipe_id.trim()).first<any>();
      if (!recipe) return { success: false, error: `recipe_id 不存在: ${body.recipe_id}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  const sets: string[] = [];
  const values: any[] = [];
  if (body.title !== undefined) { sets.push('title = ?'); values.push(body.title.trim()); }
  if (body.note !== undefined) { sets.push('note = ?'); values.push(body.note); }
  if (body.note_depth !== undefined) { sets.push('note_depth = ?'); values.push(body.note_depth); }
  if (body.vars !== undefined) { sets.push('vars = ?'); values.push(safeJsonStringify(body.vars)); }
  if (body.recipe_id !== undefined) { sets.push('recipe_id = ?'); values.push(body.recipe_id.trim()); }
  // 此处按产品合同直接覆盖，不做 CAS/rev 比对。
  // chat/desk.ts finalizeDeskTurn 那条"模型每楼末尾写回state_board"的机器写入路径共享同一列,
  // 两者是同列最后写者胜的竞态,没有互锁。裁定理由三条:
  //   ①语义上不对等——模型收尾写的板是"故事时间线上又往前走了一步"产生的新状态,不是需要跟
  //     手改仲裁胜负的另一份"当前状态";手改中途被模型收尾覆盖是可见的(部署者刷新一眼就看得
  //     出板子变了),下一秒就能再改一次,不是静默丢数据。
  //   ②主路径已经拦了——前端用 sending 状态把编辑/保存钮锁住(见 TypingDesk.tsx state-board
  //     面板),挡的正是"这楼生成中途手改"这唯一有意义的并发窗口。
  //   ③剩下的边角——多标签页同开一扇窗、或跳过前端直连API改板——是单人档下的极角落场景,
  //     为这个概率给 state_board 迁一条 rev 列、两条写入路径都改CAS,投入产出比不划算。
  // 此条裁定已同步进工单§6,不在后续返工里被悄悄推翻,除非部署者重新拍板。
  if (body.state_board !== undefined) { sets.push('state_board = ?'); values.push(safeJsonStringify(body.state_board)); }

  if (sets.length === 0) return { success: false, error: '没给要改的字段' };

  const now = new Date().toISOString();
  sets.push('updated_at = ?');
  values.push(now);
  values.push(id);

  // 修改 recipe_id 时，UPDATE 必须额外验证目标配方仍存在。
  // EXISTS(desk_recipes WHERE id=新recipe_id) 在写入的瞬间复核一遍,不是信前面那次查询快照——
  // 撞上"刚查完存在,UPDATE前被删掉"这个极窄窗口,EXISTS为假,这条UPDATE整条不生效(changes=0),
  // 不会把窗口过继给一个刚消失的幽灵配方。recipe_id 没在改的PUT(只改note/state_board等字段)
  // 不涉及这个窗口,不需要这段守卫,原样只按 id 定位。
  let sql = `UPDATE desk_windows SET ${sets.join(', ')} WHERE id = ?`;
  if (body.recipe_id !== undefined) {
    sql += ` AND EXISTS (SELECT 1 FROM desk_recipes WHERE id = ?)`;
    values.push(body.recipe_id.trim());
  }

  try {
    const meta = await env.OC_DB.prepare(sql).bind(...values).run();
    if (!meta.meta || meta.meta.changes === 0) {
      // changes=0 有两种可能:窗口本来就不存在(理论上不会,上面已经查过一次存在性,但两次查询
      // 之间也是个窗口),或者(recipe_id在改时)EXISTS守卫把这次更新拦下了——查一次窗口还在
      // 不在,给准确报错,不用同一句"写作窗不存在"糊弄两种不同的失败原因(同 deskRecipeUpdate
      // 改 preset_id 的既有口径)。
      if (body.recipe_id !== undefined) {
        const stillThere = await env.OC_DB.prepare(`SELECT id FROM desk_windows WHERE id = ?`).bind(id).first<any>();
        if (stillThere) return { success: false, error: '配方不存在或刚被删掉' };
      }
      return { success: false, error: '写作窗不存在' };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  return { success: true, id, updated_at: now };
}

// ===== DELETE /api/oc/desk/windows/:id:窗+它的楼层一起删(双确认不在这里,前端自己拦) =====
// 时光带在途折叠(waitUntil)若恰好撞上这次删除:折叠回来 UPDATE desk_windows WHERE id=? AND rev=?
// 会 0 行命中(整行都没了),自然无害地空转一次——不需要额外栅栏,窗口消失本身就是最终状态。
export async function deskWindowDelete(env: DeskWindowsEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  try {
    const w = await env.OC_DB.prepare(`SELECT id FROM desk_windows WHERE id = ?`).bind(id).first<any>();
    if (!w) return { success: false, error: '写作窗不存在' };
    await env.OC_DB.batch([
      env.OC_DB.prepare(`DELETE FROM desk_floors WHERE window_id = ?`).bind(id),
      env.OC_DB.prepare(`DELETE FROM desk_windows WHERE id = ?`).bind(id),
    ]);
    return { success: true, id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== PUT /api/oc/desk/floors/:id:就地改楼层正文——必须过时光带前/后栅栏(工单§4 D) =====
// 跟 editorial.ts editorialEditAssistant 的双栅栏调用序同一条家法:先 invalidate(前栅栏)、
// 再 UPDATE、UPDATE 真改到行才推后栅栏。跟 editorial 不同的是这里不限定只能改 assistant 楼层——
// 打字桌是部署者自己的手稿,user/assistant 两种楼层她都可能想手改(改自己写的引导词,或改AI续写的
// 正文),没有"只能改AI的话"这条限制的理由。
// 顺带维护 content===variants[active_variant].text 不变式(工单§4 A 交付物 variant 端点的同一条铁律):
// 改正文的同时把当前激活的那个版本也同步改掉,不然切一次版本就把手改的内容悄悄弄丢。
export async function deskFloorEdit(env: DeskWindowsEnv, floorId: string, content: string): Promise<any> {
  if (!floorId) return { success: false, error: '缺 id' };
  if (typeof content !== 'string') return { success: false, error: 'content 必须是字符串' };
  const clean = scrubLoneSurrogates(content); // 出站边界(这段还会喂回VPS门房的Python侧)统一洗孤立代理,同 editorial 家法
  if (!clean.trim()) return { success: false, error: 'content 不能为空' };
  if (clean.length > FLOOR_CONTENT_MAX) return { success: false, error: `content 太长了(上限${FLOOR_CONTENT_MAX}字)` };

  try {
    const target = await env.OC_DB.prepare(`SELECT window_id, created_at, content, variants, active_variant FROM desk_floors WHERE id = ?`).bind(floorId).first<any>();
    if (!target) return { success: false, error: '楼层不存在' };

    const inv = await invalidateDeskTimelineIfFolded(env, target.window_id, String(target.created_at), floorId);
    if (inv === 'busy') return { success: false, error: '时光带正在被后台折叠,稍等几秒再试' };

    // 不变式(content===variants[active]):就算读到的 active_variant 因为脏数据越界(理论edge
    // case),也要落到一个合法下标上,不能悄悄跳过写入——那样 content 改了但 variants[active]
    // 还是旧文本,一次"切版本"操作就会把这次手改覆盖冲没。
    const variantsRaw = safeJsonParse(target.variants, []);
    const variants = Array.isArray(variantsRaw) && variantsRaw.length ? variantsRaw : [clean];
    const activeRaw = Number(target.active_variant);
    const active = Number.isInteger(activeRaw) && activeRaw >= 0 && activeRaw < variants.length ? activeRaw : 0;
    variants[active] = clean;

    // CAS 快照必须使用 D1 原始列值，不能 parse 后重新 stringify。
    // 可能字节不同)。三证:variants(挡 roll/finalize 并发写)+ active_variant(挡 deskFloorVariant
    // 并发切版本——它只改 content/active 不动 variants,单绑 variants 拦不住,漏过去会写出
    // content !== variants[active] 的永久错位)+ content(纵深防御,兜未来任何只改正文的写者)。
    const variantsSnapshot: string | null = target.variants ?? null;
    const contentSnapshot: string | null = target.content ?? null;
    const meta = await env.OC_DB.prepare(
      `UPDATE desk_floors SET content = ?, variants = ?
       WHERE id = ? AND COALESCE(variants,'') = COALESCE(?,'') AND active_variant = ? AND COALESCE(content,'') = COALESCE(?,'')`
    ).bind(clean, safeJsonStringify(variants), floorId, variantsSnapshot, target.active_variant, contentSnapshot).run();
    const changed = meta.meta?.changes ?? 0;
    if (!changed) return { success: false, error: '这一楼在编辑期间被别的操作改动过,请刷新后重试' };

    await fenceDeskTimelineAfterWrite(env, target.window_id, inv.rev, { createdAt: String(target.created_at), id: floorId });
    return { success: true, id: floorId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== POST /api/oc/desk/windows/:id/truncate {floor_id}:删掉锚点楼层之后的所有楼层(锚点本身保留)=====
// 复合序 (created_at,id) 同 editorial 家族一条家法。前栅栏的判定目标(见 chat/deskTimeline.ts
// invalidateDeskTimelineIfFolded 用法)是"锚点之后第一条要被删的楼层",不是锚点自己——锚点本身
// 不删,它是否在折叠区跟这次删除动作本身是否波及折叠区是两件事(锚点<=cutoff 不代表锚点之后
// 紧跟着的那条也<=cutoff,得查真正要删的第一条来判)。
// inclusive=true 时锚点楼自身也进入删除范围。
// 点3剪=3和4都走,不再留孤零零的3)。旧的"只剪之后"语义保留为 inclusive=false(默认,兼容老调用方)。
export async function deskWindowTruncate(env: DeskWindowsEnv, windowId: string, floorId: string, inclusive: boolean = false): Promise<any> {
  if (!windowId) return { success: false, error: '缺 window id' };
  if (!floorId) return { success: false, error: 'floor_id 必填' };
  try {
    const anchor = await env.OC_DB.prepare(`SELECT created_at FROM desk_floors WHERE id = ? AND window_id = ?`).bind(floorId, windowId).first<any>();
    if (!anchor) return { success: false, error: '锚点楼层不存在(或不属于这个写作窗)' };

    // 时光带栅栏的失效锚点=删除范围里最早的那一楼:inclusive 用锚点自己,exclusive 用锚点后第一楼。
    let invAnchorAt: string; let invAnchorId: string;
    if (inclusive) {
      invAnchorAt = String(anchor.created_at); invAnchorId = floorId;
    } else {
      const firstAfter = await env.OC_DB.prepare(
        `SELECT id, created_at FROM desk_floors WHERE window_id = ?1 AND (created_at > ?2 OR (created_at = ?2 AND id > ?3)) ORDER BY created_at ASC, id ASC LIMIT 1`
      ).bind(windowId, String(anchor.created_at), floorId).first<any>();
      if (!firstAfter) return { success: true, deleted: 0 }; // 锚点已经是最后一楼,没什么可删
      invAnchorAt = String(firstAfter.created_at); invAnchorId = String(firstAfter.id);
    }

    const inv = await invalidateDeskTimelineIfFolded(env, windowId, invAnchorAt, invAnchorId);
    if (inv === 'busy') return { success: false, error: '时光带正在被后台折叠,稍等几秒再试' };

    const deleteCond = inclusive
      ? `(created_at > ?2 OR (created_at = ?2 AND id >= ?3))`
      : `(created_at > ?2 OR (created_at = ?2 AND id > ?3))`;

    // inclusive 剪掉 user 楼及后文时，还要同步恢复此前 assistant 楼的状态板。
    // 再走 normal send 重造 user+assistant。旧实现只删楼/作废时光带,却把 desk_windows.state_board
    // 留在被删 assistant 已经推进过的未来——于是新 assistant 虽然看不到旧正文,仍会从窗口板里
    // "记得"被删版本发生过什么。直接 roll 已靠 report.boardBefore 修好,truncate 也必须认同一份
    // 出生快照:删除范围里第一条 assistant 当初生成前看见的板,就是剪完后故事应回到的板。
    const firstDeletedAssistant = await env.OC_DB.prepare(
      `SELECT id, report FROM desk_floors
       WHERE window_id = ?1 AND role = 'assistant' AND ${deleteCond}
       ORDER BY created_at ASC, id ASC LIMIT 1`
    ).bind(windowId, String(anchor.created_at), floorId).first<any>();
    const firstReport = safeJsonParse(firstDeletedAssistant?.report, null);
    const boardBefore = firstReport && typeof firstReport === 'object' && !Array.isArray(firstReport)
      ? firstReport.boardBefore
      : undefined;
    const canRewindBoard = isPlainObject(boardBefore);

    // DELETE 与状态板回退必须同一 D1 batch:任一语句抛错整批回滚,不留"楼删了板没退"或反向
    // 半截态。没有 assistant(例如只剪最后一条孤儿 user)就不碰板;补丁前老楼没有 boardBefore,
    // 无法凭空重建出生板,也不拿猜测覆盖现状——跟 direct roll 的老数据兼容定价一致。
    const statements: D1PreparedStatement[] = [];
    let deleteStmt: D1PreparedStatement;
    if (canRewindBoard) {
      // 回退 UPDATE 必须排在 DELETE 前，并在批内确认目标楼仍存在。
      // 那条最早被删 assistant 且 report 与预读快照逐字节相同。否则另一趟 truncate 可能已经先删完,
      // 部署者随后又手改了状态板,迟到请求若无条件 UPDATE 就会出现 deleted=0 却把新板覆盖回旧板。
      // UPDATE 0命中时后面的 DELETE 仍安全幂等,返回值按实际 changes 报 rewound=false。
      const rewindBoardJson = safeJsonStringify(boardBefore);
      const rewindAt = new Date().toISOString();
      statements.push(
        env.OC_DB.prepare(
          `UPDATE desk_windows SET state_board = ?, updated_at = ?
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM desk_floors
             WHERE id = ? AND window_id = ? AND role = 'assistant'
               AND COALESCE(report, '') = COALESCE(?, '')
           )`
        ).bind(
          rewindBoardJson, rewindAt, windowId,
          String(firstDeletedAssistant.id), windowId, firstDeletedAssistant.report ?? null
        )
      );
      // DELETE 不能只信批外快照，必须确认前一条 UPDATE 已写入本次恢复令牌。
      // 回退标记写进窗口,同时复核目标assistant的原report仍在。若它在预读后被direct roll改过,
      // UPDATE会0命中;这里也随之0命中,绝不删掉新版楼却把板留在新版楼之后。D1 batch内后句
      // 能看见前句写入,同仓库既有批内顺序家法。窗口标记+楼层快照双证共同守门——updated_at
      // 只有毫秒精度,不能单独冒充唯一token(子进程第三审抓到的同毫秒撞标记案)。
      deleteStmt = env.OC_DB.prepare(
        `DELETE FROM desk_floors
         WHERE window_id = ?1 AND ${deleteCond}
           AND EXISTS (
             SELECT 1 FROM desk_windows
             WHERE id = ?4 AND state_board = ?5 AND updated_at = ?6
           )
           AND EXISTS (
             SELECT 1 FROM desk_floors AS guard_floor
             WHERE guard_floor.id = ?7 AND guard_floor.window_id = ?8
               AND guard_floor.role = 'assistant'
               AND COALESCE(guard_floor.report, '') = COALESCE(?9, '')
           )`
      ).bind(
        windowId, String(anchor.created_at), floorId, windowId, rewindBoardJson, rewindAt,
        String(firstDeletedAssistant.id), windowId, firstDeletedAssistant.report ?? null
      );
    } else {
      deleteStmt = env.OC_DB.prepare(
        `DELETE FROM desk_floors WHERE window_id = ?1 AND ${deleteCond}`
      ).bind(windowId, String(anchor.created_at), floorId);
    }
    statements.push(deleteStmt);
    const results = await env.OC_DB.batch(statements);
    const deleteResultIndex = canRewindBoard ? 1 : 0;
    const deleted = results[deleteResultIndex]?.meta?.changes ?? 0;
    const stateBoardRewound = canRewindBoard && (results[0]?.meta?.changes ?? 0) === 1;

    // 预读后目标楼被 roll/编辑过:两道联锁应让 UPDATE/DELETE 同为0。明确报冲突,让前端停在
    // truncate 阶段,不能 success:true 后继续 normal send 造出重复user楼。理论上 UPDATE=1而
    // DELETE=0 只可能是数据库未遵守批内可见性,同样按冲突挡住并留下可重试现场。
    if (canRewindBoard && (!stateBoardRewound || deleted === 0)) {
      await fenceDeskTimelineAfterWrite(env, windowId, inv.rev, { createdAt: invAnchorAt, id: invAnchorId });
      return { success: false, error: '这一段楼层在剪切期间被别的操作改动过,请刷新后重试', conflict: true };
    }

    await fenceDeskTimelineAfterWrite(env, windowId, inv.rev, { createdAt: invAnchorAt, id: invAnchorId });
    return { success: true, deleted, state_board_rewound: stateBoardRewound };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== POST /api/oc/desk/floors/:id/variant {index}:切换重roll候选版本 =====
// 不变式(工单§4 A):content === variants[active_variant].text——切版本只是把 content 换成
// 目标版本的文本,variants 数组本身不动。thinking/report 描述的是"当前激活版本是怎么生成的",
// 切到别的历史版本后它们会跟目标版本对不上号(那份历史生成过程没有单独存)——这是已知取舍,
// 旧 variant 缺透视元数据时保持缺失，不在读取端伪造修复。
//
// 切换 variant 也是楼层变更，必须经过时光带前后栅栏。
// 漏掉了deskFloorEdit那套双栅栏(前invalidate/后fence),生成中的楼层被切了版本,时光带折叠可能
// 拿旧快照瞎折。这里补齐同一套调用序,还照FIX3的乐观并发口径给UPDATE加条件——绑住读到时的
// active_variant+variants长度快照,真撞上"切换期间这条楼层被生成轮/别的切换动作抢先改了",
// UPDATE 0行命中就报冲突,不静默覆盖。
export async function deskFloorVariant(env: DeskWindowsEnv, floorId: string, index: number): Promise<any> {
  if (!floorId) return { success: false, error: '缺 id' };
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return { success: false, error: 'index 必须是非负整数' };
  try {
    const row = await env.OC_DB.prepare(`SELECT window_id, created_at, variants, active_variant FROM desk_floors WHERE id = ?`).bind(floorId).first<any>();
    if (!row) return { success: false, error: '楼层不存在' };
    const variants = safeJsonParse(row.variants, []);
    if (!Array.isArray(variants) || index >= variants.length) return { success: false, error: `index 越界(这条楼层只有 ${Array.isArray(variants) ? variants.length : 0} 个版本)` };
    const text = String(variants[index]);

    const inv = await invalidateDeskTimelineIfFolded(env, row.window_id, String(row.created_at), floorId);
    if (inv === 'busy') return { success: false, error: '时光带正在被后台折叠,稍等几秒再试' };

    const snapActive = Number(row.active_variant);
    // CAS 还须绑定 variants 原始值，捕获只改正文、不改 active/长度的并发编辑。
    // variants 内容与 content,两者都不动)能绕过——交错"读→手改落库→本 UPDATE"时 content 会写成
    // 手改前的旧文本,与 variants 错位。补绑 variants 原始快照,三证对齐。
    const meta = await env.OC_DB.prepare(
      `UPDATE desk_floors SET content = ?, active_variant = ? WHERE id = ? AND active_variant = ? AND json_array_length(variants) = ? AND COALESCE(variants,'') = COALESCE(?,'')`
    ).bind(text, index, floorId, snapActive, variants.length, (row.variants ?? null) as string | null).run();
    const changed = meta.meta?.changes ?? 0;
    if (!changed) return { success: false, error: '这一楼在切换版本时被别的操作改动过,请刷新后重试' };

    await fenceDeskTimelineAfterWrite(env, row.window_id, inv.rev, { createdAt: String(row.created_at), id: floorId });
    return { success: true, id: floorId, active_variant: index, content: text };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
