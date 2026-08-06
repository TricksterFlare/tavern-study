// src/tools/deskRecipes.ts
// 打字桌配方 CRUD。
// 跟 desk.ts(S1 导入器+预设/正则列表)分文件放,是因为这俩是两类活——desk.ts 管"包怎么进来",
// 这里管"部署者怎么拿包缝配方"——文件各自单一职责,別因为都姓 desk 就硬凑一个大文件。
//
// id 生成/JSON兜底照抄 desk.ts 头注释那套家法(每文件各自小份复制,不是漏抽公共util,是本仓一贯风格)。

interface DeskRecipesEnv {
  OC_DB: D1Database;
}

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

function safeJsonParse(raw: any, fallback: any): any {
  if (raw === undefined || raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function joinRegexLiteral(find: string, flags: string): string {
  let escaped = '';
  let backslashes = 0;
  for (const ch of find) {
    if (ch === '/' && backslashes % 2 === 0) escaped += '\\';
    escaped += ch;
    backslashes = ch === '\\' ? backslashes + 1 : 0;
  }
  return `/${escaped}/${flags}`;
}

// overrides 形状:{identifier: {enabled?:boolean, pos?:number}}。
// ⚠️判断留观(工单§4 S2范围提"overrides单选组语义"):desk_blocks 在 S1 落库时没存 ST 的
// "同组互斥"字段(样本预设的 prompts 数组本身也没带这个位——S1 解析器只抽了 injection_position/
// depth/order/forbid_overrides/system_prompt 五个字段),这里没有组信息可校验。S2 只按这个通用
// {enabled,pos} 形状收 overrides,不做互斥校验;"同组物理互斥"是工单§4 S5 前端积木面板的活
// (N选1真单选钮),真正的互斥保证落在那一层的 UI 交互上,不是这里的数据校验。
function validateOverrides(overrides: any): string | null {
  if (overrides === undefined) return null;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return 'overrides 必须是对象(identifier→{enabled,pos})';
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `overrides.${k} 必须是对象`;
    const ov = v as any;
    if (ov.enabled !== undefined && typeof ov.enabled !== 'boolean') return `overrides.${k}.enabled 必须是布尔值`;
    if (ov.pos !== undefined && typeof ov.pos !== 'number') return `overrides.${k}.pos 必须是数字`;
  }
  return null;
}

function validateRegexIds(ids: any): string | null {
  if (ids === undefined) return null;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) return 'regex_ids 必须是字符串数组';
  return null;
}

function validateParams(params: any): string | null {
  if (params === undefined) return null;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'params 必须是对象';
  return null;
}

function rowToRecipe(row: any): any {
  return {
    id: row.id,
    project: row.project,
    name: row.name,
    preset_id: row.preset_id,
    weight: row.weight,
    overrides: safeJsonParse(row.overrides, {}),
    regex_ids: safeJsonParse(row.regex_ids, []),
    params: safeJsonParse(row.params, {}),
    light_system: row.light_system || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ===== GET /api/oc/desk/recipes =====
// 配方全桌通用，列表必须全局查询，不接受 project 过滤。
// "新配方project=''在项目过滤下隐身"这坑)。project列保留仅作历史痕迹,不再参与任何过滤。
export async function deskRecipeList(env: DeskRecipesEnv): Promise<any> {
  try {
    const result = await env.OC_DB.prepare(`SELECT * FROM desk_recipes ORDER BY created_at DESC`).all<any>();
    const recipes = (result.results || []).map(rowToRecipe);
    return { success: true, count: recipes.length, recipes };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ===== GET /api/oc/desk/recipes/:id/export:把配方烘焙成可由①号口重新导入的标准ST预设JSON =====
export async function deskRecipeExport(env: DeskRecipesEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  try {
    const row = await env.OC_DB.prepare(
      `SELECT r.*, p.raw_json FROM desk_recipes r JOIN desk_presets p ON p.id = r.preset_id WHERE r.id = ?`
    ).bind(id).first<any>();
    if (!row) return { success: false, error: '配方不存在' };
    const recipe = rowToRecipe(row);
    const raw = safeJsonParse(row.raw_json, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { success: false, error: '原预设包JSON已损坏,无法导出' };
    const out: any = JSON.parse(JSON.stringify(raw));
    const overrides = recipe.overrides || {};

    if (recipe.weight === 'light') {
      const identifier = 'main';
      out.prompts = [{ identifier, name: 'Main Prompt', role: 'system', content: recipe.light_system || '', system_prompt: true, marker: false }];
      out.prompt_order = [{ character_id: 100001, order: [{ identifier, enabled: true }] }];
    }

    const blocks = await env.OC_DB.prepare(
      `SELECT identifier, content, in_queue, queue_pos, enabled_default FROM desk_blocks WHERE preset_id = ?`
    ).bind(recipe.preset_id).all<any>();
    const contentMap = new Map((blocks.results || []).map((b: any) => [b.identifier, String(b.content || '')]));
    if (recipe.weight !== 'light' && Array.isArray(out.prompts)) {
      out.prompts = out.prompts.map((p: any) => (
        p && typeof p === 'object' && typeof p.identifier === 'string' && contentMap.has(p.identifier)
          ? { ...p, content: contentMap.get(p.identifier) }
          : p
      ));
    }
    const effective = (blocks.results || []).map((b: any) => {
      const ov = overrides[b.identifier] || {};
      return {
        identifier: b.identifier,
        inQueue: !!b.in_queue || ov.pos !== undefined,
        pos: ov.pos !== undefined ? Number(ov.pos) : Number(b.queue_pos ?? 0),
        enabled: ov.enabled !== undefined ? !!ov.enabled : !!b.enabled_default,
      };
    }).filter((b: any) => b.inQueue).sort((a: any, b: any) => a.pos - b.pos);
    if (recipe.weight !== 'light') {
      if (!Array.isArray(out.prompt_order)) out.prompt_order = [];
      if (!out.prompt_order.length) out.prompt_order.push({ character_id: 100001, order: [] });
      out.prompt_order[0] = { ...out.prompt_order[0], order: effective.map((b: any) => ({ identifier: b.identifier, enabled: b.enabled })) };
    }
    const regexIds = Array.isArray(recipe.regex_ids) ? recipe.regex_ids : [];
    let regexScripts: any[] = [];
    if (regexIds.length) {
      const placeholders = regexIds.map(() => '?').join(', ');
      const regexRows = await env.OC_DB.prepare(
        `SELECT id, name, find, replace, flags, direction, enabled, meta FROM desk_regex WHERE id IN (${placeholders}) ORDER BY sort_order, id`
      ).bind(...regexIds).all<any>();
      regexScripts = (regexRows.results || []).map((r: any) => {
        const meta = safeJsonParse(r.meta, {});
        return {
          id: String(meta.ext_id || r.id), scriptName: String(r.name || ''),
          findRegex: joinRegexLiteral(String(r.find || ''), String(r.flags || '')),
          replaceString: String(r.replace || ''), disabled: !r.enabled,
          promptOnly: r.direction === 'up' || r.direction === 'both',
          markdownOnly: r.direction === 'down' || r.direction === 'both',
          runOnEdit: !!meta.runOnEdit, placement: Array.isArray(meta.placement) ? meta.placement : [],
          substituteRegex: Number(meta.substituteRegex) || 0, minDepth: meta.minDepth ?? null,
          maxDepth: meta.maxDepth ?? null, trimStrings: Array.isArray(meta.trimStrings) ? meta.trimStrings : [],
        };
      });
    }
    if (!out.extensions || typeof out.extensions !== 'object' || Array.isArray(out.extensions)) out.extensions = {};
    out.extensions.regex_scripts = regexScripts;
    for (const [k, v] of Object.entries(recipe.params || {})) out[k] = v;
    out.name = recipe.name;
    out.tavern_study_recipe = { version: 1, name: recipe.name, weight: recipe.weight, exported_at: new Date().toISOString() };
    return { success: true, name: recipe.name, data: out };
  } catch (err: any) {
    return { success: false, error: err.message, server: true };
  }
}

// ===== POST /api/oc/desk/recipes =====
export async function deskRecipeCreate(env: DeskRecipesEnv, body: any): Promise<any> {
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };

  // 拍板(部署者,配方从project维度升为全桌通用):预设包/正则本来就是全局的,唯配方钉在project上,
  // 导致"配方藏在别的项目里,别的窗口选不到、包也删不掉"。project 从此改为可选——没传/空就落
  // 空串(desk_recipes.project 列是NOT NULL,写空串合法,不做迁移改列)。project 列本身保留,
  // 只是不再当筛选/归属维度用,纯粹是历史痕迹(老配方那批行project有值,新配方一律''）。
  // 类型闸与 update 对齐：缺省落空串，传入非字符串则明确拒绝。
  // 静默转空串会把"主动全局化"和"错误请求"腌成同一种数据,事后分不出来。
  if (body.project !== undefined && typeof body.project !== 'string') {
    return { success: false, error: `project 传了就必须是字符串,实际收到的是 ${Array.isArray(body.project) ? 'array' : typeof body.project}` };
  }
  const project = typeof body.project === 'string' ? body.project.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const presetId = typeof body.preset_id === 'string' ? body.preset_id.trim() : '';
  if (!name) return { success: false, error: 'name 必填' };
  if (!presetId) return { success: false, error: 'preset_id 必填' };

  let weight = 'heavy';
  if (body.weight !== undefined) {
    if (body.weight !== 'light' && body.weight !== 'heavy') return { success: false, error: 'weight 必须是 light/heavy 二选一' };
    weight = body.weight;
  }

  const ovErr = validateOverrides(body.overrides);
  if (ovErr) return { success: false, error: ovErr };
  const rxErr = validateRegexIds(body.regex_ids);
  if (rxErr) return { success: false, error: rxErr };
  const paErr = validateParams(body.params);
  if (paErr) return { success: false, error: paErr };
  if (body.light_system !== undefined && typeof body.light_system !== 'string') {
    return { success: false, error: 'light_system 必须是字符串' };
  }

  // preset_id 存在性校验(快路径报错文案):配方钉在具体包上(工单§0铁律6),钉一个不存在的包
  // 前置 SELECT 只提供“包不存在”的即时反馈，真正不变量在条件写入。
  // 的即时反馈,不是真正的不变量守卫——查完到真正INSERT之间有并发窗口,预设包可以在这中间被
  // deskPresetDelete删掉(deskPresetDelete反过来也查"有没有配方引用"当拒删条件,双方都在查
  // 对方此刻的状态,查完到写完这段窗口天然存在竞态)。真不变量焊进下面的INSERT本身。
  try {
    const preset = await env.OC_DB.prepare(`SELECT id FROM desk_presets WHERE id = ?`).bind(presetId).first<any>();
    if (!preset) return { success: false, error: `preset_id 不存在: ${presetId}` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  const id = genId('rc');
  const now = new Date().toISOString();
  const overrides = body.overrides || {};
  const regexIds = body.regex_ids || [];
  const params = body.params || {};
  const lightSystem = body.light_system || '';

  // 条件写入必须重新验证预设包存在。
  // INSERT ... SELECT ... WHERE EXISTS 把"这个预设包此刻还在不在"这件事焊进插入语句执行的
  // 瞬间复核,而不是信一次查询快照——真要撞上"刚查完存在,INSERT前被删掉"这个极窄窗口,
  // WHERE EXISTS 为假,SELECT 不产出任何行,INSERT 插入0行,不会留下钉在幽灵包上的孤儿配方。
  try {
    const meta = await env.OC_DB.prepare(
      `INSERT INTO desk_recipes (id, project, name, preset_id, weight, overrides, regex_ids, params, light_system, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM desk_presets WHERE id = ?)`
    ).bind(id, project, name, presetId, weight, safeJsonStringify(overrides), JSON.stringify(regexIds), safeJsonStringify(params), lightSystem, now, now, presetId).run();
    if (!meta.meta || meta.meta.changes !== 1) {
      return { success: false, error: '预设包不存在或刚被删掉' };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  return {
    success: true, id, project, name, preset_id: presetId, weight,
    overrides, regex_ids: regexIds, params, light_system: lightSystem,
    created_at: now, updated_at: now,
  };
}

// ===== PUT /api/oc/desk/recipes/:id:部分更新,给了哪个字段改哪个(照 study.ts studyUpdate 的口径) =====
export async function deskRecipeUpdate(env: DeskRecipesEnv, id: string, body: any): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  if (!body || typeof body !== 'object') return { success: false, error: '请求体不对' };

  if (body.weight !== undefined && body.weight !== 'light' && body.weight !== 'heavy') {
    return { success: false, error: 'weight 必须是 light/heavy 二选一' };
  }
  const ovErr = validateOverrides(body.overrides);
  if (ovErr) return { success: false, error: ovErr };
  const rxErr = validateRegexIds(body.regex_ids);
  if (rxErr) return { success: false, error: rxErr };
  const paErr = validateParams(body.params);
  if (paErr) return { success: false, error: paErr };
  if (body.light_system !== undefined && typeof body.light_system !== 'string') {
    return { success: false, error: 'light_system 必须是字符串' };
  }
  if (body.preset_id !== undefined && (typeof body.preset_id !== 'string' || !body.preset_id.trim())) {
    return { success: false, error: 'preset_id 必须是非空字符串' };
  }

  // 快路径报错文案(同 deskRecipeCreate 头上那段注释口径)——PUT 允许把配方过继给另一个
  // preset_id(不是"配方钉死在包上不可改"那一支),所以这里跟 create 一样有同款并发窗口:
  // 查完这个新目标包存在,到下面真正 UPDATE 之间,它可以被删掉。真不变量焊进 UPDATE 本身。
  if (body.preset_id !== undefined) {
    try {
      const preset = await env.OC_DB.prepare(`SELECT id FROM desk_presets WHERE id = ?`).bind(body.preset_id.trim()).first<any>();
      if (!preset) return { success: false, error: `preset_id 不存在: ${body.preset_id}` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  const sets: string[] = [];
  const values: any[] = [];
  if (body.project !== undefined) {
    // 同 deskRecipeCreate 头上那条拍板:配方全桌通用后,project 只是历史痕迹列,传了就存
    // (可以是空串,用来把老配方的项目归属抹掉),不再要求非空。
    if (typeof body.project !== 'string') return { success: false, error: 'project 必须是字符串' };
    sets.push('project = ?'); values.push(body.project.trim());
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return { success: false, error: 'name 必须是非空字符串' };
    sets.push('name = ?'); values.push(body.name.trim());
  }
  if (body.preset_id !== undefined) { sets.push('preset_id = ?'); values.push(body.preset_id.trim()); }
  if (body.weight !== undefined) { sets.push('weight = ?'); values.push(body.weight); }
  if (body.overrides !== undefined) { sets.push('overrides = ?'); values.push(safeJsonStringify(body.overrides)); }
  if (body.regex_ids !== undefined) { sets.push('regex_ids = ?'); values.push(JSON.stringify(body.regex_ids)); }
  if (body.params !== undefined) { sets.push('params = ?'); values.push(safeJsonStringify(body.params)); }
  if (body.light_system !== undefined) { sets.push('light_system = ?'); values.push(body.light_system); }

  if (sets.length === 0) return { success: false, error: '没给要改的字段' };

  const now = new Date().toISOString();
  sets.push('updated_at = ?');
  values.push(now);
  values.push(id);

  // 修改 preset_id 时，UPDATE 必须额外验证目标预设仍存在。
  // EXISTS(desk_presets WHERE id=新preset_id) 在写入的瞬间复核一遍,不是信前面那次查询快照——
  // 撞上"刚查完存在,UPDATE前被删掉"这个极窄窗口,EXISTS为假,这条UPDATE整条不生效(changes=0),
  // 不会把配方过继给一个刚消失的幽灵包。preset_id 没在改的PUT(只改name/weight等字段)不涉及
  // 这个窗口,不需要这段守卫,原样只按 id 定位。
  let sql = `UPDATE desk_recipes SET ${sets.join(', ')} WHERE id = ?`;
  if (body.preset_id !== undefined) {
    sql += ` AND EXISTS (SELECT 1 FROM desk_presets WHERE id = ?)`;
    values.push(body.preset_id.trim());
  }

  try {
    const meta = await env.OC_DB.prepare(sql).bind(...values).run();
    if (!meta.meta || meta.meta.changes === 0) {
      // changes=0 有两种可能:配方本来就不存在,或者(preset_id在改时)EXISTS守卫把这次更新拦下了
      // ——查一次配方还在不在,给准确报错,不用同一句"配方不存在"糊弄两种不同的失败原因。
      if (body.preset_id !== undefined) {
        const stillThere = await env.OC_DB.prepare(`SELECT id FROM desk_recipes WHERE id = ?`).bind(id).first<any>();
        if (stillThere) return { success: false, error: '预设包不存在或刚被删掉' };
      }
      return { success: false, error: '配方不存在' };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  return { success: true, id, updated_at: now };
}

// ===== 删除配方：仍被写作窗引用时拒绝 =====
// 窗口还钉着旧recipe_id,重roll直接500"配方不存在",得手动接回新配方才救得回)=====
// 护栏照 desk.ts deskPresetDelete 家法抄一份(desk_windows.recipe_id 反过来钉配方,跟
// desk_recipes.preset_id 钉预设包是同一种"下游钉着上游"的形状,拒删条件同构):有窗口钉在这份
// 配方上就拒删并点名窗口,不做级联(不会替部署者决定把窗口甩去哪个配方,换配方是她自己的活,见②
// 前端的换配方下拉);无引用才放行。三段式(precheck文案+DELETE焊NOT EXISTS+changes=0再查一次
// 区分"被钉住"vs"不存在")同 deskPresetDelete 头注释那套竞态裁决,不再重复展开理由。
export async function deskRecipeDelete(env: DeskRecipesEnv, id: string): Promise<any> {
  if (!id) return { success: false, error: '缺 id' };
  try {
    const recipe = await env.OC_DB.prepare(`SELECT id FROM desk_recipes WHERE id = ?`).bind(id).first<any>();
    if (!recipe) return { success: false, error: '配方不存在' };

    const formatWindowRef = (w: any) => `${w.title || '(无标题)'}(项目「${w.project}」)`;
    const precheck = await env.OC_DB.prepare(`SELECT title, project FROM desk_windows WHERE recipe_id = ?`).bind(id).all<any>();
    const precheckNames = (precheck.results || []).map(formatWindowRef);
    if (precheckNames.length > 0) {
      return { success: false, error: `还有写作窗钉在这份配方上：${precheckNames.join('、')}，先给窗口换配方再删` };
    }

    const meta = await env.OC_DB.prepare(
      `DELETE FROM desk_recipes WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM desk_windows WHERE recipe_id = ?1)`
    ).bind(id).run();
    if (!meta.meta || meta.meta.changes === 0) {
      // NOT EXISTS 在DELETE执行的瞬间拦下了(precheck之后、DELETE真正跑之前的窗口里冒出了新引用,
      // 或者更罕见——配方在这中间被另一个并发请求删掉了)。重查一次给准确报错,不猜。
      const stillThere = await env.OC_DB.prepare(`SELECT id FROM desk_recipes WHERE id = ?`).bind(id).first<any>();
      if (!stillThere) return { success: false, error: '配方不存在' };
      const recheck = await env.OC_DB.prepare(`SELECT title, project FROM desk_windows WHERE recipe_id = ?`).bind(id).all<any>();
      const recheckNames = (recheck.results || []).map(formatWindowRef);
      return { success: false, error: `还有写作窗钉在这份配方上：${recheckNames.join('、')}，先给窗口换配方再删` };
    }
    return { success: true, id };
  } catch (err: any) {
    // 裸 catch 表示 D1/查询层真实故障，必须标 server 错误。
    // 不是"配方不存在"或"被引用拒删"这类业务判定——照 deskPresetDelete 同款标记 server:true,
    // 让路由层(index.ts)分得清"该报400/404"还是"该报500",别把DB故障伪装成客户端请求错误。
    return { success: false, error: err.message, server: true };
  }
}
