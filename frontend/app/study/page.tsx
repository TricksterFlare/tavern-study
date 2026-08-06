'use client';

// 书房页面：OC 创作资料库的书架/项目/详情三层视图，单页内靠状态切换,不开子路由。
// 对接 /api/oc/* REST 接口,按约定字段读写;fetch 一律 try/catch,res.ok 和 body.success 都要验,
// 加载/错误/空态分开显示,不把"没查到"和"查失败"混为一谈。颜色只走 var(--xxx) token,不写死色号。

import { useState, useEffect, useRef, useCallback } from 'react';
import HeatBg from '../HeatBg';
import ReadingCorner from './ReadingCorner';
import TypingDesk, { type TypingDeskHandle } from './TypingDesk';
import {
  LoreTriggerFields, DEFAULT_LORE_TRIGGER, triggerKeysFromText, triggerModeForSave,
  type LoreTriggerValue, type LorePosition, type CharacterFields,
} from './LoreTriggerFields';

// ── 数据形状(按后端契约来,字段名不许自己发明) ──
type Stats = { by_category: Record<string, number>; by_project: Record<string, number>; total: number };
type MemoryListItem = {
  id: string; project: string; category: string; title: string;
  chapter?: string | null; tags: string[]; created_at: string; preview: string;
};
// 触发配置六件套(keys/position/is_char/constant/trigger_mode/fields)跟世界书浮窗
// (DeskDrawers.tsx LoreRowView)读写同一份 memories 行——只对 world/outline 分类有意义,
// plot/session 恒是库默认值,书架表单不管它们。
type MemoryDetail = {
  id: string; project: string; category: string; title: string;
  chapter?: string | null; tags: string[]; content: string;
  created_at: string; updated_at: string;
  keys: string[]; position: LorePosition; is_char: boolean; constant: boolean;
  trigger_mode: 'scan' | 'presence'; fields: CharacterFields;
};
type SearchResult = {
  id: string; project: string; category: string; title: string;
  chapter?: string | null; tags: string[]; created_at: string; preview: string; score?: number;
};

type View = 'shelf' | 'project' | 'detail' | 'reading' | 'desk';
type DetailMode = 'view' | 'edit' | 'new';
// 读书角内部主tab(章节工坊并入读书角)——两个文件各自留一份同名类型,本仓惯例
// (同 ProjectField 组件独立成文件那条头注释),不为这一个小 union 类型专门拉共享文件。
type ReadingTab = 'read' | 'chapters';

const CATEGORIES: { key: string; label: string }[] = [
  { key: 'world', label: '设定' },
  { key: 'plot', label: '剧情总结' },
  { key: 'outline', label: '大纲' },
  { key: 'session', label: '交接' },
];
// 分类 tab 行——「剧情总结」不在里面。它已经搬去读书角·章节工房了,留在这儿的那一格是个
// "长得像分类页、点了却把人传送走"的假门,现在改成 tab 行下面一张明写着去处的传送卡片。
// CATEGORIES 里仍保留 plot——CATEGORY_LABEL 要靠它给旧架子存货的详情页显示分类名。
const PROJECT_TABS: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  ...CATEGORIES.filter((c) => c.key !== 'plot'),
];
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
// URL 里恢复分类的唯一口径:c=plot 是旧链接/旧书签(那一格已从 tab 行摘走)——落回「全部」。
// 不归一化的话会留一个"哪个 tab 都不高亮、列表还被 plot 守卫清空"的永久空态。恢复路径有两条
// (v=project 直接进、v=detail&from=project 返回时预置),两条都得走这里,少一条就漏。
function restoredCategory(params: URLSearchParams): string {
  const c = params.get('c') || 'all';
  return c === 'plot' ? 'all' : c;
}
// 通用新增/编辑表单可选的分类:「剧情总结」已经改吃章节架(oc_chapters,见 ChaptersStudio),
// 从这里摘掉——挡住"绕开章节架从别的分类切进 plot 继续写 memories"的后门。
const FORM_CATEGORIES = CATEGORIES.filter((c) => c.key !== 'plot');
// 世界书闸门:只有 world(设定)/outline(大纲)两类会被打字桌世界书面板扫到,
// 表单的「进场方式」一节只在这两类下显示——跟 src/tools/deskPanels.ts 的 LORE_CATEGORIES 同宽。
function isLoreCategory(category: string): boolean {
  return category === 'world' || category === 'outline';
}

// ── 卡片风格小料(颜色只用 token) ──
const cardStyle: React.CSSProperties = {
  background: 'var(--card-bg)',
  border: '1px solid var(--line-soft)',
  borderRadius: 22,
  boxShadow: '0 6px 18px var(--card-shadow)',
};
const glassCardStyle: React.CSSProperties = {
  background: 'var(--glass-bg)',
  border: '1.5px dashed var(--dash-line)',
  borderRadius: 22,
  boxShadow: '0 4px 16px var(--card-shadow)',
};
const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 14,
  color: 'var(--ink2)',
  background: 'var(--card-bg)',
  border: '1px solid var(--line-soft)',
  padding: '7px 16px',
  borderRadius: 30,
  cursor: 'pointer',
  textDecoration: 'none',
  fontFamily: 'inherit',
};
const btnPrimaryStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--card-bg)',
  background: 'var(--accent)',
  border: 'none',
  padding: '9px 18px',
  borderRadius: 20,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const inputStyle: React.CSSProperties = {
  fontSize: 13.5,
  color: 'var(--ink-body)',
  background: 'var(--card-bg)',
  border: '1px solid var(--line-soft)',
  borderRadius: 12,
  padding: '9px 14px',
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

function fmtMD(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch { return iso; }
}

// preview/正文两行截断的小样式(卡片里用)
const clamp2: React.CSSProperties = {
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

// ── 左廊三扇门 ──
// 左廊常驻(书架/写作/读书角):不同视图不再各自整页接管,而是共享同一个外壳,
// 点门只切换 sty-main(stage)内部渲染的内容,避免整页跳变。
const RAIL_DOORS: { view: View; icon: string; label: string }[] = [
  { view: 'shelf', icon: '架', label: '书架' },
  { view: 'desk', icon: '写', label: '打字桌' },
  { view: 'reading', icon: '读', label: '读书角' },
];
// 响应式只靠这段纯 CSS(媒体查询)判断宽窄,不用 window.innerWidth——那样首屏 SSR/hydration 值对不上
// 客户端真实宽度,会闪一下或报 mismatch。断点取 700px(>700 才算桌面)。
// 颜色仍然只走内联 style 里的 var(--xxx),这段 CSS 只管布局方向/宽度/滚动,不带色号。
const RAIL_CSS = `
.sty-page { height: 100dvh; overflow: hidden; }
.sty-shell { display: flex; width: 100%; height: 100dvh; min-height: 0; overflow: hidden; }
.sty-rail { width: 176px; flex: none; position: relative; display: flex; flex-direction: column; padding: 18px 12px; border-right: 1px solid var(--line-soft); overflow: hidden; }
.sty-rail.collapsed { width: 58px; padding-left: 8px; padding-right: 8px; }
.sty-rail > :not(.sty-rail-pattern) { position: relative; z-index: 1; }
.sty-rail-pattern { position: absolute; inset: 0; z-index: 0; }
.sty-rail-brand { padding: 4px 10px 18px; }
.sty-rail.collapsed .sty-rail-brand, .sty-rail.collapsed .sty-rail-label { display: none; }
.sty-rail-top { display: flex; align-items: center; gap: 4px; margin-bottom: 10px; }
.sty-rail-collapse { margin-left: auto; width: 30px; height: 30px; padding: 0; justify-content: center; }
.sty-rail.collapsed .sty-rail-top { flex-direction: column; }
.sty-rail.collapsed .sty-rail-collapse { margin-left: 0; }
.sty-rail.collapsed .sty-rail-btn { justify-content: center; padding-left: 7px; padding-right: 7px; }
.sty-rail-doors { display: flex; flex-direction: column; gap: 4px; }
.sty-rail-btn { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 12px; border: 0; border-radius: 10px; background: transparent; color: var(--ink-body); font: inherit; text-decoration: none; cursor: pointer; white-space: nowrap; }
.sty-rail-btn:hover { background: color-mix(in srgb, var(--card-bg) 58%, transparent); }
.sty-rail-btn.active { background: var(--card-bg); box-shadow: 0 2px 8px var(--card-shadow); color: var(--ink-deep); font-weight: 600; }
.sty-rail-glyph { width: 20px; flex: none; text-align: center; }
.sty-home { color: var(--ink2); }
.sty-main { flex: 1 1 auto; min-width: 0; min-height: 0; position: relative; display: flex; flex-direction: column; overflow: hidden; background: var(--card-bg); }
.sty-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 22px 26px 44px; }
@media (min-width: 701px) {
  .sty-shell { flex-direction: row; }
}
@media (max-width: 700px) {
  .sty-shell { height: 100dvh; min-height: 0; border: 0 !important; border-radius: 0 !important; flex-direction: column; }
  .sty-rail { width: 100%; flex-direction: row; align-items: center; gap: 8px; padding: 10px; border-right: 0; border-bottom: 1px solid var(--line-soft); overflow-x: auto; }
  .sty-rail.collapsed { width: 100%; padding: 10px; }
  .sty-rail-brand { display: none; }
  .sty-rail-top, .sty-rail.collapsed .sty-rail-top { flex-direction: row; margin-bottom: 0; }
  .sty-rail-collapse { display: none; }
  .sty-rail.collapsed .sty-rail-label { display: inline; }
  .sty-rail-doors { flex-direction: row; gap: 4px; }
  .sty-rail-btn { width: auto; flex: none; }
  .sty-home { order: -1; margin-top: 0; }
  .sty-scroll { padding: 18px 16px 32px; }
}
`;

export default function StudyPage() {
  const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL;
  const token = process.env.NEXT_PUBLIC_AUTH_TOKEN;
  const base = `${workerUrl}/${token}`;
  const envOk = !!workerUrl && !!token;

  const [view, setView] = useState<View>('shelf');
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [cameFrom, setCameFrom] = useState<View>('shelf'); // 详情页"← 返回"回哪儿
  // 左廊常驻后,从打字桌切去别的门要先问一句"现在能走吗"(配方切换在飞禁离窗那道闸,
  // 见 TypingDesk.tsx requestLeave 定义处注释)——TypingDesk 挂载时才有实例,ref 初始是 null,
  // 只在 view==='desk' 时才会真的被用到。
  const typingDeskRef = useRef<TypingDeskHandle | null>(null);

  useEffect(() => {
    try { setRailCollapsed(localStorage.getItem('study_rail_collapsed') === '1'); } catch { /* storage 不可用就保持展开 */ }
  }, []);

  function toggleRail() {
    setRailCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('study_rail_collapsed', next ? '1' : '0'); } catch { /* 只影响记忆,不影响本次收展 */ }
      return next;
    });
  }

  // 读书角内部主tab——从这边(书架)拍板哪个项目跳去章节工房,读书角受控。
  const [readingTab, setReadingTab] = useState<ReadingTab>('read');
  const [readingProject, setReadingProject] = useState<string | null>(null);

  // 视图状态进URL——首次挂载解析一次 URL 恢复视图,恢复完成前("restored"仍是 false)
  // 下面那个"写URL"的 effect 全部按兵不动,免得拿着初始默认状态(shelf)把地址栏里的目标参数覆盖掉。
  const [restored, setRestored] = useState(false);
  // detail 恢复要 await loadDetail,这段等待期间用户可能已经从廊子/别的入口
  // 主动切走了——请求随后若失败,不能无条件把人拽回书架,顶掉她刚选的视图。恢复令牌:恢复任务启动
  // 时取号,所有"用户主动导航"的路径(见下面 navigate 函数,不是恢复 effect 自己内部那几个 setView)
  // 一律把令牌拨新,恢复任务在 await 落地后核对令牌没变才准动 view,过期就静默放弃——组件卸载也天然
  // 被"再也没人来核对令牌"覆盖,不用额外处理。
  const restoreSeqRef = useRef(0);

  // ── 书架:统计(项目格子) ──
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');

  // ── 书架:全局语义搜索 ──
  const [searchQ, setSearchQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchTried, setSearchTried] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  // ── 项目视图 ──
  const [currentProject, setCurrentProject] = useState<string | null>(null);
  const [currentCategory, setCurrentCategory] = useState<string>('all');
  // 书架首页「＋新建项目」输入框——空库时"+ 新增"只住在项目内页,门口必须有第一把钥匙
  const [newProjName, setNewProjName] = useState('');
  const [keyword, setKeyword] = useState('');
  // 排序:time=最新在前(默认)/chapter=按章节号(拆成上下半的总结靠它归位,空章节沉底)/title=标题序
  const [sortOrder, setSortOrder] = useState<'time' | 'chapter' | 'title'>('time');
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [listItems, setListItems] = useState<MemoryListItem[]>([]);
  const [listCount, setListCount] = useState<number | null>(null);
  const [listNonce, setListNonce] = useState(0); // 保存/删除后强制刷新用

  // ── 详情/编辑 ──
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>('view');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detail, setDetail] = useState<MemoryDetail | null>(null);
  const [form, setForm] = useState({ project: '', category: 'world', title: '', chapter: '', tagsText: '', content: '', trigger: DEFAULT_LORE_TRIGGER });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [lastVectorOk, setLastVectorOk] = useState<boolean | null>(null);
  const [deleteStage, setDeleteStage] = useState<0 | 1>(0);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // restoreSeqRef 只拦了恢复效果自己最后那句 setView,loadDetail 本体没设防——A(URL恢复)在飞、
  // 用户切走打开B,A迟到的响应照样会覆盖 detail/error/loading,而这时 detailId 早就是B了,
  // 画面显示A、编辑PUT/删除DELETE却打B。请求序号下沉到 loadDetail 本体:每次调用在入口取号,
  // 函数内成功/失败/finally 三处提交前都核对序号没被更新的调用踩过——不用调用方
  // (openDetail/handleSave/URL恢复)配合,新调用天然作废所有旧请求的后续提交。
  const detailReqSeqRef = useRef(0);
  // detailId 的活值镜像(同 ChaptersStudio.tsx editingIdRef 家法)——成功提交前顺手核对一次"这次响应
  // 装的到底是不是当前 detailId 那一条",双保险(理论上已经被上面的序号闸挡住,这里再兜一层)。
  const detailIdRef = useRef<string | null>(null);
  useEffect(() => { detailIdRef.current = detailId; }, [detailId]);

  // ── 书架统计:首次进门拉一次;之后每次回到书架视图都重新清点——存完新条目/新项目回来,
  //    格子不能还念旧账。深链直达其他视图(读书角等)仍靠首次那发喂 projectOptions。
  //    seq 闸沿用本文件请求序号家法:慢的旧响应不许盖新快照;成功时清掉旧 statsError,别一错定终身。
  const statsFetchedRef = useRef(false);
  const statsSeqRef = useRef(0);
  useEffect(() => {
    if (!envOk) { setStatsError('环境变量没配好'); setStatsLoading(false); return; }
    if (view !== 'shelf' && statsFetchedRef.current) return;
    statsFetchedRef.current = true;
    const tok = ++statsSeqRef.current;
    (async () => {
      try {
        const res = await fetch(`${base}/api/oc/stats`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json().catch(() => null);
        if (!d || d.success === false) throw new Error(d?.error || '后端报错');
        if (tok !== statsSeqRef.current) return;
        setStatsError('');
        setStats({
          by_category: d.by_category && typeof d.by_category === 'object' ? d.by_category : {},
          by_project: d.by_project && typeof d.by_project === 'object' ? d.by_project : {},
          total: typeof d.total === 'number' ? d.total : 0,
        });
      } catch (e: any) { if (tok === statsSeqRef.current) setStatsError(e.message || '统计翻不出来'); }
      finally { if (tok === statsSeqRef.current) setStatsLoading(false); }
    })();
  }, [base, envOk, view]);

  // project 下拉选项——权威源就是这份书架统计,已经拿在手里,不为这一个下拉专门多发一次请求;
  // 去重(by_project的key本来就是去重的)+ 中文排序。
  const projectOptions = stats ? Object.keys(stats.by_project).filter((p) => p.trim()).sort((a, b) => a.localeCompare(b, 'zh')) : [];

  // ── 项目视图:project/category/keyword/listNonce 变了就重新拉列表(关键词做个小防抖) ──
  useEffect(() => {
    if (view !== 'project' || currentProject === null) return;
    // 「剧情总结」分类已经改吃章节架(oc_chapters),不再从这里拉 memories 列表——渲染交给 ChaptersStudio。
    if (currentCategory === 'plot') { setListItems([]); setListCount(null); setListError(''); setListLoading(false); return; }
    if (!envOk) { setListError('环境变量没配好'); setListLoading(false); return; }
    setListLoading(true);
    setListError('');
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ project: currentProject, limit: '200' });
        // 封面册数统计的是项目下全部分类，进门也先展示全部，避免"封面 1 册、默认设定栏 0 册"的幽灵书架。
        if (currentCategory !== 'all') qs.set('category', currentCategory);
        if (keyword.trim()) qs.set('keyword', keyword.trim());
        if (sortOrder !== 'time') qs.set('order', sortOrder);
        const res = await fetch(`${base}/api/oc/memories?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json().catch(() => null);
        if (!d || d.success === false) throw new Error(d?.error || '后端报错');
        setListItems(Array.isArray(d.memories) ? d.memories : []);
        setListCount(typeof d.count === 'number' ? d.count : (Array.isArray(d.memories) ? d.memories.length : 0));
      } catch (e: any) { setListError(e.message || '这一格翻不开'); setListItems([]); setListCount(null); }
      finally { setListLoading(false); }
    }, keyword.trim() ? 400 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, currentProject, currentCategory, keyword, listNonce, sortOrder]);

  // 返回值给 URL 恢复用(detail id 在地址栏里翻不出来时得知道失败,好回书架)——
  // 原有调用点(openDetail/handleSave)都不看返回值,加个 boolean 不影响它们。
  // 序号闸(见上面 detailReqSeqRef 注释):seq 过期=有更新的调用已经在飞,这份响应整个放弃提交,
  // 连 return 值都跟着降级成 false——调用方里唯一看返回值的是 URL 恢复效果,而它自己的 restoreSeqRef
  // 视图闸此时必然也已经被过期(见下面恢复效果:任何会让 loadDetail 重新被调用的路径都先走 navigate()
  // 拨新 restoreSeqRef),所以不会出现"seq过期但restoreSeqRef没过期,回书架逻辑被 false 误伤"的情况。
  const loadDetail = useCallback(async (id: string): Promise<boolean> => {
    const seq = ++detailReqSeqRef.current;
    setDetailLoading(true);
    setDetailError('');
    setDetail(null);
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/memories/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success === false) throw new Error(d?.error || '后端报错');
      if (seq !== detailReqSeqRef.current) return false; // 序号过期:更新的请求已经在飞,这份旧响应放弃提交
      if (detailIdRef.current !== id) return false; // 双保险:提交对象跟当前 detailId 对不上(理论上已被序号闸挡住)
      setDetail({
        id: d.id, project: d.project, category: d.category, title: d.title,
        chapter: d.chapter ?? null, tags: Array.isArray(d.tags) ? d.tags : [],
        content: d.content ?? '', created_at: d.created_at, updated_at: d.updated_at,
        // 触发字段六件套:接口没带(旧缓存的 Worker 版本)就落回库默认,回显不炸。
        keys: Array.isArray(d.keys) ? d.keys : [],
        position: d.position === 'after' || d.position === 'char' ? d.position : 'before',
        is_char: !!d.is_char, constant: !!d.constant,
        trigger_mode: d.trigger_mode === 'presence' ? 'presence' : 'scan',
        fields: d.fields && typeof d.fields === 'object' ? d.fields : {},
      });
      return true;
    } catch (e: any) {
      if (seq !== detailReqSeqRef.current) return false; // 同上:旧请求的失败别污染新请求的错误显示
      setDetailError(e.message || '这条翻不出来');
      return false;
    } finally {
      if (seq === detailReqSeqRef.current) setDetailLoading(false); // 旧请求收尾别把新请求的 loading 提前关掉
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, envOk]);

  // ── 视图状态进URL ──
  // 键名表(简洁够用,不求大而全):
  //   v    = view(shelf 不写,省得默认态还挂一串参数)
  //   p    = project(v=project 时的项目名;v=detail 且 from=project 时也带,回项目要用)
  //   c    = category(v=project 时非 all 才写;跟 p 配对出现)
  //   id   = detail 的 memory id(v=detail)
  //   from = detail 的"← 返回"目的地,shelf|project(v=detail)
  //   t    = 读书角内部主tab,chapters 才写(v=reading,配 p 表示章节工房选中的项目)
  //
  // 恢复时序:只在挂载时跑一次(空依赖),按 v 分支各自把该恢复的 state 摆好,最后统一把 restored
  // 置 true——detail 分支要等 loadDetail 的 await 落地才收尾,其它分支这一步是同步的,但因为 React 18
  // 自动批处理,不管走不走 await,状态更新都跟"这一路恢复用到的 state + restored"一起提交,不会有
  // "半吊子状态被下面写URL的 effect 看见"的中间态露出来。
  useEffect(() => {
    // 挂载即取号——detail 分支要 await loadDetail,这段等待期间用户可能已经
    // 从廊子/别的入口主动切走了(navigate() 会把令牌拨新)。await 落地后核对令牌没变才准动 view,
    // 过期就静默放弃(用户已经去了别处,别打扰她;不管这次 fetch 是成功还是失败,过闸不过都一个逻辑)。
    const tok = ++restoreSeqRef.current;
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const v = params.get('v');
        if (v === 'reading' || v === 'desk') {
          setView(v);
          if (v === 'reading') {
            const t = params.get('t');
            const p = params.get('p');
            if (t === 'chapters') { setReadingTab('chapters'); setReadingProject(p || null); }
          }
        } else if (v === 'project') {
          const p = params.get('p');
          if (p) {
            setCurrentProject(p);
            setCurrentCategory(restoredCategory(params));
            setKeyword(''); setListItems([]); setListCount(null); setListError('');
            setView('project');
          }
        } else if (v === 'detail') {
          const id = params.get('id');
          const from: View = params.get('from') === 'project' ? 'project' : 'shelf';
          const p = params.get('p');
          if (id) {
            if (from === 'project' && p) {
              setCurrentProject(p);
              // 这条路也要归一化。从旧的 plot 详情页「← 返回」回项目页时,分类会被原样恢复成 plot——
              // tab 行里已经没有这一格,结果是哪个 tab 都不高亮、列表还被 plot 守卫清空,永远空着。
              // 跟上面项目页恢复走同一个口径。
              setCurrentCategory(restoredCategory(params));
            }
            setCameFrom(from);
            setDetailId(id);
            setDetailMode('view');
            setLastVectorOk(null);
            setDeleteStage(0); setDeleteError('');
            setSaveError('');
            setView('detail');
            const ok = await loadDetail(id);
            // 令牌过期=用户在请求飞着的时候已经主动导航走了,不管成功失败都不再碰 view——
            // 边角(id 翻不出来回书架,不炸)只在"没人打扰"这条线上才生效。
            if (tok !== restoreSeqRef.current) return;
            if (!ok) setView('shelf');
          }
        }
      } finally {
        setRestored(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 写URL:上面恢复完成(restored)之后,view/项目/分类/详情/来处/读书角子tab 任一变了就同步一次,
  // 用 replaceState 不留历史堆栈。shelf(或detail新建态,detailId 还没落地)不带参数,地址栏干净。
  useEffect(() => {
    if (!restored) return;
    const params = new URLSearchParams();
    if (view === 'reading' || view === 'desk') {
      params.set('v', view);
      if (view === 'reading' && readingTab === 'chapters') {
        params.set('t', 'chapters');
        if (readingProject) params.set('p', readingProject);
      }
    } else if (view === 'project' && currentProject !== null) {
      params.set('v', 'project');
      params.set('p', currentProject);
      if (currentCategory !== 'all') params.set('c', currentCategory);
    } else if (view === 'detail' && detailId) {
      params.set('v', 'detail');
      params.set('id', detailId);
      if (cameFrom === 'project' && currentProject !== null) {
        params.set('from', 'project');
        params.set('p', currentProject);
        if (currentCategory !== 'all') params.set('c', currentCategory);
      } else {
        params.set('from', 'shelf');
      }
    }
    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (newUrl !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', newUrl);
    }
  }, [restored, view, currentProject, currentCategory, detailId, cameFrom, readingTab, readingProject]);

  // ── 语义搜索 ──
  async function doSearch() {
    const q = searchQ.trim();
    if (!q) return;
    setSearching(true); setSearchTried(true); setSearchError(''); setSearchResults([]);
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const qs = new URLSearchParams({ q, topK: '20' });
      const res = await fetch(`${base}/api/oc/search?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success === false) throw new Error(d?.error || '后端报错');
      const rows = d.results || d.memories; // 后端字段名可能是 memories,两个都认
      setSearchResults(Array.isArray(rows) ? rows : []);
    } catch (e: any) { setSearchError(e.message || '搜索翻车了'); }
    finally { setSearching(false); }
  }

  // ── 导航小函数 ──
  // 用户主动导航一律走这个,不直接掉 setView——任何一次调用都把恢复令牌拨新,让还在飞的
  // URL 恢复(目前只有 detail 分支会 await)失效。恢复 effect 自己内部那几个 setView
  // (初始摆视图/失败兜底回书架)不经过这层,不然会把自己刚发的令牌当场作废,正常恢复反而失效。
  function navigate(v: View) {
    restoreSeqRef.current++;
    setView(v);
  }
  function openProject(project: string) {
    setCurrentProject(project);
    setCurrentCategory('all');
    setKeyword('');
    setListItems([]); setListCount(null); setListError('');
    navigate('project');
  }
  function backToShelf() { navigate('shelf'); }
  function backFromDetail() { navigate(cameFrom); }
  // 原来书架侧"剧情总结"分类门通向 ChaptersStudio,现在改成跳门——切到读书角、把它的主tab
  // 扳去章节工房、把项目带过去,不再留旧挂载。
  function jumpToChaptersStudio(project: string) {
    setReadingProject(project);
    setReadingTab('chapters');
    navigate('reading');
  }
  // 廊子"当前门"判定:书架门在 project/detail 子视图里也保持高亮(它们是书架门内的子页)。
  function isDoorActive(door: View): boolean {
    if (door === 'shelf') return view === 'shelf' || view === 'project' || view === 'detail';
    return view === door;
  }
  function openDetail(id: string, from: View) {
    setCameFrom(from);
    setDetailId(id);
    setDetailMode('view');
    setDetail(null);
    setLastVectorOk(null);
    setDeleteStage(0); setDeleteError('');
    setSaveError('');
    navigate('detail');
    loadDetail(id);
  }
  function openNew() {
    setCameFrom('project');
    setDetailId(null);
    setDetailMode('new');
    setDetail(null);
    setLastVectorOk(null);
    setSaveError('');
    setForm({ project: currentProject || '', category: currentCategory === 'all' ? 'world' : currentCategory, title: '', chapter: '', tagsText: '', content: '', trigger: DEFAULT_LORE_TRIGGER });
    navigate('detail');
  }
  function startEdit() {
    if (!detail) return;
    setForm({
      project: detail.project, category: detail.category, title: detail.title,
      chapter: detail.chapter || '', tagsText: (detail.tags || []).join(', '), content: detail.content || '',
      // 预填现值:跟世界书浮窗读写同一份数据,编辑表单打开时得看见浮窗那边可能已经改过的触发配置。
      trigger: {
        keysText: (detail.keys || []).join('、'), position: detail.position,
        isChar: detail.is_char, constant: detail.constant,
        presenceOnly: detail.trigger_mode === 'presence', fields: detail.fields || {},
      },
    });
    setSaveError('');
    setDetailMode('edit');
  }
  function cancelEdit() {
    setSaveError('');
    if (detailMode === 'new') { navigate(cameFrom); return; }
    setDetailMode('view');
  }

  async function handleSave() {
    setSaving(true); setSaveError('');
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const project = form.project.trim();
      const title = form.title.trim();
      if (!project || !title) throw new Error('项目和标题不能空着');
      // 中英文逗号都认(中文输入法打逗号常不切回英文,兼容两种输入习惯)
      const tags = form.tagsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      const body: any = { project, category: form.category, title, chapter: form.chapter.trim(), tags, content: form.content };
      // 触发字段只在 world/outline 才带上——其它分类不显示这一节 UI,也不该发这几个字段
      // (可选=向后兼容:不发送时后端行为跟没加这个功能之前完全一样)。
      if (isLoreCategory(form.category)) {
        body.keys = triggerKeysFromText(form.trigger.keysText);
        body.position = form.trigger.position;
        body.is_char = form.trigger.isChar;
        body.constant = form.trigger.constant;
        body.trigger_mode = triggerModeForSave(form.trigger.isChar, form.trigger.presenceOnly);
        body.fields = form.trigger.fields;
      }
      const url = detailMode === 'new' ? `${base}/api/oc/memories` : `${base}/api/oc/memories/${detailId}`;
      const method = detailMode === 'new' ? 'POST' : 'PUT';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success === false) throw new Error(d?.error || '保存失败');
      const newId = detailMode === 'new' ? d.id : detailId;
      setLastVectorOk(d.vector_ok !== false);
      setListNonce((n) => n + 1);
      setDetailId(newId);
      setDetailMode('view');
      if (newId) await loadDetail(newId);
    } catch (e: any) { setSaveError(e.message || '保存失败'); }
    finally { setSaving(false); }
  }

  function onDeleteClick() {
    if (deleteStage === 0) {
      setDeleteStage(1);
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = setTimeout(() => setDeleteStage(0), 3000);
      return;
    }
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    handleDeleteConfirmed();
  }
  async function handleDeleteConfirmed() {
    setDeleting(true); setDeleteError('');
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/memories/${detailId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success === false) throw new Error(d?.error || '删除失败');
      setListNonce((n) => n + 1);
      setDeleteStage(0);
      navigate(cameFrom);
    } catch (e: any) { setDeleteError(e.message || '删除失败'); setDeleteStage(0); }
    finally { setDeleting(false); }
  }

  // 左廊点别的门:如果正站在打字桌(view==='desk'),先问一句"现在能安全离开吗"——配方切换在飞
  // 时 TypingDesk.requestLeave() 会拦下并把横幅挂在它自己的 deskError 上(此时组件还没被卸载,
  // 横幅出得来),返回 false 就地按兵不动;放行(或者本来就不在写作屏)才真的切门。守卫口径原样
  // 照抄 backToList 那道闸(见 TypingDesk.tsx requestLeave 定义处注释),不是这次新发明的规则。
  // 同门点击(比如生成中误点当前已经高亮的"写作")必须先判掉,不能落进 requestLeave()——那道闸
  // 是"离开这扇窗"专用的,会把飞着的流当场abort、genRef前进,点同门明明哪儿都没去,却把用户正在看
  // 的生成腰斩,user楼落库了还会留半截对不上账。同门=无操作,判断挂在 v===view 上,跟目标门是不是
  // desk 无关(点其它已经在场的门同理不该有副作用,虽然目前只有 desk 会挂 requestLeave 检查,这条
  // 判断放在最前面对所有门都成立)。
  function navigateFromRail(v: View) {
    if (v === view) return;
    if (view === 'desk' && typingDeskRef.current && !typingDeskRef.current.requestLeave()) return;
    navigate(v);
  }

  // "← 家"是离站的另一个出口,跟廊子几扇门共用同一道"写作屏在飞禁离开"的闸:
  // 原来是裸 <a href="/">,写作屏现在常驻可达它,配方 PUT 在飞时点它会绕过 requestLeave 直接
  // 整页卸载,复现"旧配方回显/前后端不一致"的问题。改成 onClick 先 preventDefault,view==='desk'
  // 时跟 navigateFromRail 一样问 requestLeave();拒绝就横幅留人(不跳),放行才真的用
  // location.assign 离站。href="/" 照旧留着(键盘可达性/"新标签页打开"/中键点击这些浏览器原生
  // 语义不因为加了 onClick 而丢,取舍是:中键新开会绕过这道守卫直接开新标签页——那是另一个
  // 浏览环境,不影响当前这扇正在生成的窗,可以接受)。
  function leaveToHome(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault();
    if (view === 'desk' && typingDeskRef.current && !typingDeskRef.current.requestLeave()) return;
    window.location.assign('/');
  }

  return (
    <div className="sty-page" style={{ position: 'relative', boxSizing: 'border-box', background: 'var(--page-bg)', fontFamily: 'var(--font-sans)' }}>
      <style>{RAIL_CSS}</style>
      <div
        className="sty-shell"
        style={{
          position: 'relative', zIndex: 1, background: 'var(--card-bg)',
        }}
      >

        {/* 左廊三扇门——桌面竖排常驻/窄屏顶部横排可滚(响应式全靠上面 RAIL_CSS 的媒体查询,
            这里 JSX 不分支)。"← 家"挪进廊子顶头,几扇门下面跟着,当前门高亮(书架门在 project/detail
            子视图里也算亮,见 isDoorActive)。任何视图下都渲在这里,不会因为切到写作就消失。 */}
        <nav className={`sty-rail${railCollapsed ? ' collapsed' : ''}`} aria-label="书房导览" style={{ background: 'var(--scale-0)' }}>
          <div className="sty-rail-pattern"><HeatBg contained /></div>
          <div className="sty-rail-top">
            <a href="/" onClick={leaveToHome} className="serc sty-rail-btn sty-home" title="回家"><span className="sty-rail-glyph">←</span><span className="sty-rail-label">家</span></a>
            <button type="button" onClick={toggleRail} className="serc sty-rail-btn sty-rail-collapse" aria-label={railCollapsed ? '展开书房侧栏' : '收起书房侧栏'} aria-expanded={!railCollapsed} title={railCollapsed ? '展开侧栏' : '收起侧栏'}>{railCollapsed ? '»' : '«'}</button>
          </div>
          <div className="sty-rail-brand">
            <div className="serc" style={{ fontSize: 19, color: 'var(--ink-deep)', lineHeight: 1.1 }}>书房</div>
            <div className="ser" style={{ fontSize: 9.5, letterSpacing: 2, color: 'var(--ink2)', marginTop: 4 }}>STUDY</div>
          </div>
          <div className="sty-rail-doors">
            {RAIL_DOORS.map((d) => {
              const active = isDoorActive(d.view);
              return (
                <button
                  key={d.view}
                  className={`serc sty-rail-btn${active ? ' active' : ''}`}
                  onClick={() => navigateFromRail(d.view)}
                  style={{
                    border: 0,
                  }}
                >
                  <span className="sty-rail-glyph">{d.icon}</span><span className="sty-rail-label">{d.label}</span>
                </button>
              );
            })}
          </div>
        </nav>

        <div className="sty-main">
        {view === 'desk' ? (
          <TypingDesk ref={typingDeskRef} base={base} envOk={envOk} onBack={() => navigate('shelf')} />
        ) : (
        <div className="sty-scroll">

        {/* ══ 一、书架首页 ══ */}
        {view === 'shelf' && (
          <>
            {/* 语义搜索卡 */}
            <div className="card" style={{ ...cardStyle, padding: '20px 24px', marginBottom: 24 }}>
              <div className="serc" style={{ fontSize: 17, color: 'var(--ink-deep)', marginBottom: 12 }}>语义搜</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <input
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
                  placeholder="想找点什么?比如某个设定、某段剧情…"
                  style={{ ...inputStyle, flex: '1 1 240px' }}
                />
                <button className="serc" onClick={doSearch} disabled={searching || !searchQ.trim()} style={{ ...btnPrimaryStyle, opacity: searching || !searchQ.trim() ? 0.6 : 1 }}>
                  {searching ? '搜索中…' : '语义搜'}
                </button>
              </div>

              {searching && <div style={{ fontSize: 13, color: 'var(--ink2)', marginTop: 14 }}>正在书架间翻找…</div>}
              {!searching && searchError && <div style={{ fontSize: 13, color: '#c2693f', marginTop: 14 }}>搜索翻车了：{searchError}</div>}
              {!searching && !searchError && searchTried && searchResults.length === 0 && (
                <div style={{ fontSize: 13, color: 'var(--ink2)', marginTop: 14 }}>没搜到相关的~换个词试试?</div>
              )}
              {!searching && searchResults.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
                  {searchResults.map((r) => (
                    <div
                      key={r.id}
                      onClick={() => openDetail(r.id, 'shelf')}
                      style={{ borderRadius: 13, padding: '11px 14px', background: 'var(--scale-0)', cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                        <span className="serc" style={{ fontSize: 14.5, color: 'var(--ink-deep)' }}>{r.title}</span>
                        {typeof r.score === 'number' && <span className="mono" style={{ fontSize: 11, color: 'var(--ink2)' }}>score {r.score.toFixed(2)}</span>}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 3 }}>
                        {r.project} · {CATEGORY_LABEL[r.category] || r.category}
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--ink-body)', marginTop: 6, ...clamp2 }}>{r.preview}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* project 书架格子 */}
            <div style={{ marginBottom: 24 }}>
              <div className="serc" style={{ fontSize: 17, color: 'var(--ink-deep)', marginBottom: 14 }}>书架</div>
              {statsLoading ? (
                <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)' }}>正在清点书架…</div>
              ) : statsError ? (
                <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: '#c2693f' }}>书架清点失败：{statsError}</div>
              ) : (
                <>
                  {!stats || Object.keys(stats.by_project).length === 0 ? (
                    <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)', marginBottom: 14 }}>书架还空着~起个项目名，第一个格子就有了：</div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 14 }}>
                      {Object.entries(stats.by_project).map(([project, count]) => (
                        <div
                          key={project}
                          onClick={() => openProject(project)}
                          className="card"
                          style={{ ...cardStyle, padding: '20px 18px', cursor: 'pointer' }}
                        >
                          <div className="serc" style={{ fontSize: 18, color: 'var(--ink-deep)' }}>{project || '未归档'}</div>
                          <div style={{ fontSize: 12.5, color: 'var(--ink2)', marginTop: 8 }}>{count} 册</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 新建项目入口:project 本身没有建档仪式,第一次用哪个名字它就存在——这里只是替
                      空库/新故事把"进格子"这一步摆到门口(进去后「+ 新增」自动带上项目名)。
                      Enter 提交须避让输入法组字(isComposing)。 */}
                  <div style={{ display: 'flex', gap: 8, maxWidth: 420 }}>
                    <input
                      value={newProjName}
                      onChange={(e) => setNewProjName(e.target.value)}
                      onKeyDown={(e) => {
                        // isComposing + keyCode 229 双查(同 TypingDesk isComposingKey 家法):旧 Safari 确认候选词的 Enter 不算提交
                        if ((e.nativeEvent as any).isComposing || (e.nativeEvent as KeyboardEvent).keyCode === 229) return;
                        const p = newProjName.trim();
                        if (e.key === 'Enter' && p) { openProject(p); setNewProjName(''); }
                      }}
                      placeholder="新项目名字…"
                      style={inputStyle}
                    />
                    <button
                      className="serc"
                      onClick={() => { const p = newProjName.trim(); if (p) { openProject(p); setNewProjName(''); } }}
                      style={{ ...btnPrimaryStyle, whiteSpace: 'nowrap', flex: 'none' }}
                    >
                      ＋ 新建项目
                    </button>
                  </div>
                </>
              )}
            </div>

          </>
        )}

        {/* ══ 读书角(章节工坊并入,读书角自己的主tab受这边控制,好让 URL/plot门跳转都能指哪打哪) ══ */}
        {view === 'reading' && (
          <ReadingCorner
            base={base}
            envOk={envOk}
            mainTab={readingTab}
            onMainTabChange={setReadingTab}
            chaptersProject={readingProject}
            onChaptersProjectChange={setReadingProject}
            projectOptions={projectOptions}
          />
        )}

        {/* ══ 二、项目视图 ══ */}
        {view === 'project' && currentProject !== null && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
              <button className="serc" onClick={backToShelf} style={pillStyle}>← 返回书架</button>
              <span className="serc" style={{ fontSize: 20, color: 'var(--ink-deep)' }}>{currentProject || '未归档'}</span>
              <button className="serc" onClick={openNew} style={{ ...btnPrimaryStyle, marginLeft: 'auto' }}>+ 新增</button>
            </div>

            {/* 分类 tab(「剧情总结」已从这一行摘走,见 PROJECT_TABS 上方注释) */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              {PROJECT_TABS.map((c) => {
                const active = c.key === currentCategory;
                return (
                  <button
                    key={c.key}
                    className="serc"
                    onClick={() => setCurrentCategory(c.key)}
                    style={{
                      ...pillStyle,
                      background: active ? 'var(--scale-3)' : 'var(--card-bg)',
                      color: active ? 'var(--card-bg)' : 'var(--ink-body)',
                      border: active ? '1px solid transparent' : '1px solid var(--line-soft)',
                    }}
                  >
                    {c.label}{active && listCount != null ? `(${listCount})` : ''}
                  </button>
                );
              })}
            </div>

            {/* 剧情总结传送卡片:明写着"这东西不住在书架,点了要走一趟"——原来它伪装成分类 tab,
                点下去人就被传送走还不知道自己去了哪儿。虚线+箭头是这一仓"这不是本地内容"的既有语汇
                (glassCardStyle 同款)。*/}
            <div
              onClick={() => jumpToChaptersStudio(currentProject)}
              className="card"
              style={{ ...glassCardStyle, padding: '13px 18px', marginBottom: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
            >
              <span className="serc" style={{ fontSize: 14, color: 'var(--ink-deep)' }}>剧情总结</span>
              <span style={{ fontSize: 12, color: 'var(--ink2)' }}>不在书架上——按章存在读书角·章节工房</span>
              <span className="serc" style={{ fontSize: 12.5, color: 'var(--accent)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>去章节工房 →</span>
            </div>

            {/* 关键词搜索 + 排序小开关 */}
            <div style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="在这一格里搜关键词…"
                style={{ ...inputStyle, maxWidth: 360 }}
              />
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--ink2)' }}>排序</span>
                {([['time', '时间'], ['chapter', '章节'], ['title', '标题']] as const).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setSortOrder(k)}
                    style={{
                      fontSize: 12, padding: '5px 12px', borderRadius: 20, cursor: 'pointer',
                      background: sortOrder === k ? 'var(--scale-2)' : 'var(--card-bg)',
                      color: sortOrder === k ? 'var(--card-bg)' : 'var(--ink2)',
                      border: sortOrder === k ? '1px solid transparent' : '1px solid var(--line-soft)',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* 卡片列表 */}
            {listLoading ? (
              <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)' }}>正在翻这一格…</div>
            ) : listError ? (
              <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: '#c2693f' }}>翻不开：{listError}</div>
            ) : listItems.length === 0 ? (
              <div className="card" style={{ ...glassCardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)' }}>这一格还空着~</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
                {listItems.map((it) => (
                  <div
                    key={it.id}
                    onClick={() => openDetail(it.id, 'project')}
                    className="card"
                    style={{ ...cardStyle, padding: '16px 18px', cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                      <span className="serc" style={{ fontSize: 15, color: 'var(--ink-deep)' }}>{it.title}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--ink2)', flex: 'none' }}>{fmtMD(it.created_at)}</span>
                    </div>
                    {it.chapter && <div style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 4 }}>{it.chapter}</div>}
                    <div style={{ fontSize: 12.5, color: 'var(--ink-body)', marginTop: 8, ...clamp2 }}>{it.preview}</div>
                    {it.tags && it.tags.length > 0 && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                        {it.tags.map((t) => (
                          <span key={t} style={{ fontSize: 11, color: 'var(--ink2)', background: 'var(--scale-0)', borderRadius: 20, padding: '3px 10px' }}>{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ══ 三、详情 / 编辑 / 新增 ══ */}
        {view === 'detail' && (
          <div className="card" style={{ ...cardStyle, padding: '24px 28px' }}>
            {detailMode === 'new' ? (
              // 新增表单
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
                  <button className="serc" onClick={() => navigate(cameFrom)} style={pillStyle}>← 返回</button>
                  <span className="serc" style={{ fontSize: 18, color: 'var(--ink-deep)' }}>新增一条</span>
                </div>
                <EditForm form={form} setForm={setForm} projectOptions={projectOptions} />
                {saveError && <div style={{ fontSize: 13, color: '#c2693f', marginTop: 12 }}>保存失败：{saveError}</div>}
                <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                  <button className="serc" onClick={handleSave} disabled={saving} style={{ ...btnPrimaryStyle, opacity: saving ? 0.6 : 1 }}>{saving ? '保存中…' : '保存'}</button>
                  <button className="serc" onClick={cancelEdit} style={pillStyle}>取消</button>
                </div>
              </>
            ) : detailLoading ? (
              <div style={{ fontSize: 13, color: 'var(--ink2)' }}>正在翻这一页…</div>
            ) : detailError ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                  <button className="serc" onClick={backFromDetail} style={pillStyle}>← 返回</button>
                </div>
                <div style={{ fontSize: 13, color: '#c2693f' }}>翻不开：{detailError}</div>
              </>
            ) : !detail ? null : detailMode === 'edit' ? (
              // 编辑表单
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
                  <button className="serc" onClick={cancelEdit} style={pillStyle}>← 取消</button>
                  <span className="serc" style={{ fontSize: 18, color: 'var(--ink-deep)' }}>编辑</span>
                </div>
                <EditForm form={form} setForm={setForm} projectOptions={projectOptions} />
                {saveError && <div style={{ fontSize: 13, color: '#c2693f', marginTop: 12 }}>保存失败：{saveError}</div>}
                <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                  <button className="serc" onClick={handleSave} disabled={saving} style={{ ...btnPrimaryStyle, opacity: saving ? 0.6 : 1 }}>{saving ? '保存中…' : '保存'}</button>
                  <button className="serc" onClick={cancelEdit} style={pillStyle}>取消</button>
                </div>
              </>
            ) : (
              // 读模式
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
                  <button className="serc" onClick={backFromDetail} style={pillStyle}>← 返回</button>
                  {/* 剧情总结已经改吃章节架(oc_chapters),这条是旧架子的存货——不给编辑入口,
                      防止绕开 ChaptersStudio 继续往旧表里写(全局语义搜也可能搜到这条,同一道闸)。*/}
                  {detail.category !== 'plot' && (
                    <button className="serc" onClick={startEdit} style={pillStyle}>编辑</button>
                  )}
                  <button
                    className="serc"
                    onClick={onDeleteClick}
                    disabled={deleting}
                    style={{ ...pillStyle, color: deleteStage === 1 ? '#fffdf5' : '#c2693f', background: deleteStage === 1 ? '#c2693f' : 'var(--card-bg)', opacity: deleting ? 0.6 : 1 }}
                  >
                    {deleting ? '删除中…' : deleteStage === 1 ? '真的删?再点一次' : '删除'}
                  </button>
                  {deleteError && <span style={{ fontSize: 12.5, color: '#c2693f' }}>{deleteError}</span>}
                </div>

                <div className="serc" style={{ fontSize: 22, color: 'var(--ink-deep)' }}>{detail.title}</div>
                <div style={{ fontSize: 12.5, color: 'var(--ink2)', marginTop: 6 }}>
                  {detail.project} · {CATEGORY_LABEL[detail.category] || detail.category}
                  {detail.chapter ? ` · ${detail.chapter}` : ''}
                </div>
                {detail.category === 'plot' && (
                  <div style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 8 }}>
                    这条来自旧的「剧情总结」架子（只读），新的编年摘要请去读书角·章节工房
                  </div>
                )}
                {detail.tags && detail.tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                    {detail.tags.map((t) => (
                      <span key={t} style={{ fontSize: 11.5, color: 'var(--ink2)', background: 'var(--scale-0)', borderRadius: 20, padding: '3px 10px' }}>{t}</span>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: 'var(--ink2)', marginTop: 10 }}>
                  {fmtMD(detail.created_at)} 写下 · {fmtMD(detail.updated_at)} 最后改动
                </div>

                {lastVectorOk === false && (
                  <div style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 10 }}>这条暂时搜不到(向量没跟上),回头 backfill 补</div>
                )}

                <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--line-soft)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word', fontSize: 14, color: 'var(--ink-body)', lineHeight: 1.8 }}>
                  {detail.content || <span style={{ color: 'var(--ink2)' }}>(还没写内容)</span>}
                </div>
              </>
            )}
          </div>
        )}

        </div>
        )}
        </div>
      </div>
    </div>
  );
}

// ── project 选择用下拉而非自由文本——手打容易打出跟已有 project 不完全一致的新词,导致内容
// 分散到多个同义的项目名下、互相找不到。默认列出已有 project(去重排序),选中最后一项
// "＋新建项目…"才切换成文本框允许输入新名字,不砍掉新建能力。
// 不新增后端接口——选项源用这个页面本来就拿在手里的 stats.by_project(书架统计,进门就拉过)。
const NEW_PROJECT_OPTION = '__new_project__';
function ProjectField({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  // 回显优先(家规:原有默认值/回显行为要保持)——当前值不在候选源里(stats没跟上/历史脏数据这类
  // 边角)也要把它塞进选项最前面,不能让编辑态一进来就"选中值消失"。
  const merged = !value || options.includes(value) ? options : [value, ...options];
  const [manual, setManual] = useState(false);
  if (manual) {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="新项目名字" style={inputStyle} autoFocus />
        <button type="button" onClick={() => setManual(false)} className="serc" style={{ fontSize: 11.5, color: 'var(--ink2)', background: 'none', border: 'none', cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap' }}>
          选现有
        </button>
      </div>
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value === NEW_PROJECT_OPTION) { setManual(true); onChange(''); return; }
        onChange(e.target.value);
      }}
      style={{ ...inputStyle, cursor: 'pointer' }}
    >
      {!value && <option value="">请选择…</option>}
      {merged.map((p) => <option key={p} value={p}>{p}</option>)}
      <option value={NEW_PROJECT_OPTION}>＋新建项目…</option>
    </select>
  );
}

// ── 编辑/新增共用表单(供上面 detail 视图的 edit/new 两态复用) ──
function EditForm({ form, setForm, projectOptions }: { form: any; setForm: (f: any) => void; projectOptions: string[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--ink2)', marginBottom: 5 }}>标题</div>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={inputStyle} />
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--ink2)', marginBottom: 5 }}>分类</div>
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ ...inputStyle, cursor: 'pointer' }}>
            {FORM_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--ink2)', marginBottom: 5 }}>项目</div>
          <ProjectField value={form.project} onChange={(v) => setForm({ ...form, project: v })} options={projectOptions} />
        </div>
        <div>
          <div style={{ fontSize: 12, color: 'var(--ink2)', marginBottom: 5 }}>章节(可空)</div>
          <input value={form.chapter} onChange={(e) => setForm({ ...form, chapter: e.target.value })} style={inputStyle} />
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--ink2)', marginBottom: 5 }}>标签(逗号分隔)</div>
        <input value={form.tagsText} onChange={(e) => setForm({ ...form, tagsText: e.target.value })} placeholder="比如: 主角, 时间线, 关键道具" style={inputStyle} />
      </div>
      {isLoreCategory(form.category) && (
        <div>
          <div style={{ fontSize: 12, color: 'var(--ink2)', marginBottom: 5 }}>
            进场方式<span style={{ marginLeft: 6, opacity: 0.8, fontSize: 11 }}>这本书什么时候被塞进剧本——跟打字桌·世界书面板是同一份配置</span>
          </div>
          <LoreTriggerFields value={form.trigger} onChange={(patch) => setForm({ ...form, trigger: { ...form.trigger, ...patch } })} />
        </div>
      )}
      <div>
        <div style={{ fontSize: 12, color: 'var(--ink2)', marginBottom: 5 }}>正文</div>
        <textarea
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          rows={16}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-sans)', lineHeight: 1.7 }}
        />
      </div>
    </div>
  );
}
