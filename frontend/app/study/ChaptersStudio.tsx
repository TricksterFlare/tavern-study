'use client';

// 章节工房——篇章总结唯一的写入口,直接读写章节表(oc_chapters),不再往 study 条目里塞编年梗概。
//
// 字段语义(gist检索键+全文注入体双层)：
//   content(正文)=整篇篇章总结,是打字桌常驻/召回注入剧本的本体,也是读书角阅读页展示的正文——这一栏的主字段。
//   summary(gist) =200字级浓缩检索键,只喂嵌入器算坐标,可选:不填时嵌入器自动用正文头部,别当成"摘要=正文"。
// fetch 全 try/catch,先读 body 再判断(res.ok && d.success 双验,别在读 body 前就先扔),
// 变更类请求收紧到 success===true 才算数,读类放宽到 success!==false。

import { useState, useEffect, useRef } from 'react';

type ChapterRow = {
  id: string;
  project: string;
  chapter_no?: string | number | null;
  title: string;
  summary?: string | null; // gist,可选检索键(不截断,列表接口原样返回)
  preview?: string; // 正文(content)前若干字,服务端 chaptersList 已经截好——列表行预览用这个,不用 summary
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
  published_at?: string | null;
};

// ── 卡片风格小料(与 page.tsx/ReadingCorner.tsx 同款数值,组件独立成文件故各自留一份) ──
const cardStyle: React.CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--line-soft)', borderRadius: 22, boxShadow: '0 6px 18px var(--card-shadow)',
};
const pillStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, color: 'var(--ink2)',
  background: 'var(--card-bg)', border: '1px solid var(--line-soft)', padding: '7px 16px', borderRadius: 30,
  cursor: 'pointer', textDecoration: 'none', fontFamily: 'inherit',
};
const btnPrimaryStyle: React.CSSProperties = {
  fontSize: 13, color: 'var(--card-bg)', background: 'var(--accent)', border: 'none',
  padding: '9px 18px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit',
};
const inputStyle: React.CSSProperties = {
  fontSize: 13.5, color: 'var(--ink-body)', background: 'var(--card-bg)', border: '1px solid var(--line-soft)',
  borderRadius: 12, padding: '9px 14px', fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--ink2)', marginBottom: 5 };
const errStyle: React.CSSProperties = { fontSize: 12.5, color: '#c2693f', marginTop: 8 };
const hintStyle: React.CSSProperties = { fontSize: 11.5, color: 'var(--ink2)', marginTop: 4 };
const clamp2: React.CSSProperties = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
// 触顶横幅:静默截断=故障,必须亮说;同色沿用 errStyle 的警示红,别用新色号
const warnBannerStyle: React.CSSProperties = {
  fontSize: 12.5, color: '#c2693f', background: 'rgba(194,105,63,0.1)',
  border: '1px solid rgba(194,105,63,0.35)', borderRadius: 14, padding: '10px 16px', marginBottom: 12,
};

// 章节列表 fetch 的实际生效 limit:服务端有硬钳制(reading.ts chaptersList 钳 CHAPTERS_LIST_MAX=200),
// 请求更大的 limit 也会被悄悄砍回 200,不如前端自己就按实际生效值来,方便下面"返回条数===请求limit"
// 的触顶判断对得上。全套游标分页留到真正需要时再加(章=篇章粒度,一年几十章,离触顶还早)。
const CHAPTERS_FETCH_LIMIT = 200;

function fmtMD(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch { return iso; }
}

// 章节号自然排序(手搓比较器,同 reading.ts naturalCompare 一个思路——运行环境的 ICU 裁剪版对
// localeCompare 的 numeric 选项不可靠;这里前端只管升序展示,空章节号沉底)
function naturalCompareChapterNo(a?: string | number | null, b?: string | number | null): number {
  const as = String(a ?? '').trim(), bs = String(b ?? '').trim();
  if (!as && !bs) return 0;
  if (!as) return 1;
  if (!bs) return -1;
  const seg = (s: string) => s.match(/\d+|\D+/g) || [];
  const xs = seg(as), ys = seg(bs);
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i], y = ys[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// 新建章节默认章号=当前项目已有章节里最大数字段+1(非数字/空章号不计入,取不到就从1开始)。
// capped=true(列表触顶,没拉全):算出来的 max 可能不是真 max,悄悄给个号很可能撞号——
// 宁可留空逼她自己填,也不要一个看着正常实则可能错的默认值。
function nextChapterNo(rows: ChapterRow[], capped: boolean): string {
  if (capped) return '';
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.chapter_no ?? '').trim(), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

export default function ChaptersStudio({ base, envOk, project, onEditorOpenChange }: {
  base: string; envOk: boolean; project: string;
  // 编辑器开着时报给外层(读书角):它头上那个项目选择器要锁住。理由见下面 [project] effect 那段
  // ——项目一换,这里的草稿就会被写进别的项目。
  onEditorOpenChange?: (open: boolean) => void;
}) {
  // ── 章节架列表 ──
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [chaptersHitCap, setChaptersHitCap] = useState(false); // 返回条数=请求limit=服务端可能还有没拉到的,别装没事
  // 请求令牌:连续发布/编辑/删除会并发打出多趟刷新,先发后至的旧响应不能覆盖新状态——
  // 照本仓 DeskDrawers.tsx presetsSeqRef 同款家法,用令牌不用 AbortController,提交前核对 tok 还新鲜。
  const chaptersSeqRef = useRef(0);

  useEffect(() => {
    if (!envOk) { setListError('环境变量没配好'); setLoading(false); return; }
    setLoading(true); setListError('');
    const tok = ++chaptersSeqRef.current;
    (async () => {
      try {
        const qs = new URLSearchParams({ project, limit: String(CHAPTERS_FETCH_LIMIT) }); // 不传 status:草稿+已发布都要看
        const res = await fetch(`${base}/api/oc/chapters?${qs.toString()}`);
        const d = await res.json().catch(() => null);
        if (!res.ok || !d || d.success === false) throw new Error(d?.error || `HTTP ${res.status}`);
        if (tok !== chaptersSeqRef.current) return; // 令牌过期:更新的一次加载已经在路上,这份旧响应作废
        const rows: ChapterRow[] = Array.isArray(d.chapters) ? d.chapters : [];
        rows.sort((a, b) => naturalCompareChapterNo(a.chapter_no, b.chapter_no));
        setChapters(rows);
        setChaptersHitCap(rows.length === CHAPTERS_FETCH_LIMIT);
      } catch (e: any) {
        if (tok !== chaptersSeqRef.current) return;
        setListError(e.message || '章节架翻不开'); setChapters([]); setChaptersHitCap(false);
      } finally {
        if (tok === chaptersSeqRef.current) setLoading(false);
      }
    })();
  }, [base, envOk, project, nonce]);

  // ── 新建 ── content(正文/篇章总结)=主字段,summary(检索gist)=可选副字段
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState({ title: '', chapter_no: '', content: '', summary: '' });
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');

  function openCreate() {
    setNewForm({ title: '', chapter_no: nextChapterNo(chapters, chaptersHitCap), content: '', summary: '' });
    setCreateError('');
    setCreating(true);
  }
  async function handleCreate() {
    const title = newForm.title.trim();
    if (!title) { setCreateError('标题不能空着'); return; }
    const content = newForm.content.trim();
    if (!content) { setCreateError('篇章总结(正文)不能空着——这是打字桌和读书角实际显示的内容'); return; }
    setCreateBusy(true); setCreateError('');
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const body = { project, title, chapter_no: newForm.chapter_no.trim(), content, summary: newForm.summary.trim() };
      const res = await fetch(`${base}/api/oc/chapters`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '新建失败(服务端没确认成功)');
      setCreating(false);
      setNonce((n) => n + 1);
    } catch (e: any) { setCreateError(e.message || '新建失败'); }
    finally { setCreateBusy(false); }
  }

  // ── 行内编辑(标题/章号/正文/gist)── 列表行不带全文 content(chaptersList 只给截断 preview),
  //   开编辑先拉一次 GET /api/oc/chapters/:id 取完整正文,再落进编辑表单。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ title: '', chapter_no: '', content: '', summary: '' });
  const [editLoading, setEditLoading] = useState(false);
  const [editLoadError, setEditLoadError] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');

  // 详情请求令牌:先点A行再点B行,先回来的响应会填错表单甚至保存到别的章上——
  // editingIdRef 是"当前真身"的活值镜像,在每个改动 editingId 的地方手动同步(不靠 useEffect 追,
  // 效果要等下一轮渲染才落地,跟异步响应落地的时机赛跑会有一拍延迟的空隙,不如原地写同步)。
  // editLoadingRef 只在 nonce 效果里读一下"要不要顺手收起来",给 useEffect 同步足够安全。
  const editSeqRef = useRef(0);
  const editingIdRef = useRef<string | null>(null);
  const editLoadingRef = useRef(false);
  useEffect(() => { editLoadingRef.current = editLoading; }, [editLoading]);

  // 切项目:旧项目那行的编辑态/在途详情请求(不管是在加载还是在保存)跟着作废——新项目的列表里
  // 八成压根没有这一行,这里是无条件全收,editBusy 也在内(不然一个被判废的保存会把 busy 卡死)。
  //
  // 新建态也要收:「新建章节」填了一半正文不保存,拿工房头上那个项目选择器切到别的项目,编辑器
  // 和内容原样留着,再点保存就写进了新项目(handleCreate 用的是当下的 project prop)。两层一起堵:
  // ①外层读书角在编辑器开着时把项目选择器锁住(onEditorOpenChange,正常路径下切不动);②这里补上
  // 新建态的清理当最后一道——真被别的路径把 project 换掉了,宁可丢这份还没保存的草稿,也绝不把它
  // 写进错误的项目。createBusy 不碰:POST 在飞时 body 里的 project 是点击那一刻闭包里的旧值(是对
  // 的),busy 归 handleCreate 自己的 finally 释放,这里不越权。
  useEffect(() => {
    editSeqRef.current++;
    editingIdRef.current = null;
    setEditingId(null); setEditLoading(false); setEditLoadError(''); setEditError(''); setEditBusy(false);
    setCreating(false); setNewForm({ title: '', chapter_no: '', content: '', summary: '' }); setCreateError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // 列表整体刷新(nonce,来自别的行发布/删除/保存,也可能是这一行自己保存成功触发的):
  // 只在"详情还没加载完、表单里没有她的字"这个无损窗口里顺手让令牌过期+收起编辑态——
  // 一旦 editForm 已经落地(可能正在打字)或正在保存(editBusy),绝不能因为别的行动了一下就
  // 把这里的令牌一并作废,否则会把 saveRowEdit 自己合法在飞的那次保存误判成"过期响应"晾成
  // 永久 busy——保存/切项目/取消/开新行编辑各自的令牌保护已经够了。
  useEffect(() => {
    if (editLoadingRef.current) {
      editSeqRef.current++;
      editingIdRef.current = null;
      setEditingId(null); setEditLoading(false); setEditLoadError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);

  async function startRowEdit(c: ChapterRow) {
    if (editBusy) return; // 互斥家法:别的行保存在飞时,这颗"编辑"入口连点都不该生效(配合下面按钮 disabled)
    const tok = ++editSeqRef.current;
    editingIdRef.current = c.id;
    setEditingId(c.id);
    setEditForm({ title: c.title || '', chapter_no: c.chapter_no != null ? String(c.chapter_no) : '', content: '', summary: '' });
    setEditError(''); setEditLoadError(''); setEditBusy(false); // 新开一行的编辑会话,清掉上一行可能遗留的 busy
    setEditLoading(true);
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/chapters/${c.id}`);
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success === false) throw new Error(d?.error || '这一章翻不出来');
      // 响应可能是 {success,chapter:{...}} 包裹形,也可能是拍平的:两种都归一化,
      // 再验 id 对得上这次请求的章、关键字段是字符串,不对就当翻车,别拿别章的内容填表单。
      const ch = d.chapter || d;
      if (!ch || typeof ch.id !== 'string' || ch.id !== c.id || typeof ch.title !== 'string') {
        throw new Error('这一章的详情格式不对(id或标题缺失),没法编辑');
      }
      // 字段类型逐项硬验,schema漂移就明说翻车,绝不用空串/String()悄悄掩盖——
      // 空串会把她原有的摘要看着"清空了",String(奇怪对象)会把章号变成"[object Object]"糊过去。
      if (typeof ch.content !== 'string') {
        throw new Error('这一章的正文字段格式不对(不是字符串),没法编辑');
      }
      if (ch.summary !== undefined && ch.summary !== null && typeof ch.summary !== 'string') {
        throw new Error('这一章的检索gist字段格式不对(不是字符串),没法编辑');
      }
      if (ch.chapter_no !== undefined && ch.chapter_no !== null && typeof ch.chapter_no !== 'string' && typeof ch.chapter_no !== 'number') {
        throw new Error('这一章的章号字段格式不对,没法编辑');
      }
      if (tok !== editSeqRef.current || editingIdRef.current !== c.id) return; // 令牌/行身份任一过期,这份响应作废
      setEditForm({
        title: ch.title,
        chapter_no: ch.chapter_no != null ? String(ch.chapter_no) : '',
        content: ch.content,
        summary: typeof ch.summary === 'string' ? ch.summary : '',
      });
    } catch (e: any) {
      if (tok !== editSeqRef.current || editingIdRef.current !== c.id) return;
      setEditLoadError(e.message || '这一章翻不出来');
    } finally {
      if (tok === editSeqRef.current && editingIdRef.current === c.id) setEditLoading(false);
    }
  }
  function cancelRowEdit() {
    if (editBusy) return; // 互斥家法(handler层兜底):保存在飞时取消钮就该是死的,按钮 disabled 之外再挡一道
    editSeqRef.current++; // 作废任何还在飞的详情请求
    editingIdRef.current = null;
    setEditingId(null); setEditLoading(false); setEditError(''); setEditLoadError('');
  }
  // 保存链路要同一套令牌闸:A保存中途若被"取消→开B的编辑"抢跑,A的PUT迟到成功
  // 会无条件 setEditingId(null)+刷列表,把B刚开的编辑面板(可能还没保存的输入)一起关掉。
  // 现在挡两层:①UI+handler双闸禁用取消钮/别行编辑入口(正常路径下这段时序物理走不到)
  // ②依然复用 editSeqRef+editingIdRef 令牌(兜切项目/组件卸载这类不受"禁用按钮"约束的竞态)。
  async function saveRowEdit(id: string) {
    const title = editForm.title.trim();
    if (!title) { setEditError('标题不能空着'); return; }
    const content = editForm.content.trim();
    if (!content) { setEditError('篇章总结(正文)不能空着——这是打字桌和读书角实际显示的内容'); return; }
    const tok = ++editSeqRef.current; // 保存也占一个令牌世代:期间任何切项目/取消/开新行编辑都会让这次收尾作废
    setEditBusy(true); setEditError('');
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const body = { title, chapter_no: editForm.chapter_no.trim(), content, summary: editForm.summary.trim() };
      const res = await fetch(`${base}/api/oc/chapters/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '保存失败(服务端没确认成功)');
      if (tok !== editSeqRef.current || editingIdRef.current !== id) return; // 令牌/行身份任一过期:早不是这一行了,别替它收尾
      editingIdRef.current = null;
      setEditingId(null);
      setNonce((n) => n + 1);
    } catch (e: any) {
      if (tok !== editSeqRef.current || editingIdRef.current !== id) return;
      setEditError(e.message || '保存失败');
    } finally {
      // busy释放只看令牌不看行身份:成功分支自己刚把editingIdRef清成null,再要求
      // "仍等于id"就永远放不掉busy——存一次全桌编辑锁死。令牌仍是当前世代=这次保存仍拥有busy的
      // 所有权,该它释放;令牌过期=切项目等重置路径已经接管busy,这里不越权乱碰。
      if (tok === editSeqRef.current) setEditBusy(false);
    }
  }

  // ── 发布/撤稿 ──
  const [pubBusyId, setPubBusyId] = useState<string | null>(null);
  const [pubError, setPubError] = useState<Record<string, string>>({});
  async function togglePublish(c: ChapterRow) {
    const action = c.status === 'published' ? 'unpublish' : 'publish';
    setPubBusyId(c.id);
    setPubError((s) => ({ ...s, [c.id]: '' }));
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/chapters/${c.id}/${action}`, { method: 'POST' });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || `${action === 'publish' ? '发布' : '撤稿'}失败(服务端没确认成功)`);
      setNonce((n) => n + 1);
    } catch (e: any) { setPubError((s) => ({ ...s, [c.id]: e.message || '操作失败' })); }
    finally { setPubBusyId(null); }
  }

  // ── 删除(两段确认) ──
  const [delStage, setDelStage] = useState<Record<string, 0 | 1>>({});
  const delTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [delBusyId, setDelBusyId] = useState<string | null>(null);
  const [delError, setDelError] = useState<Record<string, string>>({});

  function onDeleteClick(id: string) {
    const stage = delStage[id] || 0;
    if (stage === 0) {
      setDelStage((s) => ({ ...s, [id]: 1 }));
      if (delTimers.current[id]) clearTimeout(delTimers.current[id]);
      delTimers.current[id] = setTimeout(() => setDelStage((s) => ({ ...s, [id]: 0 })), 3000);
      return;
    }
    if (delTimers.current[id]) clearTimeout(delTimers.current[id]);
    handleDelete(id);
  }
  async function handleDelete(id: string) {
    setDelBusyId(id); setDelError((s) => ({ ...s, [id]: '' }));
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/chapters/${id}`, { method: 'DELETE' });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d || d.success !== true) throw new Error(d?.error || '删除失败(服务端没确认成功)');
      setDelStage((s) => ({ ...s, [id]: 0 }));
      if (editingId === id) setEditingId(null);
      setNonce((n) => n + 1);
    } catch (e: any) {
      setDelError((s) => ({ ...s, [id]: e.message || '删除失败' }));
      setDelStage((s) => ({ ...s, [id]: 0 }));
    } finally { setDelBusyId(null); }
  }

  // 编辑器视图:多行 textarea 写几千字的篇章总结体验很差,所以新建/编辑都占满整个章节工房,
  // 不再挤在列表行里。editingId 优先于 creating(两者由结构保证互斥:「+ 新建章节」钮只在
  // 列表视图渲染,行「编辑」钮也只在列表视图渲染,进了编辑器就都看不见了)。
  const editorOpen = editingId !== null || creating;
  // 报给外层锁项目选择器(见上面 [project] effect 那段)。卸载时清 false,不留幽灵锁。
  useEffect(() => {
    onEditorOpenChange?.(editorOpen);
    return () => onEditorOpenChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorOpen]);
  // 状态徽章要用的那一行(列表刷新后这一行可能已经不在了——徽章可选,不拿它当渲染前提)
  const editingRow = editingId !== null ? chapters.find((c) => c.id === editingId) : undefined;
  // 新建与编辑共用同一副表单外壳,但底下仍是各自那份 state / 各自那条已审过的保存链路——
  // 这里只统一渲染,一条逻辑都不合并(newForm/editForm 字段形状本来就一样)。
  const isNew = editingId === null;
  const f = isNew ? newForm : editForm;
  const setF = isNew ? setNewForm : setEditForm;
  const formBusy = isNew ? createBusy : editBusy;
  const formError = isNew ? createError : editError;

  return (
    <>
      {editorOpen ? (
        /* ══════════ 编辑器视图 ══════════
           编辑/新建时整个章节工房让位给编辑器,给正文足够的书写空间。
           「发布/撤稿」故意只留在列表行上,不进编辑器:"发布前必须先保存"这条规则在这里是靠结构
           成立的——编辑器开着时列表压根不渲染,发布物理上够不着;要发布必须先保存收工回列表。
           加一颗发布钮就得把这条规则重新手写一遍,不如不给,省下一处容易和列表行实现走岔的分支。 */
        <div className="card" style={{ ...cardStyle, padding: '20px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <button
              className="serc"
              onClick={isNew ? () => setCreating(false) : cancelRowEdit}
              disabled={formBusy}
              style={{ ...pillStyle, opacity: formBusy ? 0.6 : 1 }}
            >
              {formBusy ? '保存中,先别走…' : '← 返回章节架'}
            </button>
            <span className="serc" style={{ fontSize: 17, color: 'var(--ink-deep)' }}>{isNew ? '新建一章' : '编辑章节'}</span>
            {!isNew && editingRow && (
              <span style={{ fontSize: 11.5, color: 'var(--card-bg)', background: editingRow.status === 'published' ? 'var(--scale-3)' : 'var(--ink2)', borderRadius: 20, padding: '2px 12px' }}>
                {editingRow.status === 'published' ? '已发布' : '草稿'}
              </span>
            )}
          </div>

          {!isNew && editLoading ? (
            <div style={{ fontSize: 13, color: 'var(--ink2)' }}>正在翻这一章的正文…</div>
          ) : !isNew && editLoadError ? (
            <div style={errStyle}>翻不开：{editLoadError}</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
                <div>
                  <div style={labelStyle}>章号</div>
                  <input
                    value={f.chapter_no}
                    onChange={(e) => setF({ ...f, chapter_no: e.target.value })}
                    placeholder={isNew && chaptersHitCap ? '列表没拉全,自己填章号' : undefined}
                    style={inputStyle}
                  />
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <div style={labelStyle}>标题</div>
                  <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={inputStyle} />
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                <div style={labelStyle}>篇章总结(正文)</div>
                <textarea
                  value={f.content}
                  onChange={(e) => setF({ ...f, content: e.target.value })}
                  rows={20}
                  placeholder="这一章完整发生了什么——打字桌常驻记忆和读书角阅读页都显示这一栏"
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-sans)', lineHeight: 1.8, minHeight: '50vh' }}
                />
              </div>
              <div style={{ marginTop: 14 }}>
                <div style={labelStyle}>检索gist(可选)</div>
                <textarea
                  value={f.summary}
                  onChange={(e) => setF({ ...f, summary: e.target.value })}
                  rows={3}
                  placeholder="200字浓缩“这篇讲了什么”——写了检索更准,不写就用正文开头"
                  style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-sans)', lineHeight: 1.7 }}
                />
                <div style={hintStyle}>
                  {isNew ? '新建先落草稿,回章节架再点「发布」才进打字桌记忆和读书角。' : '存好回章节架,那边点「发布/撤稿」。'}
                  保存后检索坐标自动更新,不用手动处理。
                </div>
              </div>
              {formError && <div style={errStyle}>{formError}</div>}
              <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
                <button
                  className="serc"
                  onClick={isNew ? handleCreate : () => saveRowEdit(editingId as string)}
                  disabled={formBusy}
                  style={{ ...btnPrimaryStyle, opacity: formBusy ? 0.6 : 1 }}
                >
                  {isNew ? (createBusy ? '新建中…' : '保存为草稿') : (editBusy ? '保存中…' : '保存')}
                </button>
                {/* 保存在飞时取消钮禁用(UI层)——handler 里 cancelRowEdit 也挡了一道,双闸 */}
                <button
                  className="serc"
                  onClick={isNew ? () => setCreating(false) : cancelRowEdit}
                  disabled={formBusy}
                  style={{ ...pillStyle, opacity: formBusy ? 0.6 : 1 }}
                >
                  {formBusy ? '保存中,先别取消…' : '取消'}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
      <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12.5, color: 'var(--ink2)', maxWidth: 560 }}>
          章节架按章号排序。「篇章总结」正文是打字桌常驻记忆和读书角阅读页真正显示的内容;检索gist可选,不填就用正文开头当检索坐标。保存后检索坐标自动更新。
        </div>
        <button className="serc" onClick={openCreate} style={btnPrimaryStyle}>+ 新建章节</button>
      </div>

      {/* 触顶横幅:静默截断=故障,返回条数打到 CHAPTERS_FETCH_LIMIT 就得亮说,
          不能让她以为"这就是全部章节"(全套游标分页留到真正需要时再加) */}
      {chaptersHitCap && !loading && !listError && (
        <div style={warnBannerStyle}>⚠️ 章节太多,这页只拉到了前 {CHAPTERS_FETCH_LIMIT} 条,可能没显示全——后续需要时再加分页支持</div>
      )}

      {loading ? (
        <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)' }}>正在翻章节架…</div>
      ) : listError ? (
        <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: '#c2693f' }}>翻不开：{listError}</div>
      ) : chapters.length === 0 ? (
        <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)' }}>这个项目还没有章节~点上面「+ 新建章节」写第一章的篇章总结</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {chapters.map((c) => (
            <div key={c.id} className="card" style={{ ...cardStyle, padding: '16px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {c.chapter_no != null && c.chapter_no !== '' && <span style={{ fontSize: 12, color: 'var(--ink2)' }}>第{c.chapter_no}章</span>}
                    <span className="serc" style={{ fontSize: 15.5, color: 'var(--ink-deep)' }}>{c.title}</span>
                    <span style={{ fontSize: 11, color: 'var(--card-bg)', background: c.status === 'published' ? 'var(--scale-3)' : 'var(--ink2)', borderRadius: 20, padding: '2px 10px' }}>
                      {c.status === 'published' ? '已发布' : '草稿'}
                    </span>
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--ink2)', flex: 'none' }}>{fmtMD(c.updated_at)} 改过</span>
                </div>

                {/* 列表行预览=正文(content)前若干字,服务端 chaptersList 已经截好放在 preview 字段——
                    别显示 summary,那是可选检索gist,不是"这一章讲了什么"的可读预览 */}
                <div style={{ fontSize: 12.5, color: 'var(--ink-body)', marginTop: 8, ...clamp2 }}>
                  {c.preview || <span style={{ color: 'var(--ink2)' }}>(还没写正文)</span>}
                </div>

                {pubError[c.id] && <div style={errStyle}>{pubError[c.id]}</div>}
                {delError[c.id] && <div style={errStyle}>{delError[c.id]}</div>}

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  {/* 保存在飞时(editBusy)这颗编辑入口禁用——handler 里 startRowEdit 顶部同款守卫,双闸。
                      编辑器改成整屏之后这一条在正常路径上已经够不着了(editBusy 只可能在编辑器视图里为真,
                      那时列表压根不渲染),但闸留着不撤:别只靠"渲染不出来"当锁。*/}
                  <button className="serc" onClick={() => startRowEdit(c)} disabled={editBusy} style={{ ...pillStyle, opacity: editBusy ? 0.6 : 1 }}>编辑</button>
                  <button
                    className="serc"
                    onClick={() => togglePublish(c)}
                    disabled={pubBusyId === c.id}
                    style={{ ...pillStyle, opacity: pubBusyId === c.id ? 0.6 : 1 }}
                  >
                    {pubBusyId === c.id ? '处理中…' : c.status === 'published' ? '撤稿' : '发布'}
                  </button>
                  <button
                    className="serc"
                    onClick={() => onDeleteClick(c.id)}
                    disabled={delBusyId === c.id}
                    style={{
                      ...pillStyle,
                      color: delStage[c.id] === 1 ? '#fffdf5' : '#c2693f',
                      background: delStage[c.id] === 1 ? '#c2693f' : 'var(--card-bg)',
                      opacity: delBusyId === c.id ? 0.6 : 1,
                    }}
                  >
                    {delBusyId === c.id ? '删除中…' : delStage[c.id] === 1 ? '真的删?再点一次' : '删除'}
                  </button>
                  <span style={{ ...hintStyle, marginTop: 0 }}>
                    {c.status === 'published' ? '已发布,在打字桌记忆和读书角里能看到它' : '发布后才进打字桌记忆和读书角'}
                  </span>
                </div>
            </div>
          ))}
        </div>
      )}
      </>
      )}
    </>
  );
}
