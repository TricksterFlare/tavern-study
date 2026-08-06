'use client';

// 🧰 打字桌 · 抽屉全家:积木/配方·世界书·正则·核心记忆·导入 五个标签页,全塞进一个居中弹层里,
// 从 TypingDesk.tsx 窗口列表屏的 🧰 钮打开。
// 这整个文件就是"抽屉"本体——写作主流程(TypingDesk.tsx)一个字不碰这里的状态,
// 关掉弹层等于这些东西从没打开过。
//
// 家法同款:fetch 全 try/catch,res.ok && body.success===true 双验,变更类请求收紧到 success===true
// 才算数,加载/错误/空态三态分开,颜色只走 var(--xxx)。双确认删除照 TypingDesk.tsx onWinDeleteClick
// 的计时器手法抄一份。
//
// 世界书互通口径:没有指针层了——世界书条目/角色卡就是书架里 category 为
// 设定/大纲的那一行,正文与触发配置同住一行。旧的 desk_lore 指针表已经 DROP 掉。

import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';

// ── 数据形状(照后端 tools/deskPanels.ts / tools/desk.ts / tools/deskRecipes.ts / tools/study.ts 的真实返回来)──
type Weight = 'light' | 'heavy';
type PresetSummary = { id: string; name: string; block_count: number; queue_count: number; library_count: number; created_at: string };
type BlockRow = {
  id: string; identifier: string; name: string; role: string; marker: boolean;
  in_queue: boolean; queue_pos: number | null; enabled_default: boolean;
  content_preview: string; content_len: number; content?: string; // full=1 请求才带 content(见 GET /presets/:id/blocks)
};
type Recipe = {
  id: string; project: string; name: string; preset_id: string; weight: Weight;
  overrides: Record<string, { enabled?: boolean; pos?: number }>;
  regex_ids: string[]; params: any; light_system: string;
  created_at: string; updated_at?: string;
};
type CharacterFields = {
  description?: string; personality?: string; scenario?: string; mes_example?: string;
  main_prompt?: string; post_history_instructions?: string;
};
const STANDARD_SLOT_HINTS: Record<string, string> = {
  worldInfoBefore: '装入命中的前置世界书',
  personaDescription: '装入当前 Persona 描述',
  charDescription: '装入在场角色 Description；旧卡回退到完整正文',
  charPersonality: '装入在场角色 Personality',
  scenario: '装入在场角色 Scenario',
  worldInfoAfter: '装入命中的后置世界书',
  chatExamples: '装入在场角色 Example Messages',
  chatHistory: '装入核心记忆、召回章节、近期章、时光带与窗口楼层',
};
type LoreRow = {
  // category:世界书收 world(设定)+outline(大纲)两类,大纲行靠它上徽章认脸;
  // 旧版接口没有这个字段,设成可选、缺省当 world 看待。
  id: string; project: string; category?: string; name: string; keys: string[]; content: string;
  fields: CharacterFields;
  // source/memory_id/resolved_title 三个过渡期字段随 desk_lore 退役一并删除(后端已停发)。
  // 它们在这份类型里从来只有声明、没有取值点——留着只会让人以为"指针层还在"。
  position: 'before' | 'after' | 'char';
  is_char: boolean; enabled: boolean; constant: boolean;
  // 角色卡触发模式。'scan'=正文扫描+在场名单(默认);'presence'=只认状态板「在场角色」。
  // 单字名(比如"露"/"寻")在中文散文里被"暴露/寻常"这类词稳定误伤,子串匹配没有词边界可依,只能靠状态板。
  trigger_mode?: 'scan' | 'presence';
  created_at: string; updated_at?: string;
};
type ShelfMemory = { id: string; project: string; category: string; title: string; preview: string; created_at: string };
type RegexRow = {
  id: string; scope: 'preset' | 'global'; preset_id: string | null; name: string;
  find: string; replace: string; flags: string;
  direction: 'up' | 'down' | 'both'; enabled: boolean; invalid: boolean; unsafe: boolean; invalid_reason: string | null;
};
type CoreBlock = { title: string; text: string };

// ── Sage 风格小料(照 TypingDesk.tsx 同款抄一份,每文件各自小份复制是本仓一贯风格)──
const cardStyle: React.CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--line-soft)', borderRadius: 16, boxShadow: '0 4px 12px var(--card-shadow)',
};
const inputStyle: React.CSSProperties = {
  fontSize: 13, color: 'var(--ink-body)', background: 'var(--card-bg)', border: '1px solid var(--line-soft)',
  borderRadius: 10, padding: '8px 12px', fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box',
};
const btnPrimaryStyle: React.CSSProperties = {
  fontSize: 12.5, color: '#fff', background: 'var(--accent)', border: 'none',
  padding: '8px 16px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
};
const btnGhostStyle: React.CSSProperties = {
  fontSize: 12, color: 'var(--ink-body)', background: 'var(--card-bg)', border: '1px dashed var(--dash-line)',
  padding: '7px 14px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
};
const errColor = '#c2693f';
const badgeStyle: React.CSSProperties = {
  fontSize: 10.5, padding: '2px 8px', borderRadius: 20, background: 'var(--scale-0)', color: 'var(--ink2)', whiteSpace: 'nowrap',
};
// 字段标题:世界书这几个编辑框原来全靠 placeholder 说自己是谁——一填字提示就消失,回头再看
// 就是一排没名字的框,跟书架编辑器长得还像,容易把"触发关键词"误认成书架的「标签」。占位提示
// 留着当例子,标题才是那个不会消失的名牌。
const fieldLabelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--ink2)', marginBottom: 4 };

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      style={{
        width: 34, height: 19, borderRadius: 20, border: 'none', cursor: disabled ? 'default' : 'pointer',
        background: checked ? 'var(--accent)' : 'var(--line-soft)', position: 'relative', flexShrink: 0,
        opacity: disabled ? 0.5 : 1, transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: checked ? 17 : 2, width: 15, height: 15, borderRadius: '50%',
        background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.2)',
      }} />
    </button>
  );
}

// 双确认删除小按钮(照 TypingDesk.tsx onWinDeleteClick 的计时器手法抄一份,每处用法各自持一份 stage/timer)
function useDoubleConfirm(action: (id: string) => void) {
  const [stage, setStage] = useState<Record<string, 0 | 1>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  function click(id: string) {
    const s = stage[id] || 0;
    if (s === 0) {
      setStage((p) => ({ ...p, [id]: 1 }));
      if (timers.current[id]) clearTimeout(timers.current[id]);
      timers.current[id] = setTimeout(() => setStage((p) => ({ ...p, [id]: 0 })), 3000);
      return;
    }
    if (timers.current[id]) clearTimeout(timers.current[id]);
    setStage((p) => ({ ...p, [id]: 0 }));
    action(id);
  }
  return { stage, click };
}

// ══════════════════════════════════════════ ① 积木/配方 ══════════════════════════════════════════
// N选1真单选钮(同组物理互斥)判断留观:S1导入解析器没抽 ST 的"分组互斥"字段(工单§4 S2范围早钉过
// 这条——desk_blocks 落库时就没存这个位),这里没有组信息可供 UI 做真单选。S5a 按工单原文"SKIP for
// S5a,ST has no group data"跳过,只做普通 toggle;真互斥要等 S1 解析器补上分组字段才谈得上。
function BlocksTab({ base, envOk, project, onDirtyChange, onRegexChanged, onOverlayOpenChange }: { base: string; envOk: boolean; project: string; onDirtyChange?: (dirty: boolean) => void; onRegexChanged?: () => void; onOverlayOpenChange?: (open: boolean) => void }) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [recipeId, setRecipeId] = useState('');
  const [nonce, setNonce] = useState(0);
  // 请求令牌——project 已经在外层 key={project} 上,切项目会整份组件重挂载(旧请求的回调
  // 落进已卸载实例,天然作废);这个 ref 补的是同一挂载周期内的重复加载(nonce 变化=新建配方后
  // 重拉列表),旧请求慢慢吞吞回来时不许用它去覆盖后来者已经写好的状态。
  const recipesSeqRef = useRef(0);
  const blocksSeqRef = useRef(0);

  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [blocksError, setBlocksError] = useState('');

  // 本地待存草稿:overrides + weight + light_system,跟服务端已存版本分开,点保存才提交
  const [overrides, setOverrides] = useState<Record<string, { enabled?: boolean; pos?: number }>>({});
  // overridesRef 是 overrides 的同步镜像,是"当前overrides真值"唯一可信来源——React不保证
  // setState 的函数式updater在dispatch返回前执行(并发渲染/待处理更新会延后),setOv/
  // reorderQueueDrag/insertIntoQueue这类"要在同一个事件循环tick里连点判断no-op/连续编辑"的
  // 场景,靠state本身做不了同步判断(第二次调用发生时state可能还没吃到第一次的结果,读到的是
  // 过期快照)。改法:每处改overrides统一走"从ref纯计算next→(no-op就此打住,不碰ref/state)→
  // ref.current=next(同步写)→setOverrides(next)(直接传值,不再用函数式updater——updater
  // 体内改外部变量违反纯函数要求,Strict Mode双跑下还会跑两次副作用,不安全)→同步敲
  // editRevRef/setDirty/setSaved"这一套。ref写完立刻能被下一次调用读到,不用等React重渲染,
  // 连点场景由ref的同步性天然保证(第二击看到的一定是第一击写完的ref)。
  // 装载/重建overrides的地方(loadBlocks再水化/切配方/保存成功后写回——这三条全汇合在loadBlocks
  // 那一个if(!keepDraft)分支里,见下方)一律要把ref跟state一起同步更新,两者绝不允许分家。
  const overridesRef = useRef<Record<string, { enabled?: boolean; pos?: number }>>({});
  const [weight, setWeight] = useState<Weight>('heavy');
  const [lightSystem, setLightSystem] = useState('');
  const [dirty, setDirty] = useState(false);
  const [blockDrafts, setBlockDrafts] = useState<Record<string, string>>({});
  const hasBlockDrafts = Object.keys(blockDrafts).length > 0;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  // 修订号闸门:每一处"这算一次用户编辑"的地方(setOv/拖拽调序/切轻重/改轻system)都把这个
  // ref 敲一下。保存请求发出去时拍一张当下的 rev 快照;响应回来时只有 rev 还等于"当下最新的
  // rev"才敢把 dirty 清成 false——如果保存这一路上用户又手速改了草稿(rev 涨了),说明这次
  // 成功响应装的是"旧版草稿"的确认,新改动还没上车,dirty 必须留 true,不然会出现"看着已存✓,
  // 其实最新那笔改动根本没进请求体"的静默丢字。不锁编辑器(写作过程不想被半路冻住),靠这根
  // 计数器兜底,不靠"保存中就不让碰"。
  const editRevRef = useRef(0);
  // 换配方两段确认:armed=待确认的目标配方id,3.5s过期撤防
  const [switchArm, setSwitchArm] = useState<string | null>(null);
  const switchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // dirty 的 ref 镜像 + 草稿属于哪个配方——loadBlocks 的"再水化让位"判据
  const dirtyRef = useRef(false);
  const draftRecipeIdRef = useRef('');
  // recipeId 的 ref 镜像:recipes 刷新 effect 的 deps 里没有 recipeId(有会造成刷新环),
  // 拿它在响应回来时读"当下选中的配方",在 setState 外面纯算决策(updater 内赋值不纯,不安全)
  const recipeIdRef = useRef('');
  useEffect(() => { recipeIdRef.current = recipeId; }, [recipeId]);
  useEffect(() => {
    dirtyRef.current = dirty;
    // 所有权只在"草稿出生"时登记一次、"草稿死亡"时注销——绝不随 recipeId 变化改嫁(确认切换后
    // dirty 还没清的那一帧,镜像若把所有权改到新配方头上,旧草稿会顶着新id活下来)。
    if (dirty && !draftRecipeIdRef.current) draftRecipeIdRef.current = recipeId;
    if (!dirty) draftRecipeIdRef.current = '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, recipeId]);

  // 把"有没有没保存的配方草稿"报给外层抽屉壳(Escape 关闭判断用)——卸载(切标签页/关抽屉)
  // 时清 false,因为草稿本身(local state)也跟着这次卸载一起没了,不该继续占着"脏"位子。
  useEffect(() => {
    onDirtyChange?.(dirty || hasBlockDrafts);
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, hasBlockDrafts]);

  // 就地建配方(照 TypingDesk.tsx openMiniCreate 同款,精简版)
  // 预设包列表独立加载/独立报错——原先跟配方列表拼在同一个 Promise.all 里静默吞失败(pRes.ok
  // 才读,读失败 presets 就晾着空数组),前端会把"服务器翻车"误读成"真的还没导过预设包",
  // 误导用户白跑一趟导入。现在拆成自己的 loading/error 态 + 重试按钮,创建按钮在预设包不可用时
  // 明确说原因,不让"建不了"变成一声不响的灰按钮。
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(true);
  const [presetsError, setPresetsError] = useState('');
  const presetsSeqRef = useRef(0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPresetId, setNewPresetId] = useState('');
  const [newWeight, setNewWeight] = useState<Weight>('heavy');
  const [createError, setCreateError] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const loadPresets = useCallback(async () => {
    if (!envOk) { setPresetsError('环境变量没配好'); setPresetsLoading(false); return; }
    setPresetsLoading(true); setPresetsError('');
    const tok = ++presetsSeqRef.current;
    try {
      const res = await fetch(`${base}/api/oc/desk/presets`);
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '预设包翻不出来');
      if (tok !== presetsSeqRef.current) return; // 令牌过期:更新的一次加载已经在路上
      setPresets(Array.isArray(d.presets) ? d.presets : []);
    } catch (e: any) {
      if (tok !== presetsSeqRef.current) return;
      setPresetsError(e.message || '预设包翻不出来');
    } finally {
      if (tok === presetsSeqRef.current) setPresetsLoading(false);
    }
  }, [base, envOk]);

  useEffect(() => { loadPresets(); }, [loadPresets]);

  useEffect(() => {
    if (!envOk) { setError('环境变量没配好'); setLoading(false); return; }
    setLoading(true); setError('');
    const tok = ++recipesSeqRef.current;
    (async () => {
      try {
        // 配方从project维度升级为全桌通用——不再传project过滤,拉全量:预设包/正则本来就是
        // 全局的,唯配方钉在project上,导致"配方藏在别的项目里,这个项目的抽屉里看不到也删不掉"。
        // 抽屉现在一份列表看全部配方,任何项目的窗口都能选任何配方。
        const rRes = await fetch(`${base}/api/oc/desk/recipes`);
        const rD = await rRes.json().catch(() => null);
        if (!rRes.ok || !rD || rD.success !== true) throw new Error(rD?.error || '配方翻不出来');
        if (tok !== recipesSeqRef.current) return; // 令牌过期,别用旧响应覆盖后来者
        const list: Recipe[] = Array.isArray(rD.recipes) ? rD.recipes : [];
        // 决策全在 setState 外面纯算:当前配方从列表消失(极端:并发被删)且脏草稿属于它
        // →原地扣留不跳船,亮提示,且不强制切进"新建"视图把编辑区藏起来;干净态照常回退到第一个。
        const prevId = recipeIdRef.current;
        const stillThere = !!prevId && list.some((r) => r.id === prevId);
        const holdVanished = !stillThere && !!prevId && dirtyRef.current && draftRecipeIdRef.current === prevId;
        setRecipes(list);
        if (!stillThere && !holdVanished) setRecipeId(list[0]?.id || '');
        if (holdVanished) setSaveError('这个配方在服务端已经不存在了——草稿还留在屏上,先把改动复制走或新建配方另存');
        if (list.length === 0 && !holdVanished) setCreating(true);
      } catch (e: any) {
        if (tok !== recipesSeqRef.current) return;
        setError(e.message || '配方翻不出来');
      } finally {
        if (tok === recipesSeqRef.current) setLoading(false);
      }
    })();
  }, [base, envOk, project, nonce]);

  useEffect(() => {
    if (newPresetId || presets.length === 0) return;
    setNewPresetId(presets[0].id);
  }, [presets, newPresetId]);

  const loadBlocks = useCallback(async () => {
    const recipe = recipes.find((r) => r.id === recipeId);
    if (!recipe) {
      // 护稿扣留态(配方消失但脏草稿属于它)不清积木行——留着队列/库的行方便核对/抄走改动;
      // 干净态查无此配方才清空。
      if (!(dirtyRef.current && draftRecipeIdRef.current === recipeId)) setBlocks([]);
      return;
    }
    setBlocksLoading(true); setBlocksError('');
    // 再水化尊重草稿:不管谁触发了 recipes 刷新(建配方nonce/保存基线/项目重挂),只要正在编辑
    // 的还是同一个配方的脏草稿,服务端基线就不许覆盖编辑区——堵触发路径堵不完,让水化让位。
    // recipeId 真变了(只能经 requestSwitchRecipe 的确认闸或干净态)才照常重置。
    const keepDraft = dirtyRef.current && draftRecipeIdRef.current === recipeId;
    if (!keepDraft) {
      // 这一个分支是overrides所有"装载/重建"路径的唯一汇合点——re-hydration(服务端
      // 基线变了)、切配方(新recipeId带来新recipe.overrides)、保存成功后写回(saveRecipe更新
      // recipes数组→loadBlocks的useCallback依赖变了→这个effect重跑,此时dirty已经被saveRecipe
      // 清成false,keepDraft算出false,落进这个分支)三条全在这里——ref必须跟state同步重置,
      // 不然下一次setOv/insertIntoQueue会算在一份过期ref上。
      overridesRef.current = recipe.overrides || {};
      setOverrides(recipe.overrides || {});
      setWeight(recipe.weight);
      setLightSystem(recipe.light_system || '');
      setDirty(false); setSaveError(''); setSaved(false);
    }
    const tok = ++blocksSeqRef.current;
    try {
      // full=1:积木行要能点开看整段content,顺带把队列/库两段都拿到全文——同一个预设包的
      // 几百KB级content一次性倒回来跟导入时的量级同阶,前端只在打开这个配方编辑器时才拉一次,
      // 不是高频轮询,划得来。
      const res = await fetch(`${base}/api/oc/desk/presets/${recipe.preset_id}/blocks?full=1`);
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '积木翻不出来');
      if (tok !== blocksSeqRef.current) return;
      setBlocks(Array.isArray(d.blocks) ? d.blocks : []);
    } catch (e: any) {
      if (tok !== blocksSeqRef.current) return;
      setBlocksError(e.message || '积木翻不出来'); setBlocks([]);
    } finally {
      if (tok === blocksSeqRef.current) setBlocksLoading(false);
    }
  }, [base, recipeId, recipes]);

  useEffect(() => { loadBlocks(); }, [loadBlocks]);

  async function createRecipe() {
    const name = newName.trim();
    if (!name || !newPresetId || createBusy || presetsLoading || presetsError) return;
    setCreateBusy(true); setCreateError('');
    const revAtSubmit = editRevRef.current; // POST路上若又有编辑(rev涨),响应闭包里的旧dirty不算数
    try {
      if (!envOk) throw new Error('环境变量没配好');
      // 配方全桌通用,建配方不再带project——后端project已经改可选,不传就落''。
      const body = { name, preset_id: newPresetId, weight: newWeight };
      const res = await fetch(`${base}/api/oc/desk/recipes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '配方没建成(服务端没确认成功)');
      setCreating(false); setNewName('');
      setNonce((n) => n + 1);
      // 当前配方有未存草稿时不自动跳新配方(自动跳=绕过丢弃确认闸)——建好留在原地,
      // 亮提示让用户手动切(手动切会走 requestSwitchRecipe 的两段确认);没草稿才直接跳。
      // dirty用"提交时闭包值 ∪ POST期间rev有没有涨"合判,防请求延迟窗口里新打的字被旧闭包漏看。
      if (dirty || revAtSubmit !== editRevRef.current) {
        setCreateError(`「${name}」已建好——当前配方还有未保存草稿,存好后从下拉切换过去`);
      } else {
        setRecipeId(d.id);
      }
    } catch (e: any) { setCreateError(e.message || '配方没建成'); }
    finally { setCreateBusy(false); }
  }

  // 参数化取overrides来源:computeEffective 是纯函数,吃哪份 overridesMap 由调用方决定。
  // effective() 是它在"渲染时展示用当前state"这个场景下的薄包装,给JSX读;setOv/toggleEnabled/
  // reorderQueueDrag/insertIntoQueue 这类写入路径统一改吃 overridesRef.current(同步事实源,
  // 见 overrides state 声明处的长注释),不吃这份可能滞后于ref的render-time state。
  function computeEffective(b: BlockRow, overridesMap: Record<string, { enabled?: boolean; pos?: number }>) {
    const ov = overridesMap[b.identifier];
    const enabled = ov?.enabled ?? b.enabled_default;
    const pos = ov?.pos ?? b.queue_pos;
    const inQueue = b.in_queue || ov?.pos !== undefined;
    return { enabled, pos, inQueue };
  }
  function effective(b: BlockRow) { return computeEffective(b, overrides); }
  const queueSection = blocks.filter((b) => effective(b).inQueue)
    .sort((a, b) => (effective(a).pos ?? 0) - (effective(b).pos ?? 0));
  const librarySection = blocks.filter((b) => !effective(b).inQueue)
    .sort((a, b) => a.name.localeCompare(b.name));

  // setOv 是唯一"单块patch"入口,走同步ref模式(病根见上方overridesRef声明处)——从ref
  // 纯计算next、ref.current=next(同步写)、setOverrides(next)(直接传值,不再用函数式
  // updater)、同步敲rev/dirty/saved。写完立刻能被同一tick内下一次调用读到。
  function setOv(identifier: string, patch: { enabled?: boolean; pos?: number }) {
    // handler入口闸——recipeDeleting在飞时冻结一切编辑入口(toggleEnabled走这里;
    // insertIntoQueue/reorderQueueDrag是多项重编号,各自持一份同款入口闸,不复用这个函数体但
    // 遵守同一条规矩),这份配方眼看要被删,继续编辑没有意义,UI层disable见下方Toggle/仓库选择器。
    if (recipeDeleting) return;
    const next = { ...overridesRef.current, [identifier]: { ...overridesRef.current[identifier], ...patch } };
    overridesRef.current = next;
    setOverrides(next);
    editRevRef.current += 1; setDirty(true); setSaved(false);
  }
  // toggleEnabled 算目标值也改吃 overridesRef——同一条判修的自然延伸:不只setOv的"写"要同步,
  // 这里的"读"也不能读可能滞后的render-time state,不然连点两下同一颗开关,第二下算出来的
  // 目标值还是基于第一下落地之前的旧值,两下会变成"原地没动"而不是真的切两次。
  function toggleEnabled(b: BlockRow) { setOv(b.identifier, { enabled: !computeEffective(b, overridesRef.current).enabled }); }

  // 队列常驻+仓库弹出(酒馆Prompt Manager同款交互)——原「上架到队尾」按钮的逻辑
  // 并进这一个函数,不留两套入口:afterIdentifier=null 时插到队尾(即旧 promoteToQueue 的行为),
  // 给了锚点identifier就插在那块后面。跟 reorderQueueDrag 同一套"整段按新序重编号0..N-1"手法
  // (别另起炉灶)——把新块的identifier插进当前队列identifier数组的对应位置,再统一重新编号:
  // 已在队列的块只动pos(enabled等其它字段原样),新插入的块额外强制enabled:true(照旧
  // promoteToQueue的口径,上架=默认点亮,不是保持它在库里时的原始enabled_default)。
  // 这里刻意不用 setOverrides 的函数式updater、在updater体内读写外部变量做"是否插入了"的标记
  // ——违反纯函数要求(Strict Mode下updater会额外多跑一次,外部变量被双写不安全),且React不
  // 保证updater在dispatch返回前执行(并发渲染/待处理更新会延后执行),dispatch调用后立刻读
  // 某个外部变量来决定要不要敲rev/dirty并不可靠:插入本身可能真落进了overrides,但rev/dirty
  // 没跟上——等于这次编辑没有"未存草稿"提示,能被切配方/关抽屉之类的丢弃式操作悄悄冲掉。改法:
  // no-op判断(块已在队列)在碰ref/state之前就同步return,该发生的副作用(算新序→ref写入→
  // setOverrides→rev/dirty/saved)在计算完成后一次性顺序做完,不依赖dispatch之后再读某个中途
  // 变量的值——判断和副作用全在同一个同步函数体里跑完,调用方返回时状态已经笃定。
  function insertIntoQueue(block: BlockRow, afterIdentifier: string | null) {
    // 入口闸同 setOv/reorderQueueDrag:recipeDeleting在飞时冻结插入,UI层disable见仓库选择器。
    if (recipeDeleting) return;
    const prev = overridesRef.current;
    const currentQueueIds = blocks
      .filter((b) => computeEffective(b, prev).inQueue)
      .sort((a, b) => (computeEffective(a, prev).pos ?? 0) - (computeEffective(b, prev).pos ?? 0))
      .map((b) => b.identifier);

    if (currentQueueIds.includes(block.identifier)) return; // 已在队列——同步no-op,不重复插,不标脏

    let insertAt = currentQueueIds.length; // 默认队尾
    if (afterIdentifier) {
      const idx = currentQueueIds.indexOf(afterIdentifier);
      // 锚点在极端时序里找不到(队列在选择器开着的时候被别的动作改了)不报错炸掉,退化成插队尾
      insertAt = idx >= 0 ? idx + 1 : currentQueueIds.length;
    }
    const reordered = currentQueueIds.slice();
    reordered.splice(insertAt, 0, block.identifier);

    const next = { ...prev };
    reordered.forEach((identifier, i) => {
      next[identifier] = { ...next[identifier], pos: i, ...(identifier === block.identifier ? { enabled: true } : {}) };
    });
    overridesRef.current = next;
    setOverrides(next);
    editRevRef.current += 1; setDirty(true); setSaved(false);
  }

  // 仓库选择器(弹层)——队列常驻在主视图,"在库未上架"那一段不再常驻占屏,改成点「＋添加
  // 积木」才弹出来挑。pickerAnchorByBlock 记每一行当前选的插入位置(''=队尾,否则=锚点块
  // identifier),挑之前先选好插入位置,点"插入"才真正提交(不是选完立刻插,留反悔空间)。
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerAnchorByBlock, setPickerAnchorByBlock] = useState<Record<string, string>>({});
  function openPicker() {
    if (recipeDeleting) return; // 触发钮本身也disable(见渲染),这里是入口闸双保险
    setPickerSearch('');
    setPickerOpen(true);
  }
  // 这个选择器没有真正的异步"插入中"状态——insertIntoQueue是纯本地同步的overrides变异,
  // 没有网络往返,不存在"点了插入,还没落地就被Escape关掉"这种窗口。真正跟这个弹层相关的
  // "在飞"锁只有recipeDeleting:触发钮在它为true时已disable(选择器打不开),而且选择器一旦
  // 开着,外层的删除钮被这个弹层的背板整个遮住点不到——recipeDeleting在选择器开着的时候实际上
  // 没有路径能变成true。这里仍然把close挂上这层闸,是防御性双保险(不亏),不是真的堵住了什么
  // 会发生的竞态。
  function closePicker() {
    if (recipeDeleting) return;
    setPickerOpen(false);
  }
  // 双保险第二层:上报给外层 DeskDrawerHub,选择器开着时抽屉自己的Escape 处理跳过关闭(见
  // DeskDrawerHub blocksOverlayOpen 那半)——留着当兜底,真正堵住时序窗口的是下面 capture
  // 阶段那道闸(第一层),这道靠 state 传播(子effect→父重渲染)有一拍延迟,单独指望它挡不住
  // 第一记 Escape,但两层一起够稳:capture闸挡住事件本身,这层挡"万一capture闸没来得及挂上"
  // 这种更极端的窗口(比如effect还没跑完)。卸载/关闭都清 false,同 onDirtyChange 那套生命
  // 周期手法。
  useEffect(() => {
    onOverlayOpenChange?.(pickerOpen);
    return () => onOverlayOpenChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerOpen]);
  const filteredLibrary = pickerSearch.trim()
    ? librarySection.filter((b) => (b.name || b.identifier).toLowerCase().includes(pickerSearch.trim().toLowerCase()))
    : librarySection;

  // 第一层,真正的闸:选择器是个真正的弹层(Escape/点外要关),原实现跟 DeskDrawerHub 自己的
  // Escape 处理是两层 bubble 阶段 document keydown 监听,靠"谁后注册谁先拦"赌时序——
  // onOverlayOpenChange 的状态得经"这个effect→setBlocksOverlayOpen→父组件重渲染"才能生效,
  // 选择器刚打开的那一拍(effect还没跑完这一轮)外层看到的blocksOverlayOpen还是false,这一拍
  // 按下Escape会被外层bubble监听器也接住,两层一起关。
  // 修法:这层监听器改在 capture 阶段注册(第三参true)——capture永远先于bubble执行,从
  // window一路向下先跑一轮,跟谁先注册无关,是DOM事件分发算法本身保证的顺序,不是赌时序;
  // 命中Escape就 stopImmediatePropagation()(不只挡同阶段的其它监听器,也直接掐断这个事件
  // 后续到达任何bubble阶段监听器的路——包括 DeskDrawerHub 那层,不管它此刻的 blocksOverlayOpen
  // 是不是还没更新到true)+ preventDefault()。上面 onOverlayOpenChange 那层留着当第二层双保险
  // (真正兜底靠这层capture闸,不靠时序运气)。
  useEffect(() => {
    if (!pickerOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closePicker();
      }
    }
    document.addEventListener('keydown', onKeyDown, true); // true = capture 阶段
    return () => document.removeEventListener('keydown', onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // recipeDeleting 故意不进 deps(它的 useState 声明在这段代码后面,直接写进依赖数组字面量会
    // 触发"used before declaration"——closePicker 是每次渲染都重新定义的闭包,已经天然吃到当次
    // 渲染的 recipeDeleting,这里只需要 pickerOpen 变化时重新挂/摘监听器,不需要额外触发)。
  }, [pickerOpen]);

  // HTML5拖拽调队列序,同一套 overrides.pos 变异逻辑。▲▼钮已删,拖拽是队列调序唯一手段——
  // 落点算法:整段按拖完的新序重新编号 0..N-1,不是只改被拖的那一个identifier,防止队列出现
  // 跳号,下次拖动的相邻判断也不会因为"旧队列有跳号"而算错。
  // 拖拽=一次编辑,敲 editRevRef 计数器,合流进修订号闸门体系,不另开一套脏值判断。
  function reorderQueueDrag(draggedIdentifier: string, targetIdentifier: string) {
    // handler入口闸——同setOv,recipeDeleting在飞时不许拖拽调序(UI层disable见下方draggable)
    if (recipeDeleting) return;
    if (!draggedIdentifier || draggedIdentifier === targetIdentifier) return;
    // 同 insertIntoQueue,现算队列序改吃 overridesRef.current(+ blocks 现算),不吃
    // 渲染时 queueSection 闭包——拖拽本身单次鼠标动作触发一次,连点风险比"插入"按钮小,但改成
    // 同步ref模式是同一套家法统一执行,不留"只有插入是ref安全的,拖拽还是旧写法"这种不对称。
    const prev = overridesRef.current;
    const ids = blocks
      .filter((b) => computeEffective(b, prev).inQueue)
      .sort((a, b) => (computeEffective(a, prev).pos ?? 0) - (computeEffective(b, prev).pos ?? 0))
      .map((b) => b.identifier);
    const fromIdx = ids.indexOf(draggedIdentifier);
    const toIdx = ids.indexOf(targetIdentifier);
    if (fromIdx < 0 || toIdx < 0) return;
    const reordered = ids.slice();
    reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, draggedIdentifier);
    const next = { ...prev };
    reordered.forEach((identifier, i) => { next[identifier] = { ...next[identifier], pos: i }; });
    overridesRef.current = next;
    setOverrides(next);
    editRevRef.current += 1; setDirty(true); setSaved(false);
  }

  // 积木行"点开看整段content"(预设包管理区的积木行也用这份状态形状)——
  // key 用 identifier,队列/库两段共用一份展开集合,互不冲突(identifier 在 UNIQUE(preset_id,identifier)
  // 约束下同一预设包内本来就唯一)。
  const [blockContentOpen, setBlockContentOpen] = useState<Record<string, boolean>>({});
  const [blockSavingId, setBlockSavingId] = useState<string | null>(null);
  const [blockEditError, setBlockEditError] = useState<Record<string, string>>({});
  function toggleBlockContent(identifier: string) {
    setBlockContentOpen((prev) => ({ ...prev, [identifier]: !prev[identifier] }));
  }
  function blockDraft(b: BlockRow) {
    return Object.prototype.hasOwnProperty.call(blockDrafts, b.id) ? blockDrafts[b.id] : (b.content ?? b.content_preview);
  }
  function setBlockDraftValue(b: BlockRow, content: string) {
    setBlockDrafts((prev) => {
      const next = { ...prev };
      if (content === (b.content ?? b.content_preview)) delete next[b.id];
      else next[b.id] = content;
      return next;
    });
  }
  async function saveBlockContent(b: BlockRow) {
    if (blockSavingId || recipeDeleting) return;
    const content = blockDraft(b);
    setBlockSavingId(b.id); setBlockEditError((p) => ({ ...p, [b.id]: '' }));
    try {
      const res = await fetch(`${base}/api/oc/desk/blocks/${encodeURIComponent(b.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '积木没存上');
      const patchRow = (x: BlockRow): BlockRow => x.id === b.id ? { ...x, content, content_preview: content.slice(0, 200), content_len: content.length } : x;
      setBlocks((prev) => prev.map(patchRow));
      setPresetBlocksCache((prev) => {
        const next = { ...prev };
        for (const [pid, cache] of Object.entries(next)) next[pid] = { ...cache, blocks: cache.blocks.map(patchRow) };
        return next;
      });
      setBlockDrafts((prev) => { const next = { ...prev }; delete next[b.id]; return next; });
    } catch (e: any) {
      setBlockEditError((p) => ({ ...p, [b.id]: e.message || '积木没存上' }));
    } finally { setBlockSavingId(null); }
  }
  const monoContentStyle: React.CSSProperties = {
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace',
    fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6,
    maxHeight: 220, overflowY: 'auto', background: 'var(--scale-0)', borderRadius: 8,
    padding: '8px 10px', margin: 0, color: 'var(--ink-body)',
  };

  // ── 预设包管理区(可折叠,挂在配方编辑主流程下方,不挤占主视线)──
  // 列出所有已导入的包(名字/块数/导入时间),可展开看积木清单(懒加载,展开第一次才拉
  // ?full=1),积木行可再点开看整段content;删除走两段确认→DELETE /api/oc/desk/presets/:id——
  // 后端有引用会拒删并点名配方,这里原样把 error 文案糊出来,不用自己攒判断逻辑。
  const [showPresetManager, setShowPresetManager] = useState(false);
  const [presetExpanded, setPresetExpanded] = useState<Record<string, boolean>>({});
  const [presetBlocksCache, setPresetBlocksCache] = useState<Record<string, { loading: boolean; error: string; blocks: BlockRow[] }>>({});
  const [presetBlockContentOpen, setPresetBlockContentOpen] = useState<Record<string, boolean>>({});
  const [presetDeleteError, setPresetDeleteError] = useState<Record<string, string>>({});
  const [presetDeleteBusy, setPresetDeleteBusy] = useState<string | null>(null);

  async function togglePresetExpand(id: string) {
    const willOpen = !presetExpanded[id];
    setPresetExpanded((prev) => ({ ...prev, [id]: willOpen }));
    if (!willOpen || presetBlocksCache[id]) return; // 已经拉过就不重拉——预设包不可变(工单§0铁律6),缓存永不过期
    setPresetBlocksCache((prev) => ({ ...prev, [id]: { loading: true, error: '', blocks: [] } }));
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/desk/presets/${id}/blocks?full=1`);
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '积木翻不出来');
      setPresetBlocksCache((prev) => ({ ...prev, [id]: { loading: false, error: '', blocks: Array.isArray(d.blocks) ? d.blocks : [] } }));
    } catch (e: any) {
      setPresetBlocksCache((prev) => ({ ...prev, [id]: { loading: false, error: e.message || '积木翻不出来', blocks: [] } }));
    }
  }

  const presetDel = useDoubleConfirm(async (id: string) => {
    if (hasBlockDrafts || blockSavingId) return;
    setPresetDeleteBusy(id);
    setPresetDeleteError((prev) => ({ ...prev, [id]: '' }));
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/desk/presets/${id}`, { method: 'DELETE' });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '删除失败(服务端没确认成功)');
      setPresets((prev) => prev.filter((p) => p.id !== id));
      setPresetBlocksCache((prev) => { const next = { ...prev }; delete next[id]; return next; });
      setPresetExpanded((prev) => { const next = { ...prev }; delete next[id]; return next; });
      onRegexChanged?.(); // 删包连坐删了它名下的内嵌正则,写作台下行/上行正则缓存要重拉
    } catch (e: any) {
      setPresetDeleteError((prev) => ({ ...prev, [id]: e.message || '删除失败' }));
    } finally {
      setPresetDeleteBusy(null);
    }
  });

  // 换配方=丢弃式离开的一种:dirty 时第一次选走→受控select自动弹回原值+亮红字提示,
  // 3.5s内再选同一个目标才真切(弹回后DOM值已复原,重选同目标会再次触发onChange,两段确认天然成立)。
  function requestSwitchRecipe(target: string) {
    // handler入口闸——recipeDeleting在飞时不许切配方(UI层disable见下方select),配方切换会
    // 连锁重跑loadBlocks拿新配方的基线,跟正在处理的删除结果掺在一起没有意义。
    if (recipeDeleting) return;
    if (target === recipeId) return;
    if ((dirty || hasBlockDrafts) && switchArm !== target) {
      setSwitchArm(target);
      if (switchTimer.current) clearTimeout(switchTimer.current);
      switchTimer.current = setTimeout(() => setSwitchArm(null), 3500);
      return;
    }
    if (switchTimer.current) clearTimeout(switchTimer.current);
    setSwitchArm(null);
    // 确认丢弃的瞬间当场处死旧草稿(同步清ref,不等镜像effect)——切过去的新配方必须吃干净基线
    dirtyRef.current = false;
    draftRecipeIdRef.current = '';
    setDirty(false);
    setBlockDrafts({});
    setRecipeId(target);
  }

  async function saveRecipe() {
    // handler入口闸——recipeDeleting在飞时不许保存(UI层disable见下方保存钮),这份配方眼看
    // 要被删,保存下去的PUT要么落进一个即将消失的行,要么撞上已经被删的行返回"配方不存在",
    // 两种结局都会跟"删除成功"的反馈互相打架。
    if (!recipeId || saving || recipeDeleting) return;
    setSaving(true); setSaveError('');
    const rev = editRevRef.current; // 提交前拍个快照,响应回来时核对还是不是"最新的那笔"
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const body: any = { overrides, weight };
      if (weight === 'light') body.light_system = lightSystem;
      const res = await fetch(`${base}/api/oc/desk/recipes/${recipeId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '保存失败(服务端没确认成功)');
      // rev 对得上才敢动任何状态——setRecipes 会连锁重跑 loadBlocks 把编辑器整片刷回提交时
      // 的旧值(一条曾经被绕过的锁路径),所以连"记录已存快照"这步也必须蹲在 rev 闸里;保存路上
      // 用户又改了(rev涨了)就什么都不动:dirty留true、✓不亮、recipes基线不刷,新草稿一个字不丢。
      if (rev === editRevRef.current) {
        setRecipes((prev) => prev.map((r) => (r.id === recipeId ? { ...r, overrides, weight, light_system: lightSystem } : r)));
        setDirty(false); setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e: any) { setSaveError(e.message || '保存失败'); }
    finally { setSaving(false); }
  }

  // 配方删除——后端 DELETE /api/oc/desk/recipes/:id 早就有,这里补前端接口。永远删的是
  // 当前选中的这一份(recipeId,BlocksTab本来就一次只编辑一份配方,没有别的地方能点别份配方的删)。
  // 删成功之后不手动摆弄 recipeId/recipes——只敲 nonce 触发 recipes 列表重拉(同 createRecipe 建好
  // 之后的手法),让【消失配方护稿扣留】那套决策逻辑(见上面 recipes 加载effect 里的
  // stillThere/holdVanished 判断)统一接管收尾:干净态自动切到剩余第一份或空态,若这份草稿恰好
  // 属于刚删掉的配方(dirty且draftRecipeIdRef指着它)就原地扣留不冲掉、亮同一句"服务端已经
  // 不存在了"提示——不为删除这个动作另外写一套选中态清理,两条路殊途同归,少一套逻辑就少一处能
  // 互相打架的地方。
  // 原先 recipeDeleting 只挡了删除钮自己一处,保存钮/配方切换/积木编辑区一概不受影响——同一份
  // 配方的PUT和DELETE能同时在飞,谁后到谁定局:保存刚报成功配方就被删除消失,或者保存在DELETE
  // 之后才落地却报"配方不存在"却让人误以为是别的原因保存失败,刚编辑的稿子可能已经丢了却还看着
  // 像存上了。修法照互斥矩阵家法(同 RegexTab.interactionsLocked 那套UI+handler双层闸):
  // saving↔recipeDeleting 互斥,谁在飞就冻结对方的入口,且必须开口说明(无声守卫=故障)——不
  // 冻结时机不对称是有意的:saving时本来就不锁编辑器(写作过程不想被半路冻住,靠rev闸兜底),
  // 这里额外只锁"删除"这一个不可逆动作;recipeDeleting时反过来——这份配方眼看要被删,继续
  // 编辑/保存/切走都没意义,索性把编辑区整个冻住,少一处能跟删除结果打架的动作。
  const [recipeDeleting, setRecipeDeleting] = useState(false);
  const [recipeDeleteError, setRecipeDeleteError] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState('');
  async function exportRecipe() {
    if (!recipeId || exportBusy || dirty || hasBlockDrafts) return;
    setExportBusy(true); setExportError('');
    try {
      const res = await fetch(`${base}/api/oc/desk/recipes/${recipeId}/export`);
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error || `导出失败 HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const recipe = recipes.find((r) => r.id === recipeId);
      const filename = `${(recipe?.name || 'recipe').replace(/[\\/:*?"<>|]/g, '_')}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) { setExportError(e.message || '导出失败'); }
    finally { setExportBusy(false); }
  }
  const recipeDel = useDoubleConfirm(async (id: string) => {
    // handler入口闸:saving在飞时不许删(UI层disable见下方删除钮)——双层闸的第二层,防disabled
    // 被绕过(键盘事件/极端时序)。
    if (saving || exportBusy || hasBlockDrafts) return;
    setRecipeDeleting(true); setRecipeDeleteError('');
    // 删除是definitive动作,清掉这份配方名下任何残留的保存反馈(旧的"已存✓"或旧的保存失败文案)
    // ——马上要么删成功(这份配方的保存反馈已经没意义)要么删失败(重新看清删除本身的错误,别跟
    // 陈旧的保存提示混在一起互相打架)。
    setSaveError(''); setSaved(false);
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/desk/recipes/${id}`, { method: 'DELETE' });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '删除失败(服务端没确认成功)');
      setNonce((n) => n + 1);
    } catch (e: any) {
      setRecipeDeleteError(e.message || '删除失败');
    } finally {
      setRecipeDeleting(false);
    }
  });

  if (loading) return <div style={{ fontSize: 13, color: 'var(--ink2)' }}>正在翻配方本…</div>;
  if (error) return <div style={{ fontSize: 13, color: errColor }}>翻不开：{error}</div>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        {recipes.length > 0 && !creating && (
          <select
            value={recipeId}
            onChange={(e) => requestSwitchRecipe(e.target.value)}
            disabled={recipeDeleting}
            style={{ ...inputStyle, width: 'auto', cursor: recipeDeleting ? 'default' : 'pointer', opacity: recipeDeleting ? 0.6 : 1 }}
          >
            {/* 配方全桌通用:列表现在混着所有项目的配方,老配方(project非空,历史痕迹)
                在下拉里带个项目名方便认出"这是哪个项目建的";新配方project=''不带这段,
                干干净净只有名字和轻重。 */}
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.name}（{r.weight === 'light' ? '轻' : '重'}{r.project ? `·${r.project}` : ''}）</option>)}
          </select>
        )}
        {switchArm && (
          <span style={{ fontSize: 12, color: '#c0573f' }}>当前配方有未保存草稿——再选同一个目标确认丢弃并切换</span>
        )}
        {/* recipeDeleting在飞时把这个改建配方入口也冻住——切进"新建"视图会把配方编辑器(连同
            正在处理的删除钮/反馈)整个从视图里藏起来,删除结果会看着像"无声消失了" */}
        <button onClick={() => !recipeDeleting && setCreating((c) => !c)} disabled={recipeDeleting} style={{ ...btnGhostStyle, opacity: recipeDeleting ? 0.6 : 1 }}>{creating ? '取消新建' : '+ 新建配方'}</button>
        {/* 删这份配方——永远删当前选中的那份,两段确认照家法用 useDoubleConfirm。
            saving在飞时也禁删除钮(UI层),handler入口闸见 recipeDel 定义处。 */}
        {recipes.length > 0 && !creating && !!recipeId && (
          <button onClick={exportRecipe} disabled={exportBusy || dirty || hasBlockDrafts || recipeDeleting} title={(dirty || hasBlockDrafts) ? '先保存所有修改再导出' : '导出为可从①号口重新导入的ST预设JSON'} style={{ ...btnGhostStyle, opacity: (exportBusy || dirty || hasBlockDrafts || recipeDeleting) ? 0.6 : 1 }}>
            {exportBusy ? '导出中…' : (dirty || hasBlockDrafts) ? '先保存再导出' : '导出配方包'}
          </button>
        )}
        {recipes.length > 0 && !creating && !!recipeId && (
          <button
            onClick={() => recipeDel.click(recipeId)}
            disabled={recipeDeleting || saving || exportBusy || hasBlockDrafts}
            style={{ ...btnGhostStyle, color: recipeDel.stage[recipeId] === 1 ? errColor : 'var(--ink-body)', opacity: (recipeDeleting || saving || exportBusy || hasBlockDrafts) ? 0.6 : 1 }}
          >
            {recipeDeleting ? '删除中…' : saving ? '保存中,不能删除' : exportBusy ? '导出中,不能删除' : hasBlockDrafts ? '先保存积木' : recipeDel.stage[recipeId] === 1 ? '真删这份配方？' : '删这份配方'}
          </button>
        )}
        {recipeDeleteError && <span style={{ fontSize: 12, color: errColor }}>{recipeDeleteError}</span>}
        {exportError && <span style={{ fontSize: 12, color: errColor }}>{exportError}</span>}
        {/* 无声守卫=故障:recipeDeleting在飞时明说编辑区被冻住,别让人以为积木编辑器坏了 */}
        {recipeDeleting && <span style={{ fontSize: 12, color: 'var(--ink2)' }}>正在删除这份配方,编辑暂时锁定…</span>}
      </div>

      {creating && (
        <div style={{ ...cardStyle, padding: '14px 16px', marginBottom: 18, background: 'var(--scale-0)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="配方名字" style={inputStyle} />
            {presetsLoading ? (
              <div style={{ fontSize: 12, color: 'var(--ink2)' }}>正在翻预设包…</div>
            ) : presetsError ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, color: errColor }}>预设包翻不出来：{presetsError}</div>
                <button onClick={loadPresets} style={{ ...btnGhostStyle, alignSelf: 'flex-start' }}>重试</button>
              </div>
            ) : presets.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--ink2)' }}>还没导过预设包——去「导入」标签先导一份</div>
            ) : (
              <select value={newPresetId} onChange={(e) => setNewPresetId(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                {presets.map((p) => <option key={p.id} value={p.id}>{p.name}（{p.block_count}块）</option>)}
              </select>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              {(['light', 'heavy'] as const).map((wt) => (
                <button key={wt} onClick={() => setNewWeight(wt)} style={{
                  flex: 1, fontSize: 12.5, padding: '7px 12px', borderRadius: 10, cursor: 'pointer',
                  background: newWeight === wt ? 'var(--scale-2)' : 'var(--card-bg)',
                  color: newWeight === wt ? 'var(--card-bg)' : 'var(--ink-body)',
                  border: newWeight === wt ? '1px solid transparent' : '1px solid var(--line-soft)',
                }}>{wt === 'light' ? '轻(1-2k薄system)' : '重(完整预设)'}</button>
              ))}
            </div>
            {createError && <div style={{ fontSize: 11.5, color: errColor }}>{createError}</div>}
            <button
              onClick={createRecipe}
              disabled={createBusy || !newName.trim() || !newPresetId || presetsLoading || !!presetsError}
              style={{ ...btnPrimaryStyle, opacity: (createBusy || !newName.trim() || !newPresetId || presetsLoading || !!presetsError) ? 0.5 : 1 }}
            >
              {createBusy ? '建配方中…' : presetsLoading ? '预设包加载中…' : presetsError ? '预设包不可用,建不了' : !newPresetId ? '没有可用预设包' : '建这份配方'}
            </button>
          </div>
        </div>
      )}

      {!creating && (recipes.length > 0 || (dirty && !!recipeId)) && (
        <>
          {/* 轻/重 + light_system。渲染门带上护稿扣留态:唯一配方被删+脏草稿时列表长度归零,
              只认 length>0 会把整个编辑区(草稿/警示/积木行)藏进虚空,没入口能抄走改动。 */}
          {/* recipeDeleting在飞时冻结轻/重切换——这份配方眼看要被删,editRevRef都不该再涨 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {(['light', 'heavy'] as const).map((wt) => (
              <button
                key={wt}
                onClick={() => { if (recipeDeleting) return; setWeight(wt); editRevRef.current += 1; setDirty(true); setSaved(false); }}
                disabled={recipeDeleting}
                style={{
                  flex: 1, fontSize: 12.5, padding: '7px 12px', borderRadius: 10, cursor: recipeDeleting ? 'default' : 'pointer',
                  opacity: recipeDeleting ? 0.6 : 1,
                  background: weight === wt ? 'var(--scale-2)' : 'var(--card-bg)',
                  color: weight === wt ? 'var(--card-bg)' : 'var(--ink-body)',
                  border: weight === wt ? '1px solid transparent' : '1px solid var(--line-soft)',
                }}>{wt === 'light' ? '轻' : '重'}</button>
            ))}
          </div>
          {weight === 'light' && (
            <textarea
              value={lightSystem}
              onChange={(e) => { if (recipeDeleting) return; setLightSystem(e.target.value); editRevRef.current += 1; setDirty(true); setSaved(false); }}
              disabled={recipeDeleting}
              placeholder="轻配方的 1-2k 薄 system(官端手感;这段文字就是唯一的system块,不装配队列)"
              style={{ ...inputStyle, minHeight: 100, resize: 'vertical', marginBottom: 16, lineHeight: 1.6, opacity: recipeDeleting ? 0.6 : 1 }}
            />
          )}

          {blocksLoading ? (
            <div style={{ fontSize: 13, color: 'var(--ink2)' }}>正在翻积木箱…</div>
          ) : blocksError ? (
            <div style={{ fontSize: 13, color: errColor }}>翻不开：{blocksError}</div>
          ) : weight === 'light' ? (
            <div style={{ fontSize: 12, color: 'var(--ink2)' }}>轻配方不装配积木队列,这里不用管~</div>
          ) : (
            <>
              {/* 队列常驻+仓库弹出(酒馆Prompt Manager同款交互)——"在库未上架"那一段
                  不再常驻平铺(条目多时一页太长),改成点「＋添加积木」才弹出仓库选择器挑。 */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink2)', letterSpacing: 1 }}>队列（{queueSection.length}）</div>
                <button onClick={openPicker} disabled={recipeDeleting} style={{ ...btnGhostStyle, fontSize: 11.5, padding: '5px 12px', opacity: recipeDeleting ? 0.6 : 1 }}>
                  ＋ 添加积木{librarySection.length > 0 ? `（库里还有${librarySection.length}块）` : ''}
                </button>
              </div>
              <div style={{ ...cardStyle, marginBottom: 16, overflow: 'hidden' }}>
                {queueSection.length === 0 ? (
                  <div style={{ padding: '14px 16px', fontSize: 12.5, color: 'var(--ink2)' }}>队列空的~点上面「＋添加积木」从库里挑几块上架</div>
                ) : queueSection.map((b, i) => {
                  const eff = effective(b);
                  const contentOpen = !!blockContentOpen[b.identifier];
                  return (
                    <div
                      key={b.identifier}
                      onDragOver={(e) => { if (!recipeDeleting) e.preventDefault(); }}
                      onDrop={(e) => { e.preventDefault(); if (recipeDeleting) return; reorderQueueDrag(e.dataTransfer.getData('text/plain'), b.identifier); }}
                      style={{ borderTop: i > 0 ? '1px dashed var(--dash-line)' : 'none' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
                        {/* ▲▼调序钮已删,拖拽(⠿手柄)是队列调序唯一手段。
                            recipeDeleting在飞时拖拽手柄也冻住(draggable={false}见上) */}
                        <span draggable={!recipeDeleting} onDragStart={(e) => { if (recipeDeleting) { e.preventDefault(); return; } e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', b.identifier); }} title="拖拽调序" style={{ cursor: recipeDeleting ? 'default' : 'grab', color: 'var(--ink2)', fontSize: 12, userSelect: 'none', lineHeight: 1, opacity: recipeDeleting ? 0.5 : 1 }}>⠿</span>
                        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => toggleBlockContent(b.identifier)}>
                          <div style={{ fontSize: 13, color: 'var(--ink-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {b.marker && <span title={STANDARD_SLOT_HINTS[b.identifier] || '预设保留积木'} style={{ ...badgeStyle, marginRight: 5 }}>{STANDARD_SLOT_HINTS[b.identifier] ? '装配槽' : '占位'}</span>}{b.name || b.identifier}
                          </div>
                          <div style={{ fontSize: 10.5, color: 'var(--ink2)' }}>{STANDARD_SLOT_HINTS[b.identifier] || `${b.role} · ${b.content_len}字`} · 点开看内容{contentOpen ? ' ▲' : ' ▼'}</div>
                        </div>
                        <Toggle checked={!!eff.enabled} onChange={() => toggleEnabled(b)} disabled={recipeDeleting} />
                      </div>
                      {contentOpen && (
                        <div style={{ padding: '0 14px 10px 44px' }}>
                          <textarea value={blockDraft(b)} onChange={(e) => setBlockDraftValue(b, e.target.value)} disabled={blockSavingId === b.id || recipeDeleting} style={{ ...inputStyle, minHeight: 180, resize: 'vertical', fontFamily: monoContentStyle.fontFamily, lineHeight: 1.6 }} />
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6, alignItems: 'center' }}>
                            {blockEditError[b.id] && <span style={{ fontSize: 11.5, color: errColor }}>{blockEditError[b.id]}</span>}
                            <button onClick={() => saveBlockContent(b)} disabled={blockSavingId !== null || recipeDeleting || blockDraft(b) === (b.content ?? b.content_preview)} style={{ ...btnPrimaryStyle, opacity: (blockSavingId !== null || recipeDeleting || blockDraft(b) === (b.content ?? b.content_preview)) ? 0.5 : 1 }}>{blockSavingId === b.id ? '保存中…' : '保存积木'}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

            </>
          )}

          {/* 仓库选择器——真正的弹层,盖住整个抽屉(z-40,高过 DeskDrawerHub 自己背板的
              z-30)。Escape/点外/✕都走 closePicker(见函数定义处的判断留观);选择器本身没有草稿,
              不用过 dirty 两段确认那套。 */}
          {pickerOpen && (
            <div className="fixed inset-0 z-40 flex items-center justify-center px-4" onClick={closePicker}>
              <div className="absolute inset-0" style={{ background: 'rgba(50,55,40,0.35)' }} />
              <div
                role="dialog" aria-modal="true" aria-label="添加积木"
                className="relative w-full flex flex-col overflow-hidden"
                style={{ maxWidth: 460, maxHeight: '78vh', background: 'var(--card-bg)', borderRadius: 18, boxShadow: '0 16px 40px var(--card-shadow2)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 10px', flex: '0 0 auto' }}>
                  <span className="serc" style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-deep)' }}>＋ 添加积木（在库未上架 {librarySection.length}）</span>
                  <button onClick={closePicker} className="serc" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: 'var(--ink2)', lineHeight: 1 }}>关闭</button>
                </div>
                <div style={{ padding: '0 18px 10px', flex: '0 0 auto' }}>
                  <input
                    value={pickerSearch}
                    onChange={(e) => setPickerSearch(e.target.value)}
                    placeholder="搜积木名字…"
                    style={inputStyle}
                    autoFocus
                  />
                </div>
                <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '0 10px 14px' }}>
                  {filteredLibrary.length === 0 ? (
                    <div style={{ padding: '14px 10px', fontSize: 12.5, color: 'var(--ink2)' }}>
                      {librarySection.length === 0 ? '库空了,全上架了~' : '没搜到~换个词试试'}
                    </div>
                  ) : filteredLibrary.map((b, i) => {
                    const contentOpen = !!blockContentOpen[b.identifier];
                    const anchor = pickerAnchorByBlock[b.identifier] || '';
                    return (
                      <div key={b.identifier} style={{ borderTop: i > 0 ? '1px dashed var(--dash-line)' : 'none', padding: '10px 8px' }}>
                        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => toggleBlockContent(b.identifier)}>
                          <div style={{ fontSize: 13, color: 'var(--ink-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {b.marker && <span title={STANDARD_SLOT_HINTS[b.identifier] || '预设保留积木'} style={{ ...badgeStyle, marginRight: 5 }}>{STANDARD_SLOT_HINTS[b.identifier] ? '装配槽' : '占位'}</span>}{b.name || b.identifier}
                          </div>
                          <div style={{ fontSize: 10.5, color: 'var(--ink2)' }}>{STANDARD_SLOT_HINTS[b.identifier] || `${b.role} · ${b.content_len}字`} · 点开看内容{contentOpen ? ' ▲' : ' ▼'}</div>
                        </div>
                        {contentOpen && (
                          <div style={{ marginTop: 6 }}>
                            <textarea value={blockDraft(b)} onChange={(e) => setBlockDraftValue(b, e.target.value)} disabled={blockSavingId === b.id || recipeDeleting} style={{ ...inputStyle, minHeight: 150, resize: 'vertical', fontFamily: monoContentStyle.fontFamily, lineHeight: 1.6 }} />
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}><button onClick={() => saveBlockContent(b)} disabled={blockSavingId !== null || recipeDeleting || blockDraft(b) === (b.content ?? b.content_preview)} style={{ ...btnPrimaryStyle, fontSize: 11.5, padding: '6px 12px', opacity: (blockSavingId !== null || recipeDeleting || blockDraft(b) === (b.content ?? b.content_preview)) ? 0.5 : 1 }}>{blockSavingId === b.id ? '保存中…' : '保存积木'}</button></div>
                            {blockEditError[b.id] && <div style={{ fontSize: 11.5, color: errColor, marginTop: 4 }}>{blockEditError[b.id]}</div>}
                          </div>
                        )}
                        {/* 插入位置:默认队尾,或从当前队列里选一块当锚点——"插在某块后面",
                            跟 insertIntoQueue 的 afterIdentifier 参数直接对应 */}
                        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                          <select
                            value={anchor}
                            onChange={(e) => setPickerAnchorByBlock((prev) => ({ ...prev, [b.identifier]: e.target.value }))}
                            disabled={recipeDeleting}
                            style={{ ...inputStyle, fontSize: 11.5, padding: '5px 8px', flex: 1, cursor: recipeDeleting ? 'default' : 'pointer' }}
                          >
                            <option value="">插到队尾</option>
                            {queueSection.map((q) => <option key={q.identifier} value={q.identifier}>插在「{q.name || q.identifier}」后面</option>)}
                          </select>
                          <button
                            onClick={() => insertIntoQueue(b, anchor || null)}
                            disabled={recipeDeleting}
                            style={{ ...btnPrimaryStyle, fontSize: 11.5, padding: '6px 14px', opacity: recipeDeleting ? 0.5 : 1, flexShrink: 0 }}
                          >
                            插入
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
            {saveError && <span style={{ fontSize: 12, color: errColor }}>{saveError}</span>}
            {saved && <span style={{ fontSize: 12, color: 'var(--accent)' }}>已存</span>}
            {/* recipeDeleting在飞时禁保存钮(这份配方正在被删,保存下去要么落进一个即将消失的行,
                要么撞上已经被删的行返回"配方不存在"——按钮文案明说原因,不做无声禁用) */}
            <button onClick={saveRecipe} disabled={!dirty || saving || recipeDeleting} style={{ ...btnPrimaryStyle, opacity: (!dirty || saving || recipeDeleting) ? 0.5 : 1 }}>
              {saving ? '保存中…' : recipeDeleting ? '删除中,不能保存' : '保存配方'}
            </button>
          </div>
        </>
      )}

      {/* 案3+案4:预设包管理区——跟上面的配方编辑器是两件事(管理"已经导进来的包" vs "怎么拼配方"),
          折起来不挤占配方编辑主流程,想看/删包时自己点开。不受 creating/recipes.length 状态
          影响,永远挂在最下面。 */}
      <div style={{ marginTop: 26, paddingTop: 18, borderTop: '1px dashed var(--dash-line)' }}>
        <button onClick={() => setShowPresetManager((v) => !v)} style={btnGhostStyle}>
          {showPresetManager ? '收起预设包管理 ▲' : '预设包管理（查看/删除已导入的包） ▼'}
        </button>
        {showPresetManager && (
          <div style={{ marginTop: 12 }}>
            {presetsLoading ? (
              <div style={{ fontSize: 12.5, color: 'var(--ink2)' }}>正在翻预设包…</div>
            ) : presetsError ? (
              <div style={{ fontSize: 12.5, color: errColor }}>翻不开：{presetsError}</div>
            ) : presets.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--ink2)' }}>还没导过预设包——去「导入」标签先导一份</div>
            ) : presets.map((p) => {
              const expanded = !!presetExpanded[p.id];
              const cache = presetBlocksCache[p.id];
              const delStage = presetDel.stage[p.id] || 0;
              return (
                <div key={p.id} style={{ ...cardStyle, marginBottom: 10, overflow: 'hidden' }}>
                  {/* 删除钮从"展开→拉到底"三层深处提到列表行上——一个入口就够,
                      展开详情区那个旧删除钮撤掉(见下方 expanded 块)。行上按钮要 stopPropagation,
                      不然点删除会连带触发行的 togglePresetExpand。 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }} onClick={() => togglePresetExpand(p.id)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: 'var(--ink-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--ink2)' }}>{p.block_count}块（{p.queue_count}上架/{p.library_count}在库）· 导入于 {p.created_at}</div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); presetDel.click(p.id); }}
                      disabled={presetDeleteBusy === p.id || hasBlockDrafts || blockSavingId !== null}
                      title={hasBlockDrafts ? '先保存积木草稿' : delStage === 1 ? '真删?(会带走这个包的积木+内嵌正则)' : '删这个包'}
                      style={{
                        background: 'none', border: 'none', cursor: (presetDeleteBusy === p.id || hasBlockDrafts || blockSavingId !== null) ? 'default' : 'pointer',
                        fontSize: delStage === 1 ? 11 : 15, padding: '4px 6px', flexShrink: 0, whiteSpace: 'nowrap',
                        color: delStage === 1 ? errColor : 'var(--ink2)', opacity: (presetDeleteBusy === p.id || hasBlockDrafts || blockSavingId !== null) ? 0.6 : 1, fontFamily: 'inherit',
                      }}
                    >
                      {presetDeleteBusy === p.id ? '删除中…' : delStage === 1 ? '真删?' : '删除'}
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--ink2)' }}>{expanded ? '▲' : '▼'}</span>
                  </div>
                  {/* 删除反馈挂在行下面,不管展不展开都看得到——删除现在是行级动作,不该被锁进展开态里 */}
                  {presetDeleteError[p.id] && <div style={{ padding: '0 14px 10px', fontSize: 11.5, color: errColor }}>{presetDeleteError[p.id]}</div>}
                  {expanded && (
                    <div style={{ padding: '0 14px 12px' }}>
                      {!cache || cache.loading ? (
                        <div style={{ fontSize: 12, color: 'var(--ink2)', padding: '6px 0' }}>正在翻积木箱…</div>
                      ) : cache.error ? (
                        <div style={{ fontSize: 12, color: errColor, padding: '6px 0' }}>翻不开：{cache.error}</div>
                      ) : (
                        <div style={{ borderTop: '1px dashed var(--dash-line)', marginTop: 4 }}>
                          {cache.blocks.map((b) => {
                            const key = `${p.id}:${b.identifier}`;
                            const blockOpen = !!presetBlockContentOpen[key];
                            return (
                              <div key={b.id} style={{ borderTop: '1px dashed var(--dash-line)', padding: '8px 0' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }} onClick={() => setPresetBlockContentOpen((prev) => ({ ...prev, [key]: !prev[key] }))}>
                                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--ink-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {b.marker && <span title={STANDARD_SLOT_HINTS[b.identifier] || '预设保留积木'} style={{ ...badgeStyle, marginRight: 5 }}>{STANDARD_SLOT_HINTS[b.identifier] ? '装配槽' : '占位'}</span>}{b.name || b.identifier}
                                  </span>
                                  <span style={badgeStyle}>{b.in_queue ? `队列#${b.queue_pos}` : '库'}</span>
                                  <span style={{ fontSize: 10.5, color: 'var(--ink2)', whiteSpace: 'nowrap' }}>{b.role} · {b.content_len}字</span>
                                </div>
                                {blockOpen && (
                                  <div style={{ marginTop: 6 }}>
                                    <textarea value={blockDraft(b)} onChange={(e) => setBlockDraftValue(b, e.target.value)} disabled={blockSavingId === b.id} style={{ ...inputStyle, minHeight: 150, resize: 'vertical', fontFamily: monoContentStyle.fontFamily, lineHeight: 1.6 }} />
                                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}><button onClick={() => saveBlockContent(b)} disabled={blockSavingId !== null || blockDraft(b) === (b.content ?? b.content_preview)} style={{ ...btnPrimaryStyle, fontSize: 11.5, padding: '6px 12px', opacity: (blockSavingId !== null || blockDraft(b) === (b.content ?? b.content_preview)) ? 0.5 : 1 }}>{blockSavingId === b.id ? '保存中…' : '保存积木'}</button></div>
                                    {blockEditError[b.id] && <div style={{ fontSize: 11.5, color: errColor, marginTop: 4 }}>{blockEditError[b.id]}</div>}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════ ② 世界书 ══════════════════════════════════════════
// 第二批:世界书条目 == 书架里 category='world' 的那一行(指针层已废除)。
// 放宽:闸门扩到 world+outline(大纲也能当卡喂进剧本),大纲行带「大纲」徽章认脸;
// plot/session 仍不进来。存量大纲默认空 keys+不常驻,不配触发词就不上桌。
// 随之下岗的三个东西,别再往回加:
//   ①「+ 手写条目」②「+ 从书架挑」——都是在造指针,现在没有指针可造了;新建设定的唯一入口是书架,
//     建完自动就是一张卡(category='world' 就是闸门),不用再挂一次。
//   ③ 每行的「删」——以前删卡只撕指针、书还在;现在一行就是一本书,删卡=删书。不可逆的降级不许
//     藏在一颗小钮后面:不想进剧本→关开关;真要删这本书→去书架删。
// 反过来放开了一样:**正文现在能在这儿改**——这行就是书架那一行,不存在"改到第二份"的风险。
// 「上一楼命中了谁」那一栏(顶部汇总条 + 每行徽章)加完就撤了:可以直接点透视看到,不必单独留一栏。
// 它本来是调触发词时的验证回路,但透视报告里一直就有 loreHits,浮窗再排一遍是同一份信息占两处地方。
// 数据通路(TypingDesk 那个倒着找最后一楼报告的 useMemo)一并拆掉,不留只为一个已撤 UI 服务的计算。
export function LoreTab({ base, envOk, project, onDirtyChange }: {
  base: string; envOk: boolean; project: string; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [lore, setLore] = useState<LoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // nonce 已随两个建卡入口一起下岗:列表只在挂载/切项目时拉一次,之后的变更
  // (翻开关、行内保存)都是就地打补丁(见 toggleEnabled / onSaved),没有"建完一条要整份重拉"这回事了。
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState('');

  // 同 BlocksTab——外层 key={project} 已经把跨项目切换的旧响应连着组件实例一起作废,这个
  // 令牌补的是同一挂载周期内(nonce 递增)重复加载互相踩踏的空隙。
  const loreSeqRef = useRef(0);

  // 世界书的真草稿原先一个都没报给外层抽屉壳,Escape/guardedClose 会把
  // 它们悄悄冲掉。判断留观拍板:行编辑器"只要开着就算脏",不细比对是否真改动过——更简单也更安全
  // (宁可少数情况误报"有草稿"多问一句,也不要因为比对漏了哪个字段而漏报丢字)。
  // 手写表单/书架挑表单两路草稿随那两个入口一起下岗,只剩行编辑器这一路。
  const [editingRowIds, setEditingRowIds] = useState<Set<string>>(new Set());
  const handleRowEditingChange = useCallback((id: string, editing: boolean) => {
    setEditingRowIds((prev) => {
      if (editing === prev.has(id)) return prev;
      const next = new Set(prev);
      if (editing) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const loreDirty = editingRowIds.size > 0;
  // 同 BlocksTab/CoreTab 的手法:卸载(切标签页/关抽屉,或整个 LoreTab 因 guardedClose 后
  // key={project} 变化而重挂载)时清 false——草稿本身也跟着这次卸载一起没了。
  useEffect(() => {
    onDirtyChange?.(loreDirty);
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loreDirty]);

  useEffect(() => {
    if (!envOk) { setError('环境变量没配好'); setLoading(false); return; }
    setLoading(true); setError('');
    const tok = ++loreSeqRef.current;
    (async () => {
      try {
        const res = await fetch(`${base}/api/oc/desk/lore?${new URLSearchParams({ project })}`);
        const d = await res.json().catch(() => null);
        if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '世界书翻不出来');
        if (tok !== loreSeqRef.current) return;
        setLore(Array.isArray(d.lore) ? d.lore : []);
      } catch (e: any) {
        if (tok !== loreSeqRef.current) return;
        setError(e.message || '世界书翻不出来'); setLore([]);
      } finally {
        if (tok === loreSeqRef.current) setLoading(false);
      }
    })();
  }, [base, envOk, project]);

  async function toggleEnabled(row: LoreRow) {
    setBusyId(row.id); setRowError('');
    try {
      const res = await fetch(`${base}/api/oc/desk/lore/${row.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !row.enabled }) });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '改不了(服务端没确认成功)');
      setLore((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled: !row.enabled } : r)));
    } catch (e: any) { setRowError(e.message || '改不了'); }
    finally { setBusyId(null); }
  }
  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--ink2)', marginBottom: 14, lineHeight: 1.7 }}>
        这里就是书架的「设定+大纲」——建新条目去书架建,建完自动出现在这儿(不用再挂一次)。
        不想让某条进剧本就关掉它的开关;要删整本去书架删。大纲条目默认没配触发词,想让它上桌就给它配 keys 或开常驻。
      </div>

      {rowError && <div style={{ fontSize: 12, color: errColor, marginBottom: 10 }}>{rowError}</div>}

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--ink2)' }}>正在翻世界书…</div>
      ) : error ? (
        <div style={{ fontSize: 13, color: errColor }}>翻不开：{error}</div>
      ) : lore.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--ink2)' }}>这个项目的书架上还没有「设定/大纲」~去书架建第一条</div>
      ) : (
        <div style={{ ...cardStyle, overflow: 'hidden' }}>
          {lore.map((row, i) => (
            <LoreRowView key={row.id} row={row} base={base} first={i === 0}
              busy={busyId === row.id} onToggle={() => toggleEnabled(row)}
              onSaved={(patch) => setLore((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...patch } : r)))}
              onEditingChange={handleRowEditingChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LoreRowView({ row, base, first, busy, onToggle, onSaved, onEditingChange }: {
  row: LoreRow; base: string; first: boolean; busy: boolean; onToggle: () => void;
  onSaved: (patch: Partial<LoreRow>) => void;
  onEditingChange?: (id: string, editing: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [keysDraft, setKeysDraft] = useState(row.keys.join('、'));
  const [contentDraft, setContentDraft] = useState(row.content);
  const [positionDraft, setPositionDraft] = useState(row.position);
  const [isCharDraft, setIsCharDraft] = useState(row.is_char);
  const [constantDraft, setConstantDraft] = useState(row.constant);
  const [presenceOnlyDraft, setPresenceOnlyDraft] = useState(row.trigger_mode === 'presence');
  const [fieldsDraft, setFieldsDraft] = useState<CharacterFields>(row.fields || {});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  // 把"这一行是不是正在编辑"报给 LoreTab(判断留观:开着编辑器就算脏,不比对是否真改了字段
  // ——见 LoreTab 头上那段长注释)。取消/保存成功都会把 editing 拨回 false,顺着这个 effect
  // 自动清位;整行被删除/整个标签页卸载时,cleanup 兜底清 false,不会有幽灵脏位残留。
  useEffect(() => {
    onEditingChange?.(row.id, editing);
    return () => onEditingChange?.(row.id, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, row.id]);

  // loadShelfPreview 已下岗:它是"指针行现读书架正本"那套的产物,列表接口现在
  // 直接把 content 带下来了,没有第二处可读。

  async function save() {
    if (saving) return;
    setSaving(true); setSaveErr('');
    const keys = keysDraft.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
    // trigger_mode 只对角色卡有意义:取消勾"是角色卡"时一并落回 scan,免得留下一张"非角色卡却
    // 标着只认在场名单"的行——那一列对普通世界书条目根本不看,存着只会误导下一个读库的人。
    const triggerMode: 'scan' | 'presence' = isCharDraft && presenceOnlyDraft ? 'presence' : 'scan';
    // 第二批:content 一起提交。以前这行只是指针、正文在书架,所以 PUT 拒绝碰 content;
    // 现在这行就是书架那一行,改正文和改触发词落的是同一条记录,没有第二份可以写歪。
    const body: any = { keys, content: contentDraft, position: positionDraft, is_char: isCharDraft, constant: constantDraft, fields: fieldsDraft, trigger_mode: triggerMode };
    try {
      const res = await fetch(`${base}/api/oc/desk/lore/${row.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '保存失败(服务端没确认成功)');
      onSaved({ keys, position: positionDraft, is_char: isCharDraft, constant: constantDraft, trigger_mode: triggerMode, fields: fieldsDraft, content: contentDraft });
      setEditing(false);
    } catch (e: any) { setSaveErr(e.message || '保存失败'); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ padding: '12px 16px', borderTop: first ? 'none' : '1px dashed var(--dash-line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setExpanded((v) => !v)}>
          <div style={{ fontSize: 13, color: 'var(--ink-body)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {row.is_char && <span style={badgeStyle}>角色</span>}
            {row.category === 'outline' && <span style={badgeStyle}>大纲</span>}
            {row.is_char && row.trigger_mode === 'presence' && <span style={badgeStyle}>只认在场</span>}
            {!row.is_char && row.constant && <span style={badgeStyle}>常驻</span>}
            <span style={{ opacity: row.enabled ? 1 : 0.45 }}>{row.name}</span>
            <span style={badgeStyle}>{row.position === 'before' ? '前置' : row.position === 'after' ? '后置' : '角色卡位'}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink2)', marginTop: 3 }}>{row.keys.length ? row.keys.join('、') : '（没有触发关键词)'}</div>
        </div>
        <Toggle checked={row.enabled} onChange={onToggle} disabled={busy} />
      </div>

      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--dash-line)' }}>
          {!editing ? (
            <>
              {/* 正文直接摆出来:这一行就是书架那一行,不再有"指针 vs 正本"的分身,也就没有
                  "预览是只读的"那句话要说了 */}
              <div style={{ fontSize: 12, color: 'var(--ink-body)', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto', lineHeight: 1.7 }}>{row.content || '（空)'}</div>
              <button onClick={() => { setEditing(true); setKeysDraft(row.keys.join('、')); setContentDraft(row.content); setPositionDraft(row.position); setIsCharDraft(row.is_char); setConstantDraft(row.constant); setPresenceOnlyDraft(row.trigger_mode === 'presence'); setFieldsDraft(row.fields || {}); }} style={{ ...btnGhostStyle, marginTop: 10 }}>编辑</button>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div style={fieldLabelStyle}>触发关键词<span style={{ marginLeft: 6, opacity: 0.8 }}>正文里出现这些词,这张卡才上场（跟书架的「标签」没有关系）</span></div>
                <input value={keysDraft} onChange={(e) => setKeysDraft(e.target.value)} placeholder="比如：裴瑾、瑾（顿号或逗号分隔）" style={inputStyle} />
              </div>
              <div>
                <div style={fieldLabelStyle}>正文<span style={{ marginLeft: 6, opacity: 0.8 }}>就是书架上这本书的正文,在这儿改=在书架改</span></div>
                <textarea value={contentDraft} onChange={(e) => setContentDraft(e.target.value)} style={{ ...inputStyle, minHeight: 120, resize: 'vertical', lineHeight: 1.7 }} />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ ...fieldLabelStyle, marginBottom: 0 }}>装在哪儿</span>
                <select value={positionDraft} onChange={(e) => setPositionDraft(e.target.value as any)} style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}>
                  <option value="before">前置</option>
                  <option value="after">后置</option>
                  <option value="char">角色卡位</option>
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink2)' }}>
                  <input type="checkbox" checked={isCharDraft} onChange={(e) => setIsCharDraft(e.target.checked)} /> 是角色卡
                </label>
                {!isCharDraft && <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink2)' }}><input type="checkbox" checked={constantDraft} onChange={(e) => setConstantDraft(e.target.checked)} /> 常驻（无需关键词）</label>}
                {isCharDraft && <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink2)' }}><input type="checkbox" checked={presenceOnlyDraft} onChange={(e) => setPresenceOnlyDraft(e.target.checked)} /> 只认状态板「在场角色」</label>}
              </div>
              {isCharDraft && presenceOnlyDraft && (
                <div style={{ fontSize: 11, color: 'var(--ink2)', lineHeight: 1.6 }}>
                  这张卡不再扫正文,只在状态板的「在场角色」里出现她时才上场。<b>单字名/容易撞词的名字用这个</b>——
                  中文没有词边界,「露」会被"暴露/露出"勾出来,「寻」会被"寻找/寻常"勾出来。
                </div>
              )}
              {isCharDraft && (
                <div style={{ borderTop: '1px dashed var(--dash-line)', paddingTop: 8 }}>
                  <button type="button" onClick={() => setShowAdvanced((v) => !v)} style={{ ...btnGhostStyle, fontSize: 11.5 }}>{showAdvanced ? '收起酒馆高级字段 ▲' : '酒馆高级字段（可选）▼'}</button>
                  {showAdvanced && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 8 }}>
                      <textarea value={fieldsDraft.description || ''} onChange={(e) => setFieldsDraft((p) => ({ ...p, description: e.target.value }))} placeholder="Description（留空则自动使用上面的完整正文）" style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} />
                      <textarea value={fieldsDraft.personality || ''} onChange={(e) => setFieldsDraft((p) => ({ ...p, personality: e.target.value }))} placeholder="Personality（可选）" style={{ ...inputStyle, minHeight: 58, resize: 'vertical' }} />
                      <textarea value={fieldsDraft.scenario || ''} onChange={(e) => setFieldsDraft((p) => ({ ...p, scenario: e.target.value }))} placeholder="Scenario（可选）" style={{ ...inputStyle, minHeight: 58, resize: 'vertical' }} />
                      <textarea value={fieldsDraft.mes_example || ''} onChange={(e) => setFieldsDraft((p) => ({ ...p, mes_example: e.target.value }))} placeholder="Example Messages（可选）" style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} />
                      <textarea value={fieldsDraft.main_prompt || ''} onChange={(e) => setFieldsDraft((p) => ({ ...p, main_prompt: e.target.value }))} placeholder="角色 Main Prompt 覆盖（预留）" style={{ ...inputStyle, minHeight: 58, resize: 'vertical' }} />
                      <textarea value={fieldsDraft.post_history_instructions || ''} onChange={(e) => setFieldsDraft((p) => ({ ...p, post_history_instructions: e.target.value }))} placeholder="角色 Post-History Instructions（预留）" style={{ ...inputStyle, minHeight: 58, resize: 'vertical' }} />
                    </div>
                  )}
                </div>
              )}
              {saveErr && <div style={{ fontSize: 11.5, color: errColor }}>{saveErr}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => setEditing(false)} disabled={saving} style={{ fontSize: 12, color: 'var(--ink2)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>取消</button>
                <button onClick={save} disabled={saving} style={{ ...btnPrimaryStyle, opacity: saving ? 0.6 : 1 }}>{saving ? '保存中…' : '保存'}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ManualLoreForm / ShelfPickForm 已整块拆除——它们是"造指针"时代的两个建卡入口,
// 合并之后世界书条目就是书架里 category='world' 的那一行,没有指针可造了。新建设定的唯一入口
// 是书架;后端 POST /api/oc/desk/lore 也已下岗(返回一句人话,不留 404)。不留死代码。

// ══════════════════════════════════════════ ③ 正则 ══════════════════════════════════════════
// 按来源分大节(全局一节+每个预设包一节),
// 节内左右并排「上行(节食)/下行(美化)」两小列(窄屏flexWrap自然堆叠)——旧版是"上行/下行两大列,
// 列内再按来源分组",同一个来源(比如果实)的上行组和下行组隔着老远的另一个来源(日月西)对不上,
// 现在按来源分节让同源的上下行紧挨着好对照。direction='both'的规则在上下两小列各出现一次、
// 共用同一个 sort_order——工单判断留观:一列拖会带动另一列的相对序,单人档可接受,不在UI里
// 解释这件事。
// ⚠️这里的"节"是 scope(+preset_id) 维度,direction(上行/下行两列)
// 只是展示时的过滤分类——同一个 scope+preset_id 节的正则,可能一部分只在上行列出现、一部分只在
// 下行列出现、一部分(direction='both')两列都出现。reorder端点的合同要求发"这个节在库的完整
// 新序",所以 RegexSection.rows 是这个节**不分方向的完整行集合**(不是某一小列能看到的子集),
// 拖拽时靠这份完整集合反查"这个节不看方向、只看来源"的整组新序——见下面 RegexTab.handleDrop。
type RegexSection = { key: string; label: string; scope: 'preset' | 'global'; presetId: string | null; rows: RegexRow[] };

// 案3:一次分组产出"每个来源的完整行集合"(不再分方向调用两次)——调用方自己按direction切上下行子集。
function groupRegexBySource(items: RegexRow[], presetOrder: string[], presetNames: Record<string, string>): RegexSection[] {
  const sections: RegexSection[] = [];
  const globalRows = items.filter((r) => r.scope === 'global');
  if (globalRows.length) sections.push({ key: 'global', label: '全局', scope: 'global', presetId: null, rows: globalRows });
  // presetOrder(GET /presets返回序,created_at DESC)之外的preset_id(理论上不该出现,兜底用)
  // 追加在后头,保证每个包只出一节标题,不漏行。
  const allPresetIds = Array.from(new Set(items.filter((r) => r.scope === 'preset').map((r) => r.preset_id || '')));
  const orderedIds = [...presetOrder, ...allPresetIds.filter((id) => !presetOrder.includes(id))];
  for (const pid of orderedIds) {
    if (!pid) continue;
    const presetRows = items.filter((r) => r.scope === 'preset' && r.preset_id === pid);
    if (presetRows.length) sections.push({ key: pid, label: presetNames[pid] || '（预设包）', scope: 'preset', presetId: pid, rows: presetRows });
  }
  return sections;
}

function RegexTab({ base, envOk, onRegexChanged }: { base: string; envOk: boolean; onRegexChanged?: () => void }) {
  const [rows, setRows] = useState<RegexRow[]>([]);
  const [presetNames, setPresetNames] = useState<Record<string, string>>({});
  const [presetOrder, setPresetOrder] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState('');
  // 坏行(invalid/unsafe)想重新启用时的 force 确认(不用双确认计时器——原因是主动阅读文案再点,
  // 用同款"再点一次"容易被当成手滑连点两下就点过去了,这里换成明说原因+独立"我知道了,启用"按钮)
  const [forceConfirmId, setForceConfirmId] = useState<string | null>(null);
  // 展开看find/replace/flags——一次只开一行,够用且状态简单
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  // 案3(R3):节标题栏「全开/全关」批量开关——bulkBusyKey记正在跑批量的节(section.key),非空时
  // 并入互斥闸(见下方interactionsLocked),同一时刻至多一个批量/单行/调序操作在飞,道理跟原有
  // 那套互斥矩阵一样:批量操作会连续发多条PUT,中途被单行开关/拖拽插一脚会读到不一致的中间态。
  const [bulkBusyKey, setBulkBusyKey] = useState<string | null>(null);
  // 批量操作的非错误提示(灰/强调色,不是errColor)——跟rowError(真错误,红色)分开,"已经全开了"
  // "N条坏行需单独确认"这类信息性收尾不该顶着错误红色吓人。
  const [bulkNote, setBulkNote] = useState('');
  // 调序在飞期间跟单行开关/删除互斥——两层闸:UI层disable按钮
  // (见下方Toggle/删除按钮/draggable),handler入口再挡一道,防止disabled被绕过(键盘事件/极端
  // 时序)。反向同理:某一行的开关/删除在飞(busyId非空)时不许发起新的拖拽落子——见 handleDrop。
  // ⚠️interactionsLocked 是从state(reorderBusy/busyId/
  // bulkBusyKey)算出来的,state更新是异步的——同一tick内快速连点两个入口(比如"全开"刚点完手
  // 立刻点"全关"),第二次调用读到的interactionsLocked可能还是上一次render的旧值(还没来得及
  // 变true),两次判断都放行,发出两组互相冲突的PUT序列,谁先谁后由网络时序决定,同一行可能被
  // 打成谁都没预期的终态。interactionsLocked(state)留着只管UI显示(disabled属性/文案),不再是
  // 真正挡并发的判据——真正的闸挪到下面 regexOpRef。
  const interactionsLocked = reorderBusy || busyId !== null || bulkBusyKey !== null;
  // 同步ref锁,照 TypingDesk.tsx recipeSwitchingRef 家法——JS单线程,"查ref+占ref"这两步之间
  // 不会被别的事件循环任务插进来,能真正做到"同一时刻至多一个正则变更操作在飞"。所有正则变更
  // 入口(单行apply/单行删除/拖拽落子handleDrop+reorderRows/批量bulkSetEnabled)统一在**任何
  // await之前**先查这个ref、查完立刻占上,对应的异步终点(各自的finally)释放。持锁方释放:
  // ref先解,state(setBusyId/setReorderBusy/setBulkBusyKey等)再同步,UI跟着解锁。
  const regexOpRef = useRef(false);
  // 挂载期令牌——RegexTab被切tab卸载(DeskDrawerHub的
  // {tab==='regex' && <RegexTab .../>}条件渲染,不是key remount,是整个组件真卸载)时,如果正
  // 批量循环跑到一半,循环体本身没有任何机制知道自己"已经没人要看这份state了",会继续对着
  // 一个已经不存在的组件实例发剩下的PUT——而且新开的RegexTab实例(切回来那次)的regexOpRef是
  // 全新的false,跟旧循环完全无关,互斥形同虚设。mountedRef在卸载effect里翻转成false,批量
  // 循环每次迭代前(以及每次await之后、touch state之前)都验一遍,失效就break——已经发出去的
  // 那个请求不追(不取消,让它自然落地或超时,只是不再据此setState),更不再发起下一条新请求。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // 重拉令牌——同 ShelfPickForm 的 searchSeqRef 同款手法,防"调序失败触发的重拉"跟"别的
  // 触发的重拉"互相踩踏,慢响应别覆盖后来者已经落地的状态。
  const loadSeqRef = useRef(0);

  // 抽成纯拉取函数(不碰state),mount初次加载和"调序失败后重拉权威状态"两处共用同一份逻辑——
  // 两处对"拉失败了怎么办"的处理不一样(mount失败=整个tab显示翻不开;调序失败后重拉再失败=
  // 报错横幅提示手动刷新,不能把已经在展示的表格炸成空白),所以这里只管拉数据、把结果原样
  // 交回调用方决定怎么落进state。
  const fetchRegexAndPresets = useCallback(async (): Promise<
    { ok: true; rows: RegexRow[]; presetNames: Record<string, string>; presetOrder: string[] } | { ok: false; error: string }
  > => {
    try {
      const [rRes, pRes] = await Promise.all([
        fetch(`${base}/api/oc/desk/regex`),
        fetch(`${base}/api/oc/desk/presets`),
      ]);
      const rD = await rRes.json().catch(() => null);
      if (!rRes.ok || !rD || rD.success !== true) throw new Error(rD?.error || '正则翻不出来');
      const nextRows: RegexRow[] = Array.isArray(rD.regex) ? rD.regex : [];
      const nextNames: Record<string, string> = {};
      const nextOrder: string[] = [];
      if (pRes.ok) {
        const pD = await pRes.json().catch(() => null);
        if (pD && pD.success === true) {
          (pD.presets || []).forEach((p: any) => { nextNames[p.id] = p.name; nextOrder.push(p.id); });
        }
      }
      return { ok: true, rows: nextRows, presetNames: nextNames, presetOrder: nextOrder };
    } catch (e: any) {
      return { ok: false, error: e.message || '正则翻不出来' };
    }
  }, [base]);

  const del = useDoubleConfirm(async (id: string) => {
    // handler入口闸——同步ref锁,任何await之前查+占,防同tick连点两个入口(比如删除和批量
    // 开关)都从旧的interactionsLocked state穿过去。
    if (regexOpRef.current) return;
    regexOpRef.current = true;
    setBusyId(id); setRowError('');
    try {
      const res = await fetch(`${base}/api/oc/desk/regex/${id}`, { method: 'DELETE' });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '删除失败(服务端没确认成功)');
      setRows((prev) => prev.filter((r) => r.id !== id));
      onRegexChanged?.(); // 删掉一条正则,写作台上/下行缓存都要重拉——不通知=开着的窗还在用被删的规则
    } catch (e: any) { setRowError(e.message || '删除失败'); }
    finally { regexOpRef.current = false; setBusyId(null); }
  });

  useEffect(() => {
    if (!envOk) { setError('环境变量没配好'); setLoading(false); return; }
    setLoading(true); setError('');
    const tok = ++loadSeqRef.current;
    (async () => {
      const r = await fetchRegexAndPresets();
      if (tok !== loadSeqRef.current) return; // 令牌过期:更新的一次加载已经在路上
      if (r.ok) {
        setRows(r.rows); setPresetNames(r.presetNames); setPresetOrder(r.presetOrder);
      } else {
        setError(r.error); setRows([]);
      }
      setLoading(false);
    })();
  }, [base, envOk, fetchRegexAndPresets]);

  async function apply(row: RegexRow, body: any) {
    // 同步ref锁,入口闸——道理同del,UI层disable(Toggle/按钮)是第二层,防御disabled被绕过。
    if (regexOpRef.current) return;
    regexOpRef.current = true;
    setBusyId(row.id); setRowError('');
    try {
      const res = await fetch(`${base}/api/oc/desk/regex/${row.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      // 案3修订记:这里是工单点名"已经分开处理"的特殊分支——requires_force 走 400 状态码(见
      // index.ts路由 r.success?200:...400),旧代码先 `if(!res.ok) throw` 会在读到 d.requires_force
      // 之前就把它扔成裸"HTTP 400",这个确认弹窗其实从没真正弹出来过。现在统一先读body,
      // requires_force判断必须排在任何"因为!res.ok/success!==true就扔错"的分支之前。
      if (!d || d.success !== true) {
        if (d?.requires_force) { setForceConfirmId(row.id); return; } // 不算失败横幅:这是"要你确认",不是出错
        throw new Error(d?.error || `HTTP ${res.status}`);
      }
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...body } : r)));
      setForceConfirmId(null);
      onRegexChanged?.(); // 通知写作台清下行正则缓存重拉
    } catch (e: any) { setRowError(e.message || '改不了'); }
    finally { regexOpRef.current = false; setBusyId(null); }
  }

  // 节标题栏「全开/全关」——批量PUT这个节(scope+preset_id维度,不分方向,
  // direction='both'的行只算一次)所有行的enabled。逐条PUT(不是Promise.all并发)+中途失败立刻
  // 停(不是"发完全部再汇总失败"),因为"停在哪条"这件事本身就是要点名的信息,并发发出去了就没有
  // "停"这个概念了,而且必须是串行的:上一条PUT成功已经落库,下一条PUT发之前没有必要抢跑。
  // invalid/unsafe坏行"全开"时直接跳过(它们启用需要force:true确认,批量硬闯只会撞回
  // requires_force,不是真失败,不该打断整批;这里在动手前就滤掉,不让它们进target列表)——
  // "全关"没有这层限制,禁用永远放行,坏行也一并清。
  async function bulkSetEnabled(section: RegexSection, enabled: boolean) {
    // 同步ref锁,入口闸——跟单行apply/del/拖拽落子共用同一把regexOpRef,同一时刻至多一个
    // 正则变更操作在飞,不靠interactionsLocked(state,异步)防连点。
    if (regexOpRef.current) return;
    regexOpRef.current = true;
    try {
      const badSkipped = enabled ? section.rows.filter((r) => r.invalid || r.unsafe) : [];
      const targets = section.rows.filter((r) => r.enabled !== enabled && !(enabled && (r.invalid || r.unsafe)));
      setRowError(''); setBulkNote('');
      if (targets.length === 0) {
        setBulkNote(badSkipped.length > 0
          ? `${section.label}：没有能批量${enabled ? '开' : '关'}的行——${badSkipped.length}条坏行需单独确认(展开该行,点"我知道了,启用")`
          : `${section.label}：已经全部是${enabled ? '开' : '关'}的状态了`);
        return;
      }
      setBulkBusyKey(section.key);
      let succeeded = 0;
      // 挂载期令牌——每次迭代动手前先验mountedRef,失效
      // (RegexTab被切tab卸载了)就break,不再发新的PUT;已经发出去的那一条(await还没落地)不
      // 追——落地之后同样要过一遍mountedRef才敢touch state,卸载后绝不setState(避免React
      // "在已卸载组件上调用setState"的警告/未定义行为)。中断原因记进循环外的interruptedByUnmount,
      // 供循环结束后统一判断要不要吐横幅——卸载之后当然不能再setRowError,这个变量纯粹留痕,
      // 不做展示用途。
      let interruptedByUnmount = false;
      let issued = 0; // 发出去过几发PUT——卸载中断时判断"有没有可能已经有变更落库"用
      for (const row of targets) {
        if (!mountedRef.current) { interruptedByUnmount = true; break; }
        try {
          issued++;
          const res = await fetch(`${base}/api/oc/desk/regex/${row.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
          const d = await res.json().catch(() => null);
          if (!mountedRef.current) { interruptedByUnmount = true; break; } // 请求飞行途中被卸载,响应回来也不许再setState
          if (!res.ok || !d || d.success !== true) throw new Error(d?.error || `HTTP ${res.status}`);
          setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
          succeeded++;
        } catch (e: any) {
          if (!mountedRef.current) { interruptedByUnmount = true; break; } // 卸载后的失败也不许再setState
          // 中途失败立刻停,不接着发剩下的——错误明说停在哪条+已经成功了几条,别让人以为
          // 要么全成要么全没动,批量中途半完成是真实可能发生的状态,必须说清楚不能无声吞掉。
          setRowError(`${section.label}批量${enabled ? '全开' : '全关'}在「${row.name || '(无名)'}」这条卡住(${e.message || '改不了'})——已经成功切了${succeeded}/${targets.length}条,停在这条没继续,剩下的请手动处理`);
          setBulkBusyKey(null);
          if (succeeded > 0) onRegexChanged?.(); // 哪怕只成功了一条也要通知重拉,别让写作台继续用旧规则
          return;
        }
      }
      if (interruptedByUnmount || !mountedRef.current) {
        // 卸载后不再碰任何RegexTab自身state——但缓存失效通知必须补上:onRegexChanged
        // 是父级(写作台)的回调,生命周期独立于本组件,卸载后调用安全。只要发出去过至少一发PUT,
        // 就可能已有变更落库(含break在验成功之前的那发),宁可多让写作台白重拉一次,也不许它
        // 继续拿旧enabled状态渲染——无声旧缓存比多余刷新贵得多。
        if (issued > 0) onRegexChanged?.();
        return;
      }
      setBulkBusyKey(null);
      setBulkNote(badSkipped.length > 0
        ? `${section.label}：${succeeded}条已${enabled ? '开' : '关'},另有${badSkipped.length}条坏行需单独确认,批量没碰它们`
        : `${section.label}：${succeeded}条已${enabled ? '全开' : '全关'}`);
      onRegexChanged?.();
    } finally {
      // 锁在这里统一释放——不管走的是哪条return分支(0目标/中途失败/卸载中断/正常跑完),
      // 都必须解锁,不然regexOpRef会卡死在true,后续任何正则操作(哪怕组件已经卸载重开新实例
      // 也没用,因为新实例的ref是全新的——真正怕的是"同一个还活着的实例往后再也点不动")永远进不来。
      regexOpRef.current = false;
    }
  }

  // HTML5拖拽调序——用户在某一小列(上行/下行)里拖的是 visibleRows(这一小列能看到的子集),
  // 但接口要求端点收到"这个节(scope+preset_id,不分方向)的完整新序"。取最简单的正确做法:
  // 先按拖拽结果算出可见子集的新序,再把它套回这个节的完整行列表——
  // 可见行按新序占用它们原来占的那些"槽位",不可见行(只属于另一小列的direction)原地不动、
  // 相对位置照旧穿插在可见行之间。这样发给后端的是货真价实的"整节新序",不是半个节。
  // 补充:visibleRows 从调用方(DirColumn)显式传入——section.rows 现在是"这个节不分
  // 方向的完整集合",不再等于某一小列能看到的东西,拖拽发生在哪一小列(上行/下行)由调用方
  // 告诉这个函数,这里不猜。
  function handleDrop(section: RegexSection, visibleRows: RegexRow[], draggedId: string, targetId: string) {
    // 同步ref锁入口闸——handleDrop本身是同步函数(拖放事件
    // 一次性触发),这里是"占锁"真正发生的地方;它衔接的 reorderRows 是异步终点,负责在自己的
    // finally里解锁(见下方)。某一行的开关/删除
    // 在飞时不许发起新的拖拽落子,现在靠同一把regexOpRef统一实现,不再单独判断busyId。
    if (regexOpRef.current || !draggedId || draggedId === targetId) return;
    const visibleIds = visibleRows.map((r) => r.id);
    const fromIdx = visibleIds.indexOf(draggedId);
    const toIdx = visibleIds.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const newVisibleIds = visibleIds.slice();
    newVisibleIds.splice(fromIdx, 1);
    newVisibleIds.splice(toIdx, 0, draggedId);

    // section.rows 就是"这个节scope+preset_id维度的完整行集合"(groupRegexBySource产出时已经
    // 按这个口径筛过),不用再从外层rows重新filter一遍——两者在同一次渲染里天然等价。
    const fullSectionRows = section.rows;
    const visibleIdSet = new Set(visibleIds);
    let vi = 0;
    const fullNewIds = fullSectionRows.map((r) => (visibleIdSet.has(r.id) ? newVisibleIds[vi++] : r.id));

    // 占锁——从这一刻起到 reorderRows 的 finally 释放为止,别的正则变更入口都进不来。放在真正
    // 会发出网络请求(reorderRows)之前、所有同步校验(上面几行的index检查)之后,校验没过就
    // 不该占锁挡住别人。
    regexOpRef.current = true;

    // 乐观更新:立即在本地把这个节重排,给拖拽即时反馈——但这只是UX手段,不是"真相来源"。
    // 万一调序请求最终失败,不能靠"这里拍的这张快照"去回滚,见下面
    // reorderRows 的失败分支注释。
    setRows((prev) => {
      const byId = new Map(prev.map((r) => [r.id, r] as const));
      const reorderedFullSection = fullNewIds.map((id) => byId.get(id)).filter((r): r is RegexRow => !!r);
      const fullSectionIdSet = new Set(fullNewIds);
      let si = 0;
      return prev.map((r) => (fullSectionIdSet.has(r.id) ? reorderedFullSection[si++] : r));
    });
    void reorderRows(fullNewIds, section.scope, section.presetId);
  }

  async function reorderRows(ids: string[], scope: 'preset' | 'global', presetId: string | null) {
    setReorderBusy(true); setRowError('');
    try {
      const body: any = { ids, scope };
      if (scope === 'preset') body.preset_id = presetId;
      const res = await fetch(`${base}/api/oc/desk/regex/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '调序失败(服务端没确认成功)');
      onRegexChanged?.();
    } catch (e: any) {
      // 失败不能拿"发请求前的整表快照"复原——调序在飞这段窗口里,
      // 虽然靠 interactionsLocked 双向互斥尽量掐掉了本标签页内的并发操作,但不能赌"这段时间
      // 窗口里服务端状态绝对没被别处改过"(另一个标签页/多端);拿旧快照复活会把服务端已经
      // 生效的改动(比如已经成功的删除/开关)在UI上撤销回去,之后的操作会建立在假状态上。
      // 唯一安全的做法:不管乐观更新落到什么样子,一律拿服务端权威状态重新覆盖。重拉本身若
      // 也失败,不无声吞掉——报错横幅点名"重拉也失败了,这份列表可能是旧的",提示手动刷新。
      const reload = await fetchRegexAndPresets();
      if (reload.ok) {
        setRows(reload.rows); setPresetNames(reload.presetNames); setPresetOrder(reload.presetOrder);
        setRowError(`${e.message || '调序失败'}——调序没保存成功,已经从服务端重新拉了一份最新状态`);
      } else {
        setRowError(`${e.message || '调序失败'}——调序没保存成功,重新拉取也失败了(${reload.error}),眼前这份列表可能不是最新的,麻烦手动刷新一下`);
      }
    } finally {
      setReorderBusy(false);
      regexOpRef.current = false; // reorderRows是handleDrop占锁之后的异步终点,在这里统一解锁
    }
  }

  function RegexRowView({ row, section, visibleRows, first }: { row: RegexRow; section: RegexSection; visibleRows: RegexRow[]; first: boolean }) {
    const bad = row.invalid || row.unsafe;
    const isOpen = expandedId === row.id;
    const delStage = del.stage[row.id] || 0;
    // draggable本身也锁——interactionsLocked=true时整行不可拖(浏览器根本不会发起拖拽手势,
    // onDragStart不会触发);onDragStart/onDrop里各自再补一道入口闸,双层闸家法照旧,防
    // draggable被绕过(极端时序/未来改动漏改这一处)。onDragOver只有在解锁时才preventDefault
    // (那才是HTML5允许drop发生的信号),锁着的时候这一行连"接收拖放"的资格都没有。
    return (
      <div
        draggable={!interactionsLocked}
        onDragStart={(e) => {
          if (interactionsLocked) { e.preventDefault(); return; }
          e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', row.id);
        }}
        onDragOver={(e) => { if (!interactionsLocked) e.preventDefault(); }}
        onDrop={(e) => {
          e.preventDefault();
          if (interactionsLocked) return;
          handleDrop(section, visibleRows, e.dataTransfer.getData('text/plain'), row.id);
        }}
        style={{ padding: '10px 14px', borderTop: first ? 'none' : '1px dashed var(--dash-line)', opacity: reorderBusy ? 0.6 : 1 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span title="拖拽调序" style={{ cursor: interactionsLocked ? 'default' : 'grab', color: 'var(--ink2)', fontSize: 12, userSelect: 'none' }}>⠿</span>
          <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setExpandedId(isOpen ? null : row.id)}>
            <div style={{ fontSize: 12.5, color: 'var(--ink-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.name || '（无名)'}</div>
            <div style={{ display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap' }}>
              <span style={badgeStyle}>{row.direction === 'up' ? '上行' : row.direction === 'down' ? '下行' : '上下都'}</span>
            </div>
          </div>
          {/* 案3追记:disabled改用完整interactionsLocked(原来只查busyId===row.id||reorderBusy)——
              批量开关是逐条串行PUT,如果这条还没轮到批量处理时,有人手动点了这个Toggle,批量循环
              后面轮到它会用批量的目标值把手动改动覆盖掉,是批量操作专门带来的新竞态,原来"只锁自己
              这一行"的宽松策略在批量场景下不够,顺带把这个缺口一起收紧。 */}
          <Toggle checked={row.enabled} disabled={interactionsLocked} onChange={(v) => apply(row, { enabled: v })} />
          <button onClick={() => del.click(row.id)} disabled={interactionsLocked} style={{ fontSize: 11, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', color: delStage === 1 ? errColor : 'var(--ink2)' }}>
            {delStage === 1 ? '真删?' : '删'}
          </button>
        </div>
        {bad && (
          <div style={{ fontSize: 11, color: errColor, marginTop: 6 }}>
            {row.invalid ? '编译不过' : '疑似灾难性回溯'}：{row.invalid_reason || '原因未知'}
            {forceConfirmId === row.id && (
              <div style={{ marginTop: 6 }}>
                <button onClick={() => apply(row, { enabled: true, force: true })} disabled={interactionsLocked} style={{ ...btnGhostStyle, fontSize: 11, marginRight: 8, opacity: interactionsLocked ? 0.5 : 1 }}>我知道了,启用</button>
                <button onClick={() => setForceConfirmId(null)} style={{ fontSize: 11, color: 'var(--ink2)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>算了</button>
              </div>
            )}
          </div>
        )}
        {isOpen && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* 正则输入永远当不可信文本展示(家规)——纯文本渲染,不用 dangerouslySetInnerHTML */}
            <div>
              <div style={{ fontSize: 10, color: 'var(--ink2)', marginBottom: 2 }}>find</div>
              <pre style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 100, overflowY: 'auto', background: 'var(--scale-0)', borderRadius: 8, padding: '6px 8px', margin: 0, color: 'var(--ink-body)' }}>{row.find || '（空)'}</pre>
            </div>
            <div>
              <div style={{ fontSize: 10, color: 'var(--ink2)', marginBottom: 2 }}>replace</div>
              <pre style={{ fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 100, overflowY: 'auto', background: 'var(--scale-0)', borderRadius: 8, padding: '6px 8px', margin: 0, color: 'var(--ink-body)' }}>{row.replace || '（空)'}</pre>
            </div>
            <div style={{ fontSize: 11, color: 'var(--ink2)' }}>flags：{row.flags || '（无)'}</div>
          </div>
        )}
      </div>
    );
  }

  // 案3(R3):节内的一小列(上行或下行)——只渲染,不关心自己是哪个方向,调用方传什么rows就渲什么。
  function DirColumn({ label, section, dirRows }: { label: string; section: RegexSection; dirRows: RegexRow[] }) {
    return (
      <div style={{ flex: '1 1 260px', minWidth: 240 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink2)', marginBottom: 6 }}>{label}（{dirRows.length}）</div>
        {dirRows.length === 0 ? (
          <div style={{ ...cardStyle, padding: '12px 14px', fontSize: 12, color: 'var(--ink2)' }}>没有~</div>
        ) : (
          <div style={{ ...cardStyle, overflow: 'hidden' }}>
            {dirRows.map((r, i) => <RegexRowView key={r.id} row={r} section={section} visibleRows={dirRows} first={i === 0} />)}
          </div>
        )}
      </div>
    );
  }

  if (loading) return <div style={{ fontSize: 13, color: 'var(--ink2)' }}>正在翻正则本…</div>;
  if (error) return <div style={{ fontSize: 13, color: errColor }}>翻不开：{error}</div>;

  // 一次分组产出"每个来源的完整节"(不再分方向调用两次groupRegexBySource),
  // 节内上下行两小列并排渲染,同源的上下行紧挨着方便对照。
  const sections = groupRegexBySource(rows, presetOrder, presetNames);

  return (
    <div>
      {rowError && <div style={{ fontSize: 12, color: errColor, marginBottom: 10 }}>{rowError}</div>}
      {bulkNote && <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 10 }}>{bulkNote}</div>}
      {sections.length === 0 ? (
        <div style={{ ...cardStyle, padding: '14px 16px', fontSize: 12.5, color: 'var(--ink2)' }}>还没有正则~去「导入」页导一份预设或正则合集</div>
      ) : sections.map((section) => {
        // 按包收纳:每包两段——在岗(enabled=1)直接平铺,已禁用折叠进
        // <details> 默认收起。上下行并排的能力放组内(在岗段/已禁用段各自都有自己的上下行两列),
        // 节标题栏的全开/全关、批量互斥闸(interactionsLocked/regexOpRef)一概不变,还是打在
        // section.rows(不分方向也不分在岗/已禁用的完整集合)上。
        const enabledRows = section.rows.filter((r) => r.enabled);
        const disabledRows = section.rows.filter((r) => !r.enabled);
        const enabledUp = enabledRows.filter((r) => r.direction === 'up' || r.direction === 'both');
        const enabledDown = enabledRows.filter((r) => r.direction === 'down' || r.direction === 'both');
        const disabledUp = disabledRows.filter((r) => r.direction === 'up' || r.direction === 'both');
        const disabledDown = disabledRows.filter((r) => r.direction === 'down' || r.direction === 'both');
        const sectionBulkBusy = bulkBusyKey === section.key;
        return (
          <div key={section.key} style={{ marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <span className="serc" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink-deep)' }}>{section.label}</span>
              <span style={badgeStyle}>{section.rows.length}条</span>
              {/* 案3:节标题栏批量开关——目标=这个节的完整行集合(不分方向,'both'的行只算一次)。
                  disabled用interactionsLocked:任意时刻至多一个批量/单行/调序操作在飞。 */}
              <button
                onClick={() => bulkSetEnabled(section, true)}
                disabled={interactionsLocked}
                style={{ ...btnGhostStyle, fontSize: 11, padding: '4px 10px', opacity: interactionsLocked ? 0.5 : 1 }}
              >
                {sectionBulkBusy ? '处理中…' : '全开'}
              </button>
              <button
                onClick={() => bulkSetEnabled(section, false)}
                disabled={interactionsLocked}
                style={{ ...btnGhostStyle, fontSize: 11, padding: '4px 10px', opacity: interactionsLocked ? 0.5 : 1 }}
              >
                {sectionBulkBusy ? '处理中…' : '全关'}
              </button>
            </div>
            {enabledRows.length === 0 ? (
              <div style={{ ...cardStyle, padding: '12px 14px', fontSize: 12, color: 'var(--ink2)' }}>没有在岗的规则~</div>
            ) : (
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <DirColumn label="上行(节食)" section={section} dirRows={enabledUp} />
                <DirColumn label="下行(美化)" section={section} dirRows={enabledDown} />
              </div>
            )}
            {disabledRows.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary className="serc" style={{ fontSize: 11.5, color: 'var(--ink2)', cursor: 'pointer', userSelect: 'none', listStyle: 'none' }}>
                  {section.label} · 已禁用 {disabledRows.length} 条
                </summary>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
                  <DirColumn label="上行(节食)" section={section} dirRows={disabledUp} />
                  <DirColumn label="下行(美化)" section={section} dirRows={disabledDown} />
                </div>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════ ④ 核心记忆 ══════════════════════════════════════════
// 核心记忆从文具盒抬进世界书浮窗置顶——这是故事的大体背景,必须常驻可见。
// ⚠️数据仍留在 oc_state 的 desk_core:<项目>,**没有并进 memories**——它在剧本里的位置是故事水流
// 最前,普通世界书条目在 system 稳定前缀里,位置不同,硬合会改变剧本结构。挪的只是编辑入口。
export function CoreTab({ base, envOk, project, onDirtyChange }: { base: string; envOk: boolean; project: string; onDirtyChange?: (dirty: boolean) => void }) {
  const [blocks, setBlocks] = useState<CoreBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  // 未存草稿标记——加/删/改一块就脏,保存成功或重新加载(拿到服务端现状)就干净;报给外层
  // 抽屉壳做 Escape 关闭判断(见 DeskDrawerHub 头部注释)。
  const [dirty, setDirty] = useState(false);
  // F5(修订号闸门,同 BlocksTab.saveRecipe):加/删/改一块都敲这根计数器,保存提交前拍快照,
  // 响应回来只有 rev 没被后续编辑超车才敢清 dirty——理由和取舍见 BlocksTab 顶上那段长注释。
  const editRevRef = useRef(0);
  // 同 BlocksTab/LoreTab——外层 key={project} 兜底跨项目场景,这个令牌管同一挂载周期内的
  // 重复加载(目前只在 mount 时拉一次,留着是防将来加"重新加载"按钮时忘补)。
  const coreSeqRef = useRef(0);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  useEffect(() => {
    if (!envOk) { setError('环境变量没配好'); setLoading(false); return; }
    setLoading(true); setError('');
    const tok = ++coreSeqRef.current;
    (async () => {
      try {
        const res = await fetch(`${base}/api/oc/desk/core?${new URLSearchParams({ project })}`);
        const d = await res.json().catch(() => null);
        if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '核心记忆翻不出来');
        if (tok !== coreSeqRef.current) return;
        setBlocks(Array.isArray(d.blocks) ? d.blocks : []);
        setDirty(false);
      } catch (e: any) {
        if (tok !== coreSeqRef.current) return;
        setError(e.message || '核心记忆翻不出来'); setBlocks([]);
      } finally {
        if (tok === coreSeqRef.current) setLoading(false);
      }
    })();
  }, [base, envOk, project]);

  function updateBlock(i: number, patch: Partial<CoreBlock>) {
    setBlocks((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
    editRevRef.current += 1; setSaved(false); setDirty(true);
  }
  function addBlock() { setBlocks((prev) => [...prev, { title: '', text: '' }]); editRevRef.current += 1; setSaved(false); setDirty(true); }
  function removeBlock(i: number) { setBlocks((prev) => prev.filter((_, idx) => idx !== i)); editRevRef.current += 1; setSaved(false); setDirty(true); }

  async function save() {
    if (saving) return;
    setSaving(true); setSaveError('');
    const rev = editRevRef.current; // 提交前拍快照
    try {
      const res = await fetch(`${base}/api/oc/desk/core`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, blocks }) });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '保存失败(服务端没确认成功)');
      // rev 对不上=保存路上又有新改动,dirty 留 true,"已存 ✓"也不亮(见 BlocksTab 同款注释)
      if (rev === editRevRef.current) {
        setSaved(true); setDirty(false);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (e: any) { setSaveError(e.message || '保存失败'); }
    finally { setSaving(false); }
  }

  if (loading) return <div style={{ fontSize: 13, color: 'var(--ink2)' }}>正在翻核心记忆…</div>;
  if (error) return <div style={{ fontSize: 13, color: errColor }}>翻不开：{error}</div>;

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 14 }}>
        手写的全局梗概,装配时排在最前面(积木之后、往事区之前)——分几块随意,标题给自己看的。
      </div>
      {blocks.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--ink2)', marginBottom: 14 }}>还没写过~点下面「+ 加一块」开始</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {blocks.map((b, i) => (
          <div key={i} style={{ ...cardStyle, padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <input value={b.title} onChange={(e) => updateBlock(i, { title: e.target.value })} placeholder="这块的标题(给自己看的)" style={{ ...inputStyle, flex: 1 }} />
              <button onClick={() => removeBlock(i)} style={{ fontSize: 11, color: 'var(--ink2)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>删这块</button>
            </div>
            <textarea value={b.text} onChange={(e) => updateBlock(i, { text: e.target.value })} placeholder="正文" style={{ ...inputStyle, minHeight: 100, resize: 'vertical', lineHeight: 1.7 }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <button onClick={addBlock} style={btnGhostStyle}>+ 加一块</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {saveError && <span style={{ fontSize: 12, color: errColor }}>{saveError}</span>}
          {saved && <span style={{ fontSize: 12, color: 'var(--accent)' }}>已存</span>}
          <button onClick={save} disabled={saving} style={{ ...btnPrimaryStyle, opacity: saving ? 0.6 : 1 }}>{saving ? '保存中…' : '保存全部'}</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════ ⑤ 导入 ══════════════════════════════════════════
function ImportPicker({ label, hint, onImport, successHint, extraControl }: {
  label: string; hint: string; onImport: (json: any, filename: string) => Promise<any>;
  successHint?: string | ((receipt: any) => string);
  // 案2(R3):第④口"挂到哪"下拉——ImportPicker本身是通用文件选择器,不该为了这一个专属控件
  // 污染它的通用形状,改成一个可选插槽,渲在hint和文件输入框之间,调用方决定放不放/放什么。
  // 插槽改成busy的函数——busy之前只管文件输入框自己的
  // disabled,没传给extraControl,门④的"挂到哪"下拉导入中还能改,界面显示的选项跟这次已经
  // 提交的目标对不上(视觉上暗示"我还能改主意",其实这趟请求已经带着旧目标飞出去了)。调用方
  // 拿到busy自己决定要不要disable它渲的东西。
  extraControl?: (busy: boolean) => React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // 同名文件也能再选一次
    setBusy(true); setError(''); setReceipt(null);
    try {
      const text = await file.text();
      let json: any;
      try { json = JSON.parse(text); } catch { throw new Error('不是合法的 JSON 文件'); }
      const r = await onImport(json, file.name.replace(/\.json$/i, ''));
      setReceipt(r);
    } catch (e: any) { setError(e.message || '导入失败'); }
    finally { setBusy(false); }
  }

  const resolvedSuccessHint = typeof successHint === 'function' ? (receipt ? successHint(receipt) : '') : successHint;

  return (
    <div style={{ ...cardStyle, padding: '16px 18px', marginBottom: 16 }}>
      <div style={{ fontSize: 14, color: 'var(--ink-deep)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink2)', marginBottom: 12 }}>{hint}</div>
      {extraControl?.(busy)}
      <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFile} disabled={busy}
        style={{ fontSize: 12, color: 'var(--ink-body)' }} />
      {busy && <div style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 8 }}>导入处理中…</div>}
      {error && <div style={{ fontSize: 12, color: errColor, marginTop: 8 }}>{error}</div>}
      {receipt && (
        <div style={{ marginTop: 10, background: 'var(--scale-0)', borderRadius: 10, padding: '10px 12px' }}>
          {/* 导入其实成功但收据只有裸键值,容易误以为没导入——顶上加醒目横幅+(预设口专属)指路,
              别让"成功"这件事全靠自己认字典式的键值行。 */}
          <div style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600, marginBottom: resolvedSuccessHint ? 4 : 8 }}>导入成功</div>
          {resolvedSuccessHint && <div style={{ fontSize: 11.5, color: 'var(--accent)', marginBottom: 8 }}>{resolvedSuccessHint}</div>}
          <div style={{ fontSize: 11.5, color: 'var(--ink-body)', lineHeight: 1.8 }}>
            {Object.entries(receipt).filter(([k]) => k !== 'success').map(([k, v]) => (
              <div key={k}>{k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// 角色卡口的文件体量上限(codex 终审 #F3):.json/.png 两条路共用——挑这两个数字是给"正常大小的
// 角色卡/世界书"留足空间,同时不让一个畸形/恶意文件在浏览器里吃光内存或空转半天。
const IMPORT_FILE_MAX_BYTES = 16 * 1024 * 1024; // 整份文件(.json 或 .png)上限
const TARGET_TEXT_CHUNK_MAX_BYTES = 8 * 1024 * 1024; // ccv3/chara 这个 tEXt 块自己的声明长度上限

// 角色卡口专属:.json 走老路(读文本 JSON.parse),.png 得先从图里挑出内嵌的角色卡数据。
// 两个都是纯函数,不碰 React,方便单独测(万一以后要补前端测试)——跟 ImportPicker 里 onFile
// 内联的 JSON.parse 分开写,是因为角色卡口一个 onChange 里要按扩展名分两条路,合到一起
// 会把 ImportPicker 原本"永远是文本JSON"的假设污染掉。
async function readJsonFile(file: File): Promise<any> {
  if (file.size > IMPORT_FILE_MAX_BYTES) throw new Error('文件过大(超过 16MB)');
  const text = await file.text();
  try { return JSON.parse(text); } catch { throw new Error('不是合法的 JSON 文件'); }
}

// SillyTavern 把角色卡塞进 PNG 的 tEXt chunk 里:V3 卡额外带一个 keyword='ccv3' 的块(整卡
// base64 之后当文本值),V2 卡是 keyword='chara' 的块(同样 base64)。手搓扫 chunk,不引第三方
// PNG 库——PNG chunk 结构很薄(4字节长度+4字节类型+数据+4字节CRC),没必要为这一件事加依赖。
// 全程按字节(Uint8Array/DataView)操作,不裸 slice 字符串,不会有切开代理对那档事。
async function extractCharacterCardFromPng(file: File): Promise<any> {
  if (file.size > IMPORT_FILE_MAX_BYTES) throw new Error('文件过大(超过 16MB)');
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) throw new Error('不是合法的 PNG 文件(文件头对不上)');
  }
  const view = new DataView(buf);
  let offset = 8;
  const texts: Record<string, string> = {};
  let sawIend = false;
  // chunk 结构一旦读不下去(声明长度越过文件尾、循环耗尽字节都没见到 IEND)不再静默 break——
  // codex 终审 #F3 点名:悄悄 break 会把"文件被截断"和"这张卡确实没有 ccv3/chara 块"混成同一种
  // 沉默失败,一律当畸形 PNG 硬错误拒绝整个文件,不猜它"读到哪算哪"还能不能用。
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error('不是合法的 PNG 文件(chunk 结构被截断)');
    if (type === 'tEXt') {
      const chunk = bytes.subarray(dataStart, dataEnd);
      const nullIdx = chunk.indexOf(0); // tEXt = keyword + \0 + text
      if (nullIdx > 0) {
        const keyword = new TextDecoder().decode(chunk.subarray(0, nullIdx));
        if ((keyword === 'ccv3' || keyword === 'chara') && length > TARGET_TEXT_CHUNK_MAX_BYTES) {
          throw new Error(`${keyword} 块过大(超过 8MB),文件可能已损坏或被篡改`);
        }
        const text = new TextDecoder().decode(chunk.subarray(nullIdx + 1));
        if (!(keyword in texts)) texts[keyword] = text; // 同关键字重复出现只认第一个
      }
    }
    offset = dataEnd + 4; // 跳过 4 字节 CRC
    if (type === 'IEND') { sawIend = true; break; }
  }
  if (!sawIend) throw new Error('不是合法的 PNG 文件(缺少 IEND 块)');

  const decodeBase64Json = (label: string, b64: string): any => {
    let binary: string;
    try { binary = atob(b64.trim()); } catch { throw new Error(`${label} 块里的数据不是合法的 base64`); }
    const raw = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(raw); } catch { throw new Error(`${label} 块解出来的文本不是合法的 UTF-8`); }
    try { return JSON.parse(text); } catch { throw new Error(`${label} 块解出来的不是合法的 JSON`); }
  };

  // 优先 V3(ccv3),没有再退 V2(chara)——跟 SillyTavern 自己读卡的优先级一致
  if (texts.ccv3) return decodeBase64Json('ccv3', texts.ccv3);
  if (texts.chara) return decodeBase64Json('chara', texts.chara);
  throw new Error('这张 PNG 里没找到内嵌的角色卡数据(ccv3/chara 两个 tEXt 块都没有)');
}

// 跟 ImportPicker 长得像但不复用它:①文件处理要按扩展名分叉(.json/.png两条路,ImportPicker
// 的 onFile 假定永远是文本JSON)②收据展示比其余四口多两截——开场白/备选开场白只回吐给前端看
// 不落库,这里给"复制"按钮方便部署者手抄到别处用。
function CharacterCardImportPicker({ project, postImport }: {
  project: string;
  postImport: (path: string, body: any) => Promise<any>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<any>(null);
  const [copiedKey, setCopiedKey] = useState('');

  function copy(key: string, text: string) {
    navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? '' : k)), 1500);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // 同名文件也能再选一次
    setBusy(true); setError(''); setReceipt(null);
    try {
      const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
      const card = isPng ? await extractCharacterCardFromPng(file) : await readJsonFile(file);
      const r = await postImport('/api/oc/desk/import/card', { card, project });
      setReceipt(r);
    } catch (e: any) {
      setError(e.message || '导入失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ ...cardStyle, padding: '16px 18px', marginBottom: 16 }}>
      <div style={{ fontSize: 14, color: 'var(--ink-deep)', marginBottom: 4 }}>⑤ 角色卡</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink2)', marginBottom: 12 }}>
        {`SillyTavern V1/V2/V3 角色卡——.json 直接读,.png 从图里挑内嵌卡数据(优先取V3的ccv3块,没有再退V2的chara块);落进当前项目「${project}」的书架,内嵌世界书按世界书子集语义一并导入`}
      </div>
      <input type="file" accept=".json,.png,application/json,image/png" onChange={onFile} disabled={busy}
        style={{ fontSize: 12, color: 'var(--ink-body)' }} />
      {busy && <div style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 8 }}>导入处理中…</div>}
      {error && <div style={{ fontSize: 12, color: errColor, marginTop: 8 }}>{error}</div>}
      {receipt && (
        <div style={{ marginTop: 10, background: 'var(--scale-0)', borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600, marginBottom: 4 }}>导入成功</div>
          <div style={{ fontSize: 11.5, color: 'var(--accent)', marginBottom: 8 }}>
            {`「${receipt.name}」已经进书架了,去书架/世界书页能看到；${receipt.book_imported > 0 ? `内嵌世界书带来了 ${receipt.book_imported} 条设定` : '这张卡没带内嵌世界书'}`}
          </div>
          {Array.isArray(receipt.warnings) && receipt.warnings.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--ink2)', marginBottom: 8, lineHeight: 1.7 }}>
              {receipt.warnings.map((w: string, i: number) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
          {receipt.first_mes && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--ink2)', marginBottom: 4 }}>
                开场白{' '}
                <button onClick={() => copy('first_mes', receipt.first_mes)}
                  style={{ fontSize: 11, color: 'var(--ink2)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}>
                  {copiedKey === 'first_mes' ? '已复制' : '复制'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-body)', whiteSpace: 'pre-wrap' }}>{receipt.first_mes}</div>
            </div>
          )}
          {Array.isArray(receipt.alternate_greetings) && receipt.alternate_greetings.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--ink2)', marginBottom: 4 }}>备选开场白(共{receipt.alternate_greetings.length}条)</div>
              {receipt.alternate_greetings.map((g: string, i: number) => (
                <div key={i} style={{ marginBottom: 6 }}>
                  <button onClick={() => copy(`alt_${i}`, g)}
                    style={{ fontSize: 11, color: 'var(--ink2)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}>
                    {copiedKey === `alt_${i}` ? '已复制' : `复制第${i + 1}条`}
                  </button>
                  <div style={{ fontSize: 12, color: 'var(--ink-body)', whiteSpace: 'pre-wrap' }}>{g}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ImportTab({ base, envOk, project, onRegexChanged }: { base: string; envOk: boolean; project: string; onRegexChanged?: () => void }) {
  const [presetName, setPresetName] = useState('');

  // 案2(R3):第④口"挂到哪"要列现有预设包供选——ImportTab之前没拉过这份列表(BlocksTab那边拉的
  // 是它自己的state,两处各自独立请求是本仓一贯风格,不为了这一个下拉去跨组件传state)。
  const [regexPresets, setRegexPresets] = useState<PresetSummary[]>([]);
  const [regexPresetsLoading, setRegexPresetsLoading] = useState(true);
  const [regexPresetsError, setRegexPresetsError] = useState('');
  const [regexTarget, setRegexTarget] = useState(''); // ''=全局,否则=目标预设包id
  useEffect(() => {
    if (!envOk) { setRegexPresetsError('环境变量没配好'); setRegexPresetsLoading(false); return; }
    (async () => {
      setRegexPresetsLoading(true); setRegexPresetsError('');
      try {
        const res = await fetch(`${base}/api/oc/desk/presets`);
        const d = await res.json().catch(() => null);
        if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '预设包翻不出来');
        setRegexPresets(Array.isArray(d.presets) ? d.presets : []);
      } catch (e: any) {
        setRegexPresetsError(e.message || '预设包翻不出来');
      } finally {
        setRegexPresetsLoading(false);
      }
    })();
  }, [base, envOk]);

  async function postImport(path: string, body: any) {
    if (!envOk) throw new Error('环境变量没配好');
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '导入失败(服务端没确认成功)');
    onRegexChanged?.(); // 预设/settings/正则合集导入都会带进新正则,通知写作台重拉(worlds导入无正则,多通知一次无害)
    return d;
  }

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <input value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="预设包显示名(不填=文件名)" style={{ ...inputStyle, marginBottom: 10 }} />
      </div>
      <ImportPicker
        label="① 预设JSON"
        hint="酒馆预设整份文件——积木/内嵌正则/顶层采样参数,导成一个不可变新包(不会覆盖旧包)"
        successHint="这个包已经躺进「积木/配方」页了——去那边用「+ 新建配方」下拉把它拼成一份配方,或者展开下面的「预设包管理」看看导了些什么"
        onImport={async (json, filename) => {
          const name = presetName.trim() || filename;
          return postImport(`/api/oc/desk/import/preset?${new URLSearchParams({ name })}`, json);
        }}
      />
      <ImportPicker
        label="② worlds JSON"
        hint={`ST 世界书/角色卡导出文件——落进当前项目「${project}」的世界书(备用口,主口是从书架挑)`}
        onImport={async (json) => postImport('/api/oc/desk/import/worlds', { ...json, project })}
      />
      <ImportPicker
        label="③ settings JSON"
        hint="酒馆 settings.json——只抽全局正则+正则白名单+Horae总结模板,凭据类字段全洗盘不落库"
        onImport={async (json) => postImport('/api/oc/desk/import/settings', json)}
      />
      {/* 挂靠预设包:第④口——酒馆社区"多合一正则"导出格式(顶层就是一个
          数组,每项一条ST正则脚本),按原文件里的id幂等替换式导入;可以选"挂到哪"——全局(见窗就
          上妆)或某个预设包(只在用它拼的配方开的窗生效,跟着配方走)。重复导入同一份合集(同一个
          目标)不会堆出重复行;把已经导成全局的合集重导并选中某包=搬家,旧的全局行会被顶掉。 */}
      <ImportPicker
        label="④ 正则合集JSON"
        hint="酒馆社区流行的'多合一正则'导出格式——顶层就是一个数组,每项一条ST正则脚本;按id幂等替换。挂到预设包=只在用该预设拼的配方开的窗生效;挂到全局=见窗就上妆"
        extraControl={(busy) => (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--ink2)', marginBottom: 4 }}>挂到哪</div>
            {regexPresetsLoading ? (
              <div style={{ fontSize: 11.5, color: 'var(--ink2)' }}>正在翻预设包…</div>
            ) : regexPresetsError ? (
              <div style={{ fontSize: 11.5, color: errColor }}>预设包翻不出来：{regexPresetsError}（仍可导全局）</div>
            ) : (
              // 导入中(busy)锁死这个下拉——这一趟请求已经带着提交那一刻的目标飞出去了,
              // 导入没结束前还能改选项,视觉上会暗示"我还能改主意",其实改了也不影响这趟、只会
              // 让人误以为刚才选错了/结果落错了地方。
              <select
                value={regexTarget}
                onChange={(e) => setRegexTarget(e.target.value)}
                disabled={busy}
                style={{ ...inputStyle, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
              >
                <option value="">全局（所有窗生效）</option>
                {regexPresets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </div>
        )}
        successHint={(receipt) => {
          if (receipt?.scope === 'preset') {
            const name = regexPresets.find((p) => p.id === receipt.preset_id)?.name || receipt.preset_id;
            return `这批正则已经挂到预设包「${name}」了——只在用它拼的配方开的窗生效,去「正则」页按来源分组能看到`;
          }
          return '这批正则已经进「正则」页的全局正则分组了——去那边按来源分组翻,能看find/replace/flags也能开关/删除';
        }}
        onImport={async (json) => {
          // 显式快照当时选中的目标——不靠"这个闭包反正只读一次不会变"这种隐式假设,读一次
          // 就存进具名局部变量,后面的URL拼接只认这个变量,不再碰regexTarget这个可变state。
          // (下拉在busy期间已经disabled,实际上改不了;这层快照是代码语义上的明确保证,
          // 不依赖"UI恰好挡住了"这件事本身。)
          const targetSnapshot = regexTarget;
          const qs = targetSnapshot ? `?${new URLSearchParams({ target_preset_id: targetSnapshot })}` : '';
          return postImport(`/api/oc/desk/import/regex${qs}`, json);
        }}
      />
      <CharacterCardImportPicker project={project} postImport={postImport} />
    </div>
  );
}

// ══════════════════════════════════════════ 抽屉外壳 ══════════════════════════════════════════
// 第二批(拍板 #7):文具盒只剩"机器怎么处理"那一类——预设/正则/导入(≈酒馆的分法)。
// 世界书和核心记忆都属于"这个东西是什么",跟内容走,已经抬进顶栏那颗「世」的浮窗(LoreWindow.tsx)。
const TABS = [
  { key: 'blocks', label: '积木/配方' },
  { key: 'regex', label: '正则' },
  { key: 'import', label: '导入' },
] as const;
type TabKey = typeof TABS[number]['key'];
// 挂载方(TypingDesk 顶栏「文」/「世」两颗钮)要指定开在哪一页,得认得这个联合类型
export type DeskDrawerTabKey = TabKey;

// F4(判断留观,工单给了两选一,这里拍板记录):Escape 关闭抽屉,但"积木/配方""核心记忆""世界书"
// 三个标签页有真正的"编辑草稿,不点保存/提交就不落库"的中间态(overrides/light_system 草稿、
// 核心记忆分块草稿、世界书行内编辑器+手写表单+书架挑表单),有未存草稿时按 Escape 手滑关掉=丢稿子,
// 体验比"多按一次✕"差得多——所以选的是"没有未存草稿才让 Escape 关,有草稿时 Escape 按了没反应,
// 必须走✕按钮"这一支,不是"弹二次确认"那一支(Escape 本来就容易连按,二次确认在这个键上体验更差)。
// 世界书原先漏了这一档——它的"改动即时 PUT/POST"只在真正点了保存
// /提交之后才成立,行内编辑器开着、手写表单/书架表单填了字但没提交,都是纯本地草稿,一样会被丢弃
// 式离开吃掉,现在并进 hasUnsavedEdits。正则/导入两个标签页没有这层草稿态(正则是点开关/强制启用
// 就地生效,导入是选文件即触发),不计入这个判断。

// 写作屏顶栏瘦身:配方/模型两个下拉从写作屏顶栏搬进文具盒顶部「本窗设置」区——
// 逻辑一字不改只搬家,switchRecipe 全套(含 recipeSwitchingRef 互斥/在飞禁离窗)和 model state
// 仍然原样活在 TypingDesk.tsx 里,这里只接收数据+回调渲染。只有写作屏打开文具盒时才传这个 prop
// (那时才有"当前窗"这回事);列表屏那颗文具盒入口不传,「本窗设置」区天然不出现。
type WindowSettings = {
  recipeId: string;
  recipeOptions: Recipe[];
  onSwitchRecipe: (id: string) => void;
  recipeSwitching: boolean;
  recipeSwitchNotice: string;
  model: string;
  modelOptions: { id: string; label: string }[];
  onPickModel: (id: string) => void;
  sending: boolean;
};

// 挂载方(TypingDesk)现在有好几条"离开这扇窗/离开打字桌"的出口(rail切门、
// "家"链接、← 返回),原来只有背板/✕/切标签走 guardedClose 的两段确认,那几条新出口直接卸载
// 整个抽屉,未存草稿悄无声息就没了。开一个口子让挂载方在"真的要走"之前先问一句"文具盒这边
// 有没有没存的东西",答案不是true/false的哑结果,而是复用同一套 guardedClose 状态机——问了
// 但没关(有草稿,第一次问)返回 false 且顺手把 discardArm 亮起来(抽屉自己的关闭按钮文案会变成
// "再点一次丢弃并关闭",用户看得见发生了什么);没开/没脏/已经问过一次在3.5s窗口内被再问一次
// (等于用户确认丢弃)则真的调 onClose() 并返回 true。不新发明UI,requestClose 就是
// guardedClose 本体,只是包了一层"没开着就直接放行"的短路。
// 第一批追加 requestTab:顶栏那颗「世」要"开抽屉并落在世界书那一页"。
// 走 imperative 口而不是加一个 initialTab prop,理由是守卫——直接 setTab 会绕过 guardedSetTab
// 那套"有未存草稿先问一句再切"的两段确认(F4/F6 审过的闸),而 prop 同步天然只能 setTab。
// 这里转手调的就是 guardedSetTab 本体,返回值语义跟 requestClose 一致:
// false=有草稿,只是把确认亮出来了、还没真切;true=已经切了(或本来就在这一页)。
export type DeskDrawerHandle = {
  requestClose: () => boolean;
  requestTab: (k: DeskDrawerTabKey) => boolean;
};
const DeskDrawerHub = forwardRef<DeskDrawerHandle, {
  base: string; envOk: boolean; project: string; open: boolean; onClose: () => void; onRegexChanged?: () => void;
  windowSettings?: WindowSettings;
}>(function DeskDrawerHub({ base, envOk, project, open, onClose, onRegexChanged, windowSettings }, drawerHandleRef) {
  const [tab, setTab] = useState<TabKey>('blocks');
  // 世界书/核心记忆两个标签页已抬进浮窗(LoreWindow.tsx),它们的脏位跟着走——这里只剩积木/配方
  // 一路真草稿(正则是点开关就地生效、导入是选文件即触发,本来就没有"不点保存就不落库"的中间态)。
  const [blocksDirty, setBlocksDirty] = useState(false);
  // BlocksTab 的仓库选择器是抽屉里嵌的第二层弹层——真正
  // 堵住"Escape把选择器和整个抽屉一起关掉"这个时序窗的闸在 BlocksTab 那边(capture阶段监听
  // +stopImmediatePropagation,不看注册顺序,DOM事件分发算法本身保证capture先于这一层的
  // bubble监听器执行)。这个state是那道capture闸之外的第二层——万一capture闸没来得及挂上
  // (比如那个effect还没跑完的极端窗口),这里还能兜一道底,让这一层(抽屉本体)的Escape处理
  // 提前return,不检查hasUnsavedEdits也不关抽屉。这里只是"让位"标记,不是 hasUnsavedEdits 的
  // 一部分——选择器没有草稿语义,不该混进丢弃确认那套两段确认。
  const [blocksOverlayOpen, setBlocksOverlayOpen] = useState(false);
  // 丢弃式离开的两段确认:'close'=背板/✕,'tab:<key>'=切标签;3.5s窗口过期自动撤防
  const [discardArm, setDiscardArm] = useState<string | null>(null);
  const discardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnsavedEdits = blocksDirty;
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // 侧栏化(照原型 .penbox):从居中弹层改成右侧滑入侧栏——mounted 比 open 多扛一拍
  // (略大于过渡时长),不然 open 一变 false 早退 return 直接把标签内容(BlocksTab等)连根拔掉,
  // translateX 的滑出过渡还没来得及播完就已经看不见了。reduced-motion 时不需要这层缓冲(过渡本身
  // 被关掉,直接同步挂载/卸载不会有"瞬移"违和感,反而更贴合"减少动效"的诉求)。
  const [mounted, setMounted] = useState(open);
  const [slideIn, setSlideIn] = useState(open);
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 见下面 open effect 里"双帧保护"那段注释——单层 rAF 会被合并帧吃掉起点,这个 ref 用来让
  // cleanup 在两层 rAF 的任一层都能精准取消掉"当前还没触发的那一个"(不是固定指向第一层)。
  const slideInRafRef = useRef<number | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    try {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      setReducedMotion(mq.matches);
      const onChange = () => setReducedMotion(mq.matches);
      mq.addEventListener?.('change', onChange);
      return () => mq.removeEventListener?.('change', onChange);
    } catch { /* matchMedia 不可用的环境就当没开这个偏好 */ }
  }, []);
  useEffect(() => {
    if (open) {
      if (unmountTimerRef.current) { clearTimeout(unmountTimerRef.current); unmountTimerRef.current = null; }
      setMounted(true);
      if (reducedMotion) { setSlideIn(true); return; }
      // 挂载那一帧先让浏览器画出初始的 translateX(105%),下一帧再翻 slideIn 触发过渡——
      // 同一帧内直接从true开始不会有滑入动画(没有"起点"可过渡)。
      //
      // 真凶(用 MutationObserver 抓过真实 DOM 写入序列坐实):这里原来只套了一层 rAF——
      // setMounted(true) 的重渲染提交,和这层 rAF 回调,很容易被浏览器合并进同一帧:
      // rAF 回调是"画下一帧之前"触发,但如果 setMounted(true) 这次提交此刻还没被浏览器
      // 排上画面(常见于 React 的 effect flush 和 rAF 回调前后脚发生在同一个任务里),
      // 那这层 rAF 触发时,"translateX(105%)"那一帧压根还没被画出来过——slideIn 直接
      // 翻成 true,DOM 里从没出现过的中间状态,CSS transition 没有"起点"可过渡,侧栏
      // 表现为直接空降到位(不同机器/页面负载下合并时机不稳定,观感上是"先跳了一下
      // 再定住")。改成经典的双层 rAF:第一层 rAF 触发那一刻,"translateX(105%)"这帧才
      // 真正保证已经交给浏览器画完,这时候再排第二层 rAF 才真的隔了完整一帧,slideIn
      // 的过渡才有一个被实际画出来过的起点。
      const raf1 = requestAnimationFrame(() => {
        slideInRafRef.current = requestAnimationFrame(() => setSlideIn(true));
      });
      slideInRafRef.current = raf1;
      return () => {
        if (slideInRafRef.current) { cancelAnimationFrame(slideInRafRef.current); slideInRafRef.current = null; }
      };
    }
    setSlideIn(false);
    if (reducedMotion) { setMounted(false); return; }
    unmountTimerRef.current = setTimeout(() => setMounted(false), 300);
    return () => { if (unmountTimerRef.current) clearTimeout(unmountTimerRef.current); };
  }, [open, reducedMotion]);

  // 开合两头一把抓:body 滚动锁 + 关闭时把滚动和焦点都还回去(还给打开这一刻文档里原本聚焦的
  // 元素——通常就是触发侧栏的🧰按钮,不用从父组件另外传 ref 进来)。这一步不依赖 dialogRef 的
  // DOM 节点存不存在,open 一变就能做,不用等 mounted。
  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open]);

  // 初始焦点扔进侧栏容器——单独拆一个 effect 挂在 mounted(不是 open)上:侧栏化之后 mounted 比
  // open 晚一拍才变 true(见上面 mounted/slideIn 那段注释,动画缓冲需要),dialogRef 指向的 DOM
  // 节点要等 mounted 真的把侧栏渲出来才存在——挂在 open 上会在节点还没出生的那一帧空跑一次,
  // 焦点直接丢失。
  // ⚠️preventScroll 是命门(平板实测中"往左滑再闪回右边"的现象就是它导致的):focus() 的默认行为是
  // **把被聚焦的元素滚进视野**。而这一刻侧栏正停在 translateX(105%) —— 整个人在视口右边外面。
  // 浏览器为了"让它可见"就去横向滚动页面,于是看到的是"背景整页跟着动、侧栏一路滑到最左",
  // 等 transform 过渡回 0、不再需要那段偏移时,滚动位置弹回,就成了"从最左边闪现到右边"。
  // 桌面端因为容器裁掉了溢出、加上没有可视视口这一层,基本看不出来;iOS 上则很明显。
  // 焦点该给还是要给(可访问性/Esc/焦点陷阱都靠它),只是别让它顺手滚页面。
  useEffect(() => {
    if (open && mounted) dialogRef.current?.focus({ preventScroll: true });
  }, [open, mounted]);

  // Escape 关闭(有未存草稿时不关,见上方头注释)+ 简易焦点陷阱(Tab/Shift+Tab 只在弹层内循环)
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // 积木页的仓库选择器开着时,Escape归它管(它自己有一层capture阶段的keydown监听,
        // 真正的闸——按DOM事件分发顺序,那层先于这里的bubble监听器执行并stopImmediatePropagation,
        // 这个事件本来就到不了这里)。这个检查是第二层双保险,这一层完全让位——不检查
        // hasUnsavedEdits也不调onClose,免得选择器和整个抽屉被同一下Escape一起关掉。
        if (blocksOverlayOpen) return;
        if (hasUnsavedEdits) return;
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const container = dialogRef.current;
        if (!container) return;
        const focusables = container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const list = Array.from(focusables);
        const first = list[0];
        const last = list[list.length - 1];
        // 焦点不在名单里(初始落在容器上/意外跑偏)也算边界:开屏第一下Shift+Tab不许溜出弹层
        const idx = document.activeElement instanceof HTMLElement ? list.indexOf(document.activeElement) : -1;
        if (e.shiftKey && idx <= 0) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && (idx === -1 || idx === list.length - 1)) {
          e.preventDefault(); first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, hasUnsavedEdits, onClose, blocksOverlayOpen]);

  // 挂载方(TypingDesk)的离开协议要在这里问一句"能关吗"——见上面 DeskDrawerHandle 类型声明处
  // 注释。放在 `if (!mounted) return null` 之前:侧栏正在滑出的那 300ms 里(mounted还true、
  // open已经false)理论上也不该被外部再问一次(open===false 直接放行),挂在这个位置比挂在
  // 早退return之后更保险——不依赖"关闭动画还没播完"这种时序偶然性。
  useImperativeHandle(drawerHandleRef, () => ({
    requestClose(): boolean {
      if (!open) return true; // 没开着,没什么好保护的
      return guardedClose();
    },
    requestTab(k: DeskDrawerTabKey): boolean {
      // 抽屉没开着 = 关那一步已经过过 guardedClose 的丢弃确认了,没有需要保护的草稿。这时候直接
      // 落页,不走 guardedSetTab——因为 mounted 比 open 晚 300ms 才落(滑出动画那层缓冲),这段
      // 窗口里子标签页还没卸载、dirty 位还是残影,拿它去拦一次"开抽屉顺便翻到世界书"是误伤。
      // 抽屉开着时(顶栏 z-8 高过背板,「世」是真能点到的)才走两段确认,一步不省。
      if (!open) { setTab(k); return true; }
      return guardedSetTab(k);
    },
    // tab 也进依赖:guardedSetTab 闭包里读 tab 判"是不是已经在这一页",漏了会拿旧值比
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [open, tab, hasUnsavedEdits, discardArm, onClose]);

  if (!mounted) return null;

  // 有未存草稿时,一切"丢弃式离开"(切tab/点背板/点✕,以及父级 requestLeave 转发过来的
  // rail切门/"家"链接/← 返回)都走同一套两段确认。
  // 返回布尔值给上面的 requestClose() 用:false=只是问了一声、还没真关(第一次拦下/正在亮着
  // 确认文案);true=没脏或者已经确认过,真的调了 onClose()。
  function guardedClose(): boolean {
    if (hasUnsavedEdits && discardArm !== 'close') {
      setDiscardArm('close');
      if (discardTimer.current) clearTimeout(discardTimer.current);
      discardTimer.current = setTimeout(() => setDiscardArm(null), 3500);
      return false;
    }
    if (discardTimer.current) clearTimeout(discardTimer.current);
    setDiscardArm(null);
    onClose();
    return true;
  }
  // 返回值:true=已经切了/本来就在这一页;false=有未存草稿,
  // 只是把两段确认亮出来了,还没真切。原来的点击调用点不看返回值,行为一字未变。
  function guardedSetTab(k: string): boolean {
    if (k === tab) return true;
    if (hasUnsavedEdits && discardArm !== `tab:${k}`) {
      setDiscardArm(`tab:${k}`);
      if (discardTimer.current) clearTimeout(discardTimer.current);
      discardTimer.current = setTimeout(() => setDiscardArm(null), 3500);
      return false;
    }
    if (discardTimer.current) clearTimeout(discardTimer.current);
    setDiscardArm(null);
    setTab(k as typeof tab);
    return true;
  }

  // 侧栏化(照原型 .penbox):从"居中弹层+全屏背板压黑"改成"从右侧滑入的侧栏"——只覆盖
  // 打字桌/列表屏内容区右侧,不遮左廊、不整页压黑。定位靠 absolute 贴着调用方那个 position:relative
  // 外壳(TypingDesk 写作屏/列表屏各自的根容器),不用 fixed inset-0 到全视口——这样宽度天然被外壳
  // (=stage 内容区)卡住,不会盖住廊子。点侧栏外的内容区=尝试关闭,走跟"关闭"按钮同一套 guardedClose
  // (有未存草稿两段确认,不绕过守卫)。
  //
  // 层级顺序:背板 z:7 < 头栏 z:8 < 侧栏本体 z:9——上一轮为了让列表屏"← 书架"
  // 钮点得到,把整条头栏提到了 z:10,反而压过了侧栏本体(彼时 z:8),侧栏顶部的"关闭"钮/本窗设置区
  // 被头栏盖住/截获点击,按下去要么没反应要么误触头栏底下的东西。现在把侧栏本体从 8 提到 9(仍然
  // 比背板高,背板继续负责"点外部关闭"),两个调用方(TypingDesk 写作屏/列表屏)的头栏统一降到 8——
  // 头栏依然高过背板(点得到"← 返回"/"← 书架"/rail 那几个门,不会被背板截胡),但低于侧栏本体
  // (侧栏打开时头栏不再盖住侧栏顶端,关闭钮/本窗设置区/tab 全程可点)。
  return (
    <>
      <div
        className="absolute inset-0"
        style={{ zIndex: 7, pointerEvents: open ? 'auto' : 'none' }}
        onClick={guardedClose}
        aria-hidden
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`打字桌文具盒 · ${project}`}
        tabIndex={-1}
        className="absolute top-0 right-0 bottom-0 flex flex-col overflow-hidden"
        style={{
          width: 'min(400px, 86%)',
          background: 'var(--card-bg)',
          borderLeft: '1px solid var(--line-soft)',
          boxShadow: '-12px 0 34px var(--card-shadow2)',
          zIndex: 9,
          outline: 'none',
          transform: slideIn ? 'translateX(0)' : 'translateX(105%)',
          transition: reducedMotion ? 'none' : 'transform .28s ease',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-none flex items-center justify-between" style={{ padding: '20px 24px 12px' }}>
          <span className="serc" style={{ fontSize: 17, fontWeight: 600, color: 'var(--ink-deep)' }}>文具盒 · {project}</span>
          <button onClick={guardedClose} aria-label="关闭文具盒" className="serc leading-none cursor-pointer hover:opacity-70" style={{ fontSize: discardArm === 'close' ? 12 : 13, color: discardArm === 'close' ? '#c0573f' : 'var(--ink2)', background: 'none', border: 'none' }}>{discardArm === 'close' ? '有草稿未保存,再点一次丢弃并关闭' : '关闭'}</button>
        </div>
        {/* 任务2:本窗设置——只在写作屏打开(windowSettings非空)时出现,列表屏那颗文具盒没有
            当前窗,不渲这一块。两行选择器,逻辑一字不改只搬家(见 WindowSettings 类型声明处注释)。 */}
        {windowSettings && (
          <div className="flex-none" style={{ padding: '0 24px 14px' }}>
            <div className="serc" style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink2)', letterSpacing: 1, marginBottom: 8 }}>本窗设置</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="serc" style={{ fontSize: 12, color: 'var(--ink2)', width: 32, flexShrink: 0 }}>配方</span>
                <select
                  value={windowSettings.recipeId}
                  onChange={(e) => windowSettings.onSwitchRecipe(e.target.value)}
                  disabled={windowSettings.sending || windowSettings.recipeSwitching}
                  title="配方(切换即刻保存;生成中锁定)"
                  style={{ ...inputStyle, width: 'auto', flex: 1, minWidth: 160, cursor: (windowSettings.sending || windowSettings.recipeSwitching) ? 'default' : 'pointer', opacity: (windowSettings.sending || windowSettings.recipeSwitching) ? 0.6 : 1 }}
                >
                  {/* 列表还没拉回来/当前配方已不在通用列表里(比如刚被删,正打算换掉)时,
                      垫一个占位选项显示当前id,不让select空着找不到匹配值(照原header select同款家法) */}
                  {windowSettings.recipeId && !windowSettings.recipeOptions.some((r) => r.id === windowSettings.recipeId) && (
                    <option value={windowSettings.recipeId}>当前配方</option>
                  )}
                  {windowSettings.recipeOptions.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}（{r.weight === 'light' ? '轻' : '重'}{r.project ? `·${r.project}` : ''}）</option>
                  ))}
                </select>
                {windowSettings.recipeSwitchNotice && <span className="ser" style={{ fontSize: 10.5, color: 'var(--ink2)', whiteSpace: 'nowrap' }}>{windowSettings.recipeSwitchNotice}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="serc" style={{ fontSize: 12, color: 'var(--ink2)', width: 32, flexShrink: 0 }}>模型</span>
                <select
                  value={windowSettings.model}
                  onChange={(e) => windowSettings.onPickModel(e.target.value)}
                  disabled={windowSettings.sending}
                  title="模型(后端白名单同款;写进localStorage全桌通用)"
                  style={{ ...inputStyle, width: 'auto', flex: 1, minWidth: 160, cursor: windowSettings.sending ? 'default' : 'pointer', opacity: windowSettings.sending ? 0.6 : 1 }}
                >
                  {windowSettings.modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}
        <div className="flex-none flex gap-2 overflow-x-auto" style={{ padding: '0 24px 14px' }}>
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => guardedSetTab(t.key)}
              className="serc"
              style={{
                fontSize: 12.5, padding: '7px 15px', borderRadius: 20, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit',
                background: tab === t.key ? 'var(--scale-3)' : 'var(--card-bg)',
                color: discardArm === `tab:${t.key}` ? '#c0573f' : (tab === t.key ? 'var(--card-bg)' : 'var(--ink-body)'),
                border: tab === t.key ? '1px solid transparent' : '1px solid var(--line-soft)',
              }}
            >
              {discardArm === `tab:${t.key}` ? '再点一次丢弃草稿' : t.label}
            </button>
          ))}
        </div>
        <div style={{ margin: '0 24px', borderTop: '1px dashed var(--dash-line)' }} />
        <div className="flex-1 overflow-y-auto" style={{ padding: '18px 24px 26px' }}>
          {/* project 维度全部标签页用 key={project} 挂——切项目=整份子树重挂载,旧项目的搜索
              结果/选中态/请求回调统统随卸载作废,不会有"A项目搜到的书流进B项目的世界书指针"这类
              串项目事故;F2 的请求令牌是同一挂载周期内的第二道保险,两条一起才算"带式而不只是保险"。*/}
          {tab === 'blocks' && <BlocksTab key={project} base={base} envOk={envOk} project={project} onDirtyChange={setBlocksDirty} onRegexChanged={onRegexChanged} onOverlayOpenChange={setBlocksOverlayOpen} />}
          {tab === 'regex' && <RegexTab base={base} envOk={envOk} onRegexChanged={onRegexChanged} />}
          {tab === 'import' && <ImportTab base={base} envOk={envOk} project={project} onRegexChanged={onRegexChanged} />}
        </div>
      </div>
    </>
  );
});

export default DeskDrawerHub;
