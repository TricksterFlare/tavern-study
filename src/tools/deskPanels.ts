// src/tools/deskPanels.ts
// 打字桌抽屉：积木详情、世界书 CRUD、正则开关与剧情核心记忆。
// 跟 desk.ts(S1导入器)/deskRecipes.ts(S2配方CRUD)/deskWindows.ts(S3写作窗) 分文件放,同一条
// 理由——这里管"部署者在抽屉里翻/改已经导进来的东西",不碰导入/装配/聊天链路本身。
// id生成/JSON兜底家法照抄 desk.ts 头注释那套(每文件各自小份复制,不是漏抽公共util,是本仓一贯风格)。
//
// 世界书没有指针层：世界书条目/角色卡就是
//   书架 memories 里 category ∈ world/outline 的那一行,正文在 content、触发配置在 lore_* 列。
//   desk_lore 已删除；不要恢复或查询该旧表。
//   查角色卡实际喂了什么,看 memories,不看任何叫 lore 的表。

// 召回参数的解析/夹取只此一份,住在装配引擎那边(它是真正用这三个数的人),这里 import 过来复用
// ——两处各写一套夹取范围,迟早出现"前端存进去了、装配时又被夹掉"这种最难查的不生效。
import { parseRecallSettings, RECALL_DEFAULTS, LORE_CATEGORIES, LORE_CATEGORY_SQL } from '../chat/deskAssemble';

interface DeskPanelsEnv {
  OC_DB: D1Database;
}

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

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function safeJsonParse(raw: any, fallback: any): any {
  if (raw === undefined || raw === null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// ===== A1: GET /api/oc/desk/presets/:id/blocks?full=1 =====
// 队列先(按 queue_pos 升序)、库后(按 name 字典序)——ORDER BY 用 in_queue DESC 当第一优先级
// 天然分了两段,库里那段 queue_pos 全是 NULL,不参与二级排序,直接落到 name 排序。
// full=1 才带整段 content(积木面板详情视图用);列表视图默认只给 200 字预览 + 总长,679KB 级的
// 包一次性把全部 content 倒回前端没有意义。
export async function deskPresetBlocks(env: DeskPanelsEnv, presetId: string, full: boolean): Promise<any> {
  if (!presetId) return { success: false, error: '缺 id' };
  try {
    const preset = await env.OC_DB.prepare(`SELECT id FROM desk_presets WHERE id = ?`).bind(presetId).first<any>();
    if (!preset) return { success: false, error: '预设包不存在' };

    const rows = await env.OC_DB.prepare(
      `SELECT id, identifier, name, role, marker, in_queue, queue_pos, enabled_default, content
       FROM desk_blocks WHERE preset_id = ? ORDER BY in_queue DESC, queue_pos ASC, name ASC`
    ).bind(presetId).all<any>();

    const blocks = (rows.results || []).map((b: any) => {
      const content = String(b.content || '');
      const out: any = {
        id: b.id,
        identifier: b.identifier,
        name: b.name,
        role: b.role,
        marker: !!b.marker,
        in_queue: !!b.in_queue,
        queue_pos: b.queue_pos,
        enabled_default: !!b.enabled_default,
        content_preview: content.slice(0, 200),
        content_len: content.length,
      };
      if (full) out.content = content;
      return out;
    });

    return { success: true, preset_id: presetId, count: blocks.length, blocks };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== A1b: PUT /api/oc/desk/blocks/:id {content}:真改已经导入的积木正文 =====
export async function deskBlockUpdate(env: DeskPanelsEnv, id: string, body: any): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  if (!body || typeof body !== 'object' || typeof body.content !== 'string') return { success: false, error: 'content 必须是字符串' };
  if (body.content.length > 200000) return { success: false, error: '积木正文超过20万字上限' };
  try {
    const meta = await env.OC_DB.prepare(`UPDATE desk_blocks SET content = ? WHERE id = ?`).bind(body.content, id).run();
    if (!meta.meta || meta.meta.changes !== 1) return { success: false, error: '积木不存在' };
    return { success: true, id, content_len: body.content.length };
  } catch (err: any) {
    return { success: false, error: err.message, server: true };
  }
}

// ===== A2：世界书/角色卡直接 CRUD memories =====
//
// memories 是唯一正本，触发字段与正文必须同一行维护。
// 0 孤儿 0 未挂载 0 重复引用——"设定"和"世界书条目"本来就是同一个东西,中间那层指针是当初
// 按表切门的产物。合并后 category 自己就是闸门:书架建一条设定=建一张卡,不进剧本就
// 关 lore_enabled,不用再去别处"挂"一次。
// 世界书闸门包含 world 与 outline；plot/session 不进入该链路。
// 剧情);plot/session 不放。这里列表/守门/写锁三处和 deskAssemble.ts 的装配 SQL 必须同宽——
// 装配认、面板不让改(或反过来)都是"我明明改了没生效"级别的坑。LORE_CATEGORIES 只此一份。
//
// ⚠️两处语义随之改变(部署者拍板,不是顺手改的):
//   ①「新建条目」下岗(deskLoreCreate):以前"从书架挑/手写"两个入口都是在造指针,现在没有指针
//     可造了。新建设定的唯一入口是书架——那也正是判据里"精修去书架、浮窗只快改"的落点。
//   ②「删除条目」下岗(deskLoreDelete):以前删卡只是撕掉指针、书还在;合并后一行就是一本书,
//     删卡=删书。这是不可逆的降级,绝不能藏在一颗小小的「删」钮后面。要它不进剧本→关开关;
//     真要删这本书→去书架删(那边有它自己的两段确认)。
//   两个函数保留但直接返回说明性错误,不留 404:Pages 是按 hash 发资源的,她浏览器里可能还挂着
//   旧一版 JS,一句人话比一个 404 好排查得多。

// GET /api/oc/desk/lore?project=:project 维度全量。
// 排序沿用面板原来那套(角色卡优先→名字升序),跟装配读的顺序(ORDER BY id,见 deskAssemble.ts)
// 是两回事:这里排的是"给人看着顺手",那边排的是"缓存前缀的字节"。
export async function deskLoreList(env: DeskPanelsEnv, params?: { project?: string }): Promise<any> {
  const project = typeof params?.project === 'string' ? params.project.trim() : params?.project;
  if (!project) return { success: false, error: 'project 必填' };
  try {
    const rows = await env.OC_DB.prepare(
      `SELECT id, project, category, title, content, chapter, lore_keys, lore_position, is_char,
              lore_constant, trigger_mode, lore_enabled, lore_fields, created_at, updated_at
         FROM memories
        WHERE project = ? AND category IN (${LORE_CATEGORY_SQL})
        ORDER BY is_char DESC, title ASC`
    ).bind(project).all<any>();
    const list = (rows.results || []) as any[];

    const lore = list.map((r: any) => ({
      id: r.id,
      project: r.project,
      category: r.category, // 前端据此区分world与outline徽章
      name: r.title,
      keys: safeJsonParse(r.lore_keys, []),
      content: r.content ?? '',
      fields: safeJsonParse(r.lore_fields, {}),
      position: r.lore_position,
      // source/memory_id/resolved_title 是已退役兼容字段，不得重新暴露给客户端。
      // The reference UI does not consume these retired fields; only an old type declaration mentioned them.
      // 挂着名字、没有任何取值点,那份声明同批删掉。
      is_char: !!r.is_char,
      enabled: !!r.lore_enabled,
      constant: !!r.lore_constant,
      trigger_mode: r.trigger_mode === 'presence' ? 'presence' : 'scan', // 非 'presence' 一律当默认档
      chapter: r.chapter ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    return { success: true, count: lore.length, lore };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// POST /api/oc/desk/lore —— 下岗(见本节头部注释①)。
// 合并之后没有"指针"可造了:世界书条目 == 书架里 category='world' 的那一行。新建走书架。
export async function deskLoreCreate(_env: DeskPanelsEnv, _body: any): Promise<any> {
  return {
    success: false,
    error: '世界书条目现在就是书架里的「设定/大纲」——新建请去书架建一条,建完自动出现在世界书里(不用再挂一次)',
  };
}

// PUT /api/oc/desk/lore/:id:部分更新,直接落在 memories 那一行上。
//
// 跟迁移前最大的不同:**content 现在可以在这儿改了**。以前拒绝碰 content 是因为这行只是指针、
// 正本在书架;现在这行就是书架那一行,"改内容"和"改触发词"改的是同一条记录,没有第二份可写歪。
// name 落到 title 列——它既是这张卡在剧本里的抬头(【名字】),也是书架上那本书的标题,同一个东西。
export async function deskLoreUpdate(env: DeskPanelsEnv, id: string, body: any): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };

  // 先确认这一行确实是世界书条目:memories 是全书房共用的表,大纲/交接/篇章也住这儿。
  // 不核这一下的话,一个拿错的 id 就能把「交接」改成角色卡——那是静默改剧本结构。
  let row: any;
  try {
    row = await env.OC_DB.prepare(`SELECT id, category FROM memories WHERE id = ?`).bind(id).first<any>();
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  if (!row) return { success: false, error: '世界书条目不存在' };
  if (!(LORE_CATEGORIES as readonly string[]).includes(row.category)) {
    return { success: false, error: `这条是「${row.category}」分类的书架条目,不是世界书条目——世界书只管设定/大纲(${LORE_CATEGORY_SQL})` };
  }

  const sets: string[] = [];
  const values: any[] = [];
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return { success: false, error: 'name 必须是非空字符串' };
    sets.push('title = ?'); values.push(body.name.trim());
  }
  if (body.keys !== undefined) {
    if (!Array.isArray(body.keys) || body.keys.some((k: any) => typeof k !== 'string')) return { success: false, error: 'keys 必须是字符串数组' };
    sets.push('lore_keys = ?'); values.push(JSON.stringify(body.keys));
  }
  if (body.content !== undefined) {
    if (typeof body.content !== 'string') return { success: false, error: 'content 必须是字符串' };
    sets.push('content = ?'); values.push(body.content);
  }
  if (body.fields !== undefined) {
    const fieldsErr = validateLoreFields(body.fields);
    if (fieldsErr) return { success: false, error: fieldsErr };
    sets.push('lore_fields = ?'); values.push(JSON.stringify(normalizeLoreFields(body.fields)));
  }
  if (body.position !== undefined) {
    if (!['before', 'after', 'char'].includes(body.position)) return { success: false, error: 'position 必须是 before/after/char 之一' };
    sets.push('lore_position = ?'); values.push(body.position);
  }
  // is_char 必须是严格布尔；角色卡与普通 world 条目走不同装配路径。
  // "false"/{}/1 这类歪形状静默转真会改变提示词摆位——宁拒不猜。下面几个布尔同款。
  if (body.is_char !== undefined) {
    if (typeof body.is_char !== 'boolean') return { success: false, error: 'is_char 必须是布尔值' };
    sets.push('is_char = ?'); values.push(body.is_char ? 1 : 0);
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { success: false, error: 'enabled 必须是布尔值' };
    sets.push('lore_enabled = ?'); values.push(body.enabled ? 1 : 0);
  }
  if (body.constant !== undefined) {
    if (typeof body.constant !== 'boolean') return { success: false, error: 'constant 必须是布尔值' };
    sets.push('lore_constant = ?'); values.push(body.constant ? 1 : 0);
  }
  if (body.trigger_mode !== undefined) {
    if (!['scan', 'presence'].includes(body.trigger_mode)) return { success: false, error: 'trigger_mode 必须是 scan/presence 之一' };
    sets.push('trigger_mode = ?'); values.push(body.trigger_mode);
  }
  if (sets.length === 0) return { success: false, error: '没给要改的字段' };

  const now = new Date().toISOString();
  sets.push('updated_at = ?'); values.push(now); values.push(id);
  try {
    // WHERE 再钉一次 category 闸门:上面那次读和这次写之间理论上有窗口,而写歪的代价是
    // 静默改剧本结构。加这一条等于把校验和写入锁在同一句里,零成本。
    const meta = await env.OC_DB.prepare(
      `UPDATE memories SET ${sets.join(', ')} WHERE id = ? AND category IN (${LORE_CATEGORY_SQL})`
    ).bind(...values).run();
    if (!meta.meta || meta.meta.changes === 0) return { success: false, error: '世界书条目不存在' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  return { success: true, id, updated_at: now };
}

// DELETE /api/oc/desk/lore/:id —— 下岗(见本节头部注释②)。
// 以前删卡=撕指针、书还在;合并后一行就是一本书,删卡=删书。不可逆的降级不许藏在一颗「删」钮后面。
export async function deskLoreDelete(_env: DeskPanelsEnv, _id: string): Promise<any> {
  return {
    success: false,
    error: '世界书条目现在就是书架里那本书——这里删会连书一起删掉。不想让它进剧本请关掉开关;真要删这本书请去书架删',
  };
}

// ===== A3: PUT /api/oc/desk/regex/:id =====
// 只许改 enabled/name,find/replace/flags/direction/scope 在 S5 全部不可改(工单原话:它们来自导入,
// 想改另开导入)。meta.invalid(编译不过)或 meta.unsafe(疑似灾难性回溯)标记过的行,想重新启用
// (enabled:true)必须显式带 force:true——不带就拒绝并把原因带回去,前端拿这个原因去弹确认。
// 禁用(enabled:false)永远放行,不需要 force。
export async function deskRegexUpdate(env: DeskPanelsEnv, id: string, body: any): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };

  const sets: string[] = [];
  const values: any[] = [];

  if (body.name !== undefined) {
    if (typeof body.name !== 'string') return { success: false, error: 'name 必须是字符串' };
    sets.push('name = ?'); values.push(body.name.trim());
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { success: false, error: 'enabled 必须是布尔值' };
    if (body.enabled) {
      let row: any;
      try {
        row = await env.OC_DB.prepare(`SELECT meta FROM desk_regex WHERE id = ?`).bind(id).first<any>();
      } catch (err: any) {
        return { success: false, error: err.message };
      }
      if (!row) return { success: false, error: '正则不存在' };
      const meta = safeJsonParse(row.meta, {});
      if ((meta.invalid || meta.unsafe) && body.force !== true) {
        return {
          success: false,
          error: `这条正则${meta.invalid ? '编译不过' : '疑似灾难性回溯'}(${meta.invalid_reason || '原因未知'}),需要 force:true 才能重新启用`,
          requires_force: true,
          reason: meta.invalid_reason || null,
        };
      }
    }
    sets.push('enabled = ?'); values.push(body.enabled ? 1 : 0);
  }

  if (sets.length === 0) return { success: false, error: '没给要改的字段' };
  values.push(id);
  try {
    const meta = await env.OC_DB.prepare(`UPDATE desk_regex SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
    if (!meta.meta || meta.meta.changes === 0) return { success: false, error: '正则不存在' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  return { success: true, id };
}

// ===== A5：删除正则 =====
// 双确认在前端(照世界书/预设包同款 useDoubleConfirm 手法),这里不再拦——直接删,不检查引用
// (正则不像预设包那样被配方 regex_ids 数组"钉住"就动弹不得;配方那边存的是id快照,正则被删掉
// 只是装配时那个id查不到、静默跳过,不是外键约束会炸的关系,不需要案4那种"先删引用"闸)。
export async function deskRegexDelete(env: DeskPanelsEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  try {
    const meta = await env.OC_DB.prepare(`DELETE FROM desk_regex WHERE id = ?`).bind(id).run();
    if (!meta.meta || meta.meta.changes === 0) return { success: false, error: '正则不存在' };
    return { success: true, id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== A6：批量重排正则 =====
// body: {scope:'preset'|'global', preset_id?:string, ids:[...]}——前端拖拽调完序后发来的
// "这个组"(scope[+preset_id]维度)完整新序,逐个赋 sort_order=10,20,30…累加编号,batch原子写。
// 重排必须验证 ids 精确等于目标组的权威集合，不能只检查各 id 存在。
// 恰好等于某个组的全体——这意味着调用方可以发任意子集(漏掉的行序号原地不动,跟新序交叉出乱序)
// 或者夹带别的组的id(sort_order是全表共享列,scope='preset'的一条id混进scope='global'的新序
// 里,照样能被这条端点接受并改写它的sort_order,越权改了不该碰的组)。现在的合同:body必须
// 先声明"要重排的是哪个组"(scope,scope='preset'时还要preset_id),端点据此查出这个组在库的
// 权威完整id集合,要求跟body.ids**完全相等**——多一个少一个都整批拒绝,报错点名差集(缺了哪些/
// 多了哪些),不静默丢行也不静默越权。副作用:IN()的参数量天然被"这个组有多少条正则"封顶,
// 不再被body.ids的长度牵着走。
export async function deskRegexReorder(env: DeskPanelsEnv, body: any): Promise<any> {
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };
  if (!Array.isArray(body.ids)) return { success: false, error: 'ids 必须是数组' };
  if (body.ids.some((x: any) => typeof x !== 'string')) return { success: false, error: 'ids 数组里每一项必须是字符串' };
  const ids: string[] = body.ids;
  if (ids.length === 0) return { success: false, error: 'ids 不能是空数组' };
  if (new Set(ids).size !== ids.length) return { success: false, error: 'ids 里有重复id' };

  if (body.scope !== 'preset' && body.scope !== 'global') {
    return { success: false, error: `scope 必须是 'preset' 或 'global',实际收到的是 ${JSON.stringify(body.scope)}` };
  }
  const scope: 'preset' | 'global' = body.scope;
  let presetId = '';
  if (scope === 'preset') {
    if (typeof body.preset_id !== 'string' || !body.preset_id.trim()) {
      return { success: false, error: "scope='preset' 时 preset_id 必填(非空字符串)" };
    }
    presetId = body.preset_id.trim();
  }

  try {
    const groupRows = scope === 'global'
      ? await env.OC_DB.prepare(`SELECT id FROM desk_regex WHERE scope = 'global'`).all<any>()
      : await env.OC_DB.prepare(`SELECT id FROM desk_regex WHERE scope = 'preset' AND preset_id = ?`).bind(presetId).all<any>();
    const groupIds = new Set((groupRows.results || []).map((r: any) => r.id as string));

    const idsSet = new Set(ids);
    const missing = Array.from(groupIds).filter((gid) => !idsSet.has(gid));
    const extra = ids.filter((id) => !groupIds.has(id));
    if (missing.length > 0 || extra.length > 0) {
      const groupLabel = scope === 'global' ? '全局' : `预设包 ${presetId}`;
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`ids里缺了这个组本来就有的: ${missing.join(', ')}`);
      if (extra.length > 0) parts.push(`ids里多了不属于「${groupLabel}」这个组的: ${extra.join(', ')}`);
      return { success: false, error: `ids 跟「${groupLabel}」这个组在库的完整集合对不上——${parts.join('；')}` };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  // 批外权威集合查询仅用于构造请求；batch 内仍须重新验证集合未变化。
  // 快照——快照和写入之间仍有并发窗口,这个组可以被另一个请求的并发导入/删除整个换掉(比如这个
  // 预设包在这中间被deskPresetDelete连坐删了它的正则)。若UPDATE只按id定位,那种情况下每条id
  // 都查不到行、meta.changes全是0,但原来的代码不检查这个,会把"什么都没改成"错报成success。
  // 修法两件套:①每条UPDATE额外带 scope(+preset_id)约束,让"这一行还属于这个组"在写入的瞬间
  // 复核一遍,不是查一次快照就作数;②batch返回后逐条验 meta.changes===1,只要有一条没命中就
  // 说明组在竞态窗口里变了,整体判失败,不能"改了几条算几条"地悄悄部分成功。
  // 不对所有正则写入做全局串行化；条件批已覆盖本端点的实际风险。
  // 不再加固):不上"提交前后再验一次完整组集合"的两段验证——条件UPDATE+changes验证已经把
  // "虚报成功"焊死,残余风险只是极小概率下号段部分写入又被判失败,对齐由重拉收敛,不值得再加
  // 一轮验证；也不上数据库层FK+RESTRICT(D1加外键要整表重建迁移,单人档比例失衡,同工单§6裁定)。
  // 批内即便有几条UPDATE先命中、后几条没命中导致整体判失败,残留的部分号段是无害的——上一轮
  // F2已经把前端失败路径改成"重拉权威列表覆盖本地state"(不是拿旧快照回滚),这里报失败之后
  // 前端会重新GET一遍desk_regex拿到写入后的真实状态,不会有UI显示着"以为失败其实部分生效"的
  // 撕裂态,两轮修复正好在这里闭环。
  const stmts = ids.map((id, i) => {
    const sortOrder = (i + 1) * 10;
    return scope === 'global'
      ? env.OC_DB.prepare(`UPDATE desk_regex SET sort_order = ? WHERE id = ? AND scope = 'global'`).bind(sortOrder, id)
      : env.OC_DB.prepare(`UPDATE desk_regex SET sort_order = ? WHERE id = ? AND scope = 'preset' AND preset_id = ?`).bind(sortOrder, id, presetId);
  });
  // 同 desk.ts 导入器的900条安全线口径(付费档D1批量上限1000/批)——现在ids的长度天然等于
  // "这个组有多少条正则",单个预设包/全局正则正常到不了这个量级,兜底不省。
  if (stmts.length > 900) return { success: false, error: '一次调序的正则超过900条,超出单批安全线(付费档D1上限1000/批)' };
  try {
    const results = await env.OC_DB.batch(stmts);
    const allApplied = results.every((r: any) => (r?.meta?.changes ?? 0) === 1);
    if (!allApplied) {
      return { success: false, error: '调序期间这组正则被别的操作改动了,没有保存——列表已过期,请重拉后再拖一次' };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  return { success: true, count: ids.length };
}

// ===== A4: 剧情核心记忆(oc_state 键 desk_core:<project>)=====
// ⚠️落库形状必须跟 chat/deskAssemble.ts 的 parseCoreMemory 严格对上——它只认数组项的 `.content`
// 字段(collect = v => typeof v==='string' ? v : String(v?.content ?? '')),不认 `.text`。工单原话
// 的 wire 形状是 blocks:[{title,text}](前端字段名),这里入库前把 text→content 转一手,GET 再转
// 回来——纯粹是 API 这层的字段名选择,不是随手改名,漏了这步装配读出来会是空字符串(GET/PUT 各自
// GET/PUT 字段映射必须显式对齐解析器，不能靠往返自洽掩盖契约缺口。
//
// deskCoreGet 必须镜像 parseCoreMemory 支持的全部落库形状，否则
// GET→(部署者在前端编辑)→PUT 这一趟round trip会静默丢数据。parseCoreMemory 认四种:
//   ①数组(每项字符串或 {content}) ②纯对象(键当标题,值收 collect) ③纯字符串(非法JSON,或
//   合法JSON但是标量——数字/布尔/null,parseCoreMemory 在这条分支上直接 return String(raw),
//   不是 String(parsed)) ④空/缺失。下面 stored_shape 字段就是这四选一,给前端/排查用的透明度。
// PUT 那头永远只写回②③淘汰、只剩①canonical 形状——旧形状"存一次就升级成数组"是刻意的迁移路径,
// 不是回归:GET 已经把旧形状原样递给前端编辑,PUT 存回去变成 canonical,数据一个字都没丢。

export async function deskCoreGet(env: DeskPanelsEnv, project: string): Promise<any> {
  if (!project) return { success: false, error: 'project 必填' };
  try {
    const row = await env.OC_DB.prepare(`SELECT value FROM oc_state WHERE key = ?`).bind(`desk_core:${project}`).first<any>();
    const raw = row?.value;
    let blocks: { title: string; text: string }[] = [];
    let storedShape: 'array' | 'object' | 'text' | 'empty' = 'empty';

    if (raw) {
      let parsed: any;
      let parseOk = true;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parseOk = false;
      }

      if (parseOk && Array.isArray(parsed)) {
        blocks = parsed.map((item: any) => {
          if (typeof item === 'string') return { title: '', text: item };
          return { title: String(item?.title || ''), text: String(item?.content ?? '') };
        });
        storedShape = 'array';
      } else if (parseOk && parsed && typeof parsed === 'object') {
        // 纯对象形态:parseCoreMemory 用 Object.values(...).map(collect) 把值收一遍——键本身
        // 在那边没被当标题用,但 GET 这层是给部署者看/编的,键拿来当标题展示最直观,且反填回 PUT
        // 时会连同 title 一起进新数组项,信息不丢(旧对象的"键"变成新数组项的"标题"是形状升级
        // 的一部分,不是巧合)。
        // 值的取法必须和 parseCoreMemory 的 collect 逐字等价:字符串原样,其余一律 String(v?.content ?? '')
        // ——`?? v` 那种"好心兜底"会把 {content:null} 显影成 [object Object]、把 42 显影成 "42",
        // GET→PUT 不得把解析器不可见字段误转成正文。
        blocks = Object.entries(parsed).map(([k, v]) => ({
          title: k,
          text: typeof v === 'string' ? v : String((v as any)?.content ?? ''),
        }));
        storedShape = 'object';
      } else {
        // 数组/对象都不是——JSON标量(数字/布尔/null)或压根不是合法JSON,两种情况 parseCoreMemory
        // 都是直接 return String(raw)(注意不是 String(parsed)),这里原样单块塞回去跟它对齐。
        blocks = [{ title: '', text: String(raw) }];
        storedShape = 'text';
      }
    }

    return { success: true, project, blocks, stored_shape: storedShape };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function deskCoreUpdate(env: DeskPanelsEnv, body: any): Promise<any> {
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };
  const project = typeof body.project === 'string' ? body.project.trim() : '';
  if (!project) return { success: false, error: 'project 必填' };
  if (!Array.isArray(body.blocks)) return { success: false, error: 'blocks 必须是数组' };
  for (const b of body.blocks) {
    if (!b || typeof b !== 'object') return { success: false, error: 'blocks 里每项必须是对象' };
    if (b.title !== undefined && typeof b.title !== 'string') return { success: false, error: 'block.title 必须是字符串' };
    if (typeof b.text !== 'string') return { success: false, error: 'block.text 必须是字符串' };
  }

  const stored = body.blocks.map((b: any) => ({ title: String(b.title || '').trim(), content: b.text }));
  const now = new Date().toISOString();
  try {
    await env.OC_DB.prepare(`INSERT OR REPLACE INTO oc_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(`desk_core:${project}`, JSON.stringify(stored), now).run();
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  return { success: true, project, blocks: body.blocks, updated_at: now };
}

// ===== 往事区召回参数：oc_state desk_recall:<project> =====
// 三个数的语义、为什么不写死在代码里、cosine 的分数方向,全在 chat/deskAssemble.ts 顶上那段
// RECALL_DEFAULTS 注释里——这里只做 CRUD,判定口径一律复用 parseRecallSettings,免得两处夹取范围
// 各说各话(前端能存进来一个后端装配时又夹掉的数,是最难查的那种"我明明改了没生效")。
export async function deskRecallGet(env: DeskPanelsEnv, project: string): Promise<any> {
  if (!project) return { success: false, error: 'project 必填' };
  try {
    const row = await env.OC_DB.prepare(`SELECT value FROM oc_state WHERE key = ?`).bind(`desk_recall:${project}`).first<any>();
    return { success: true, project, settings: parseRecallSettings(row?.value), defaults: RECALL_DEFAULTS, stored: !!row };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function deskRecallUpdate(env: DeskPanelsEnv, body: any): Promise<any> {
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };
  const project = typeof body.project === 'string' ? body.project.trim() : '';
  if (!project) return { success: false, error: 'project 必填' };
  for (const k of ['topK', 'minScore', 'maxChapters']) {
    const v = (body as any)[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { success: false, error: `${k} 必须是数字(三个数整份一起提交)` };
    }
  }
  // 参数更新必须在 SQL 内合并字段，不能读改写整份覆盖，否则并发修改会互相丢失。
  // 都读到同一份旧值,后写者会把前写者刚改的那个字段打回旧值,而且两边都收到 success。
  // 治法用减法而不是加锁:三个数**整份**一起收,写成纯覆盖——读-改-写这条路径直接不存在了。
  // 代价是没有"只改一个数"的调用姿势,而界面本来就是三个数一屏,没人需要那个姿势。
  const merged = parseRecallSettings(JSON.stringify({
    topK: body.topK,
    minScore: body.minScore,
    maxChapters: body.maxChapters,
  }));
  const now = new Date().toISOString();
  try {
    await env.OC_DB.prepare(`INSERT OR REPLACE INTO oc_state (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(`desk_recall:${project}`, JSON.stringify(merged), now).run();
  } catch (err: any) {
    return { success: false, error: err.message };
  }
  // 回吐夹过的值,不是回吐她填的值——她填 minScore=6 时得当场看见变成 1,而不是等下次装配才发现
  return { success: true, project, settings: merged, updated_at: now };
}
