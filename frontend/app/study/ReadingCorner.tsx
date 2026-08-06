'use client';

// 读书角:两个主 tab——阅读(published 连载列表 + 阅读页 + 评论楼中楼)/ 章节工房(ChaptersStudio,
// 全部写操作)。新建/编辑/发布/撤回/删除都归章节工房,这里只剩"读",不再有独立的草稿箱视图,
// 避免同一件事分裂成两套入口。
// fetch 全 try/catch,res.ok 和 body.success 双验,加载/错误/空态三态分开,不把"没查到"和"查失败"
// 混为一谈;跨页导航不在这里发生(内部视图切换靠 state)。

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ChaptersStudio from './ChaptersStudio';

// ── 数据形状(按后端契约来,字段名不许自己发明) ──
type ChapterListItem = {
  id: string; project: string; chapter_no?: string | number | null; title: string;
  summary?: string | null; status: 'draft' | 'published';
  created_at: string; updated_at: string; published_at?: string | null;
  comment_count?: number; preview?: string;
};
type ChapterDetail = ChapterListItem & { content: string };
// 后端(ReadingService.listComments/commentPost)已经把 display_name 解析好一起返回,
// author_id/author_type 只在极端情况(display_name 缺失)当兜底用。
type CommentRec = {
  id: string; chapter_id: string; author_id: string; author_type: 'owner' | 'ai';
  display_name: string; content: string; reply_to: string | null; created_at: string;
};

// 中性角色名兜底表——只在后端没给 display_name 时才用得到,不假设具体是谁。
const AUTHOR_TYPE_LABEL: Record<string, string> = { owner: '我', ai: 'AI' };
function authorLabel(c: CommentRec): string {
  return c.display_name || AUTHOR_TYPE_LABEL[c.author_type] || c.author_type;
}

// ── 卡片风格小料(与 page.tsx 同款数值,组件独立成文件故各自留一份) ──
const cardStyle: React.CSSProperties = {
  background: 'var(--card-bg)', border: '1px solid var(--line-soft)', borderRadius: 22, boxShadow: '0 6px 18px var(--card-shadow)',
};
const glassCardStyle: React.CSSProperties = {
  background: 'var(--glass-bg)', border: '1.5px dashed var(--dash-line)', borderRadius: 22, boxShadow: '0 4px 16px var(--card-shadow)',
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
const clamp2: React.CSSProperties = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' };

function fmtMD(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch { return iso; }
}
function fmtDT(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return iso; }
}

// 读书角主tab——阅读=连载列表 + project 子tab(这个"阅读"tab内部的结构);
// 章节工房=ChaptersStudio,写操作都在这里。受书房页(page.tsx)控制(mainTab/chaptersProject
// 都是受控 prop),好让 URL 恢复和书架侧的"跳门"都能直接指哪打哪——两个文件各自留一份同名类型,
// 本仓惯例(同 ProjectField 组件独立成文件那条头注释)。
type ReadingMainTab = 'read' | 'chapters';
type CView = 'list' | 'read';

// ── project 选择用下拉而非自由文本,理由同 page.tsx 同名组件(手打容易打出对不上的新词,
// 内容分散找不到自己)——下拉选现有+可新建,不砍新建能力,不新增后端接口。两个文件各自
// 独立留一份(本仓惯例,见文件头"组件独立成文件故各自留一份")。
const NEW_PROJECT_OPTION = '__new_project__';
function ProjectField({ value, onChange, options, disabled }: { value: string; onChange: (v: string) => void; options: string[]; disabled?: boolean }) {
  const merged = !value || options.includes(value) ? options : [value, ...options];
  const [manual, setManual] = useState(false);
  if (manual) {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="新项目名字" style={inputStyle} autoFocus disabled={disabled} />
        <button type="button" onClick={() => setManual(false)} disabled={disabled} className="serc" style={{ fontSize: 11.5, color: 'var(--ink2)', background: 'none', border: 'none', cursor: 'pointer', flex: 'none', whiteSpace: 'nowrap' }}>
          选现有
        </button>
      </div>
    );
  }
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === NEW_PROJECT_OPTION) { setManual(true); onChange(''); return; }
        onChange(e.target.value);
      }}
      style={{ ...inputStyle, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 }}
    >
      {!value && <option value="">请选择…</option>}
      {merged.map((p) => <option key={p} value={p}>{p}</option>)}
      <option value={NEW_PROJECT_OPTION}>＋新建项目…</option>
    </select>
  );
}

export default function ReadingCorner({
  base, envOk, mainTab, onMainTabChange, chaptersProject, onChaptersProjectChange,
  projectOptions: allProjectOptions, // 书架统计(全项目)——跟下面章节列表派生的同名 tab 内变量撞了,进来就改名
}: {
  base: string; envOk: boolean;
  mainTab: ReadingMainTab; onMainTabChange: (t: ReadingMainTab) => void;
  chaptersProject: string | null; onChaptersProjectChange: (p: string | null) => void;
  projectOptions: string[];
}) {
  const [cview, setCView] = useState<CView>('list');
  // 章节工房的编辑器开着没有(它自己报上来的)——开着就锁住上面那个项目选择器,见渲染处注释。
  const [studioEditorOpen, setStudioEditorOpen] = useState(false);

  // ── 连载列表(只拉 published:草稿归章节工房管,这边不再有草稿箱那一格) ──
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [chapters, setChapters] = useState<ChapterListItem[]>([]);
  const [listNonce, setListNonce] = useState(0);
  // 请求令牌(照 ChaptersStudio.tsx chaptersSeqRef 同款家法抄):nonce 连续触发会并发打出多趟请求,
  // 先发后至的旧响应不能覆盖新状态——提交前核对 tok 还新鲜。
  const listSeqRef = useRef(0);

  useEffect(() => {
    if (cview !== 'list') return;
    if (!envOk) { setListError('环境变量没配好'); setListLoading(false); return; }
    setListLoading(true); setListError('');
    const tok = ++listSeqRef.current;
    (async () => {
      try {
        const qs = new URLSearchParams({ status: 'published', limit: '200' });
        const res = await fetch(`${base}/api/oc/chapters?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json().catch(() => null);
        if (!d || d.success === false) throw new Error(d?.error || '后端报错');
        if (tok !== listSeqRef.current) return; // 令牌过期:更新的一次加载已经在路上,这份旧响应作废
        setChapters(Array.isArray(d.chapters) ? d.chapters : []);
      } catch (e: any) {
        if (tok !== listSeqRef.current) return;
        setListError(e.message || '这一柜翻不开'); setChapters([]);
      } finally {
        if (tok === listSeqRef.current) setListLoading(false);
      }
    })();
  }, [cview, listNonce, base, envOk]);

  // project 子tab——不同项目的连载混排在一起容易看串,按 project 分开浏览。不为它多发请求,
  // 从已加载的 chapters 里按 project 去重派生。排序:具名项目按名称(zh)排,"未分类"(project 为空/null)
  // 固定殿后且只在真有这类数据时才出现(不无中生有一个空 tab)。
  const projectTabs = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const c of chapters) {
      const key = c.project && c.project.trim() ? c.project : '';
      if (!seen.has(key)) { seen.add(key); order.push(key); }
    }
    const named = order.filter((p) => p !== '').sort((a, b) => a.localeCompare(b, 'zh'));
    return order.includes('') ? [...named, ''] : named;
  }, [chapters]);

  // 选中的子tab在数据刷新后(切连载、删完这个项目最后一章…)消失了,回退到第一个子tab(边角)
  const [projectTab, setProjectTab] = useState<string | null>(null);
  useEffect(() => {
    if (projectTabs.length === 0) return;
    if (projectTab === null || !projectTabs.includes(projectTab)) setProjectTab(projectTabs[0]);
  }, [projectTabs, projectTab]);

  // projectTab 还没落定(effect 还没跑完那一刻)先不过滤,免得闪一下空列表
  const visibleChapters = projectTab === null ? chapters : chapters.filter((c) => (c.project && c.project.trim() ? c.project : '') === projectTab);

  // ── 阅读页 ──
  const [readId, setReadId] = useState<string | null>(null);
  const [readLoading, setReadLoading] = useState(false);
  const [readError, setReadError] = useState('');
  const [chapter, setChapter] = useState<ChapterDetail | null>(null);
  // 身份闸(照 ChaptersStudio.tsx editSeqRef 家法抄):先点A章再点B章,详情/评论的旧响应
  // 不许灌进新打开的章——detail/comments 各自一支令牌(共一个 ref 免得起两个名字,但互不打扰,
  // 不然评论区自己的刷新会把正在飞的详情请求误判成过期)。readIdRef 是"当前该显示哪章"的活值
  // 镜像,在 openRead 里原地同步写(不靠 useEffect 追——效果要等下一轮渲染才落地,跟异步响应
  // 落地的时机赛跑会有一拍延迟的空隙)。
  const readSeqRef = useRef({ detail: 0, comments: 0 });
  const readIdRef = useRef<string | null>(null);

  const loadChapterDetail = useCallback(async (id: string) => {
    const tok = ++readSeqRef.current.detail;
    setReadLoading(true); setReadError(''); setChapter(null);
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const res = await fetch(`${base}/api/oc/chapters/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success === false) throw new Error(d?.error || '后端报错');
      if (tok !== readSeqRef.current.detail || id !== readIdRef.current) return; // 令牌过期或已经切到别的章,这份旧响应作废
      setChapter(d.chapter || d);
    } catch (e: any) {
      if (tok !== readSeqRef.current.detail || id !== readIdRef.current) return;
      setReadError(e.message || '这一章翻不出来');
    } finally {
      if (tok === readSeqRef.current.detail && id === readIdRef.current) setReadLoading(false);
    }
  }, [base, envOk]);

  // ── 评论 ──
  const [comments, setComments] = useState<CommentRec[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [cDelStage, setCDelStage] = useState<Record<string, 0 | 1>>({});
  const cDelTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const loadComments = useCallback(async (chapterId: string) => {
    const tok = ++readSeqRef.current.comments;
    setCommentsLoading(true); setCommentsError('');
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const qs = new URLSearchParams({ chapter_id: chapterId });
      const res = await fetch(`${base}/api/oc/comments?${qs.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success === false) throw new Error(d?.error || '后端报错');
      if (tok !== readSeqRef.current.comments || chapterId !== readIdRef.current) return; // 令牌过期或已经切到别的章,这份旧响应作废
      setComments(Array.isArray(d.comments) ? d.comments : []);
    } catch (e: any) {
      if (tok !== readSeqRef.current.comments || chapterId !== readIdRef.current) return;
      setCommentsError(e.message || '评论区翻不开'); setComments([]);
    } finally {
      if (tok === readSeqRef.current.comments && chapterId === readIdRef.current) setCommentsLoading(false);
    }
  }, [base, envOk]);

  function openRead(id: string) {
    readIdRef.current = id; // 原地同步:先于两路异步请求落笔,别等 effect
    setReadId(id);
    setComments([]); // 切章立刻清掉上一章评论,免得楼下还挂着上一章遗留的留言
    setCommentDraft(''); setReplyTo(null); setPostError('');
    setCView('read');
    loadChapterDetail(id);
    loadComments(id);
  }

  async function handlePostComment() {
    const content = commentDraft.trim();
    if (!content || posting || !readId) return;
    setPosting(true); setPostError('');
    try {
      if (!envOk) throw new Error('环境变量没配好');
      const body: any = { chapter_id: readId, content };
      if (replyTo) body.reply_to = replyTo;
      const res = await fetch(`${base}/api/oc/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      // 变更类请求收紧:success 必须显式为 true,200 空壳/schema 漂移按失败
      if (!d || d.success !== true) throw new Error(d?.error || '留言没发出去(服务端没确认成功)');
      setCommentDraft(''); setReplyTo(null);
      await loadComments(readId);
      setListNonce((n) => n + 1); // 评论数变了,回列表时数字要新
    } catch (e: any) { setPostError(e.message || '留言没发出去'); }
    finally { setPosting(false); }
  }

  function onCommentDeleteClick(id: string) {
    const stage = cDelStage[id] || 0;
    if (stage === 0) {
      setCDelStage((s) => ({ ...s, [id]: 1 }));
      if (cDelTimers.current[id]) clearTimeout(cDelTimers.current[id]);
      cDelTimers.current[id] = setTimeout(() => setCDelStage((s) => ({ ...s, [id]: 0 })), 3000);
      return;
    }
    if (cDelTimers.current[id]) clearTimeout(cDelTimers.current[id]);
    handleDeleteComment(id);
  }
  async function handleDeleteComment(id: string) {
    setPostError('');
    try {
      const res = await fetch(`${base}/api/oc/comments/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json().catch(() => null);
      if (!d || d.success !== true) throw new Error(d?.error || '删除失败(服务端没确认成功)');
      setCDelStage((s) => ({ ...s, [id]: 0 }));
      if (readId) await loadComments(readId);
      setListNonce((n) => n + 1);
    } catch (e: any) { setPostError(e.message || '删除失败'); }
  }

  // ── 编辑器整个搬去章节工房 ──
  // 写能力(新建/编辑/发布/撤回/删除)统一归章节工房,这里只剩"读",不再维护一套并行的编辑器实现
  // 和身份闸——不是删掉了保护,是保护对象没了(这里已经没有任何写入口)。阅读页的「编辑」钮改成
  // 跳去章节工房。

  // 阅读页 →「去章节工房改这一章」:章节工房按 project 组织,把这一章的项目一并递过去,
  // 落地就是这一章所在的那一架,不用她再选一次。
  function jumpToStudio() {
    if (!chapter) return;
    onChaptersProjectChange(chapter.project && chapter.project.trim() ? chapter.project : null);
    onMainTabChange('chapters');
  }

  const replyTarget = replyTo ? comments.find((c) => c.id === replyTo) : null;

  return (
    <>
      {/* ══ 读书角主tab:阅读 / 章节工房 ══ */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        {([['read', '阅读'], ['chapters', '章节工房']] as const).map(([k, label]) => {
          const active = k === mainTab;
          return (
            <button
              key={k}
              className="serc"
              onClick={() => onMainTabChange(k)}
              style={{
                ...pillStyle,
                background: active ? 'var(--scale-3)' : 'var(--card-bg)',
                color: active ? 'var(--card-bg)' : 'var(--ink-body)',
                border: active ? '1px solid transparent' : '1px solid var(--line-soft)',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {mainTab === 'chapters' && (
        <>
          {/* 章节工房挂在读书角这里之后不再依附于某个项目的页面,得自己先选项目——
              复用上面本文件已有的 ProjectField(选现有+可新建同一套),项目源用书架统计
              (page.tsx 传下来的 projectOptions),不新增请求。*/}
          <div style={{ marginBottom: 18, maxWidth: 320 }}>
            <div style={{ fontSize: 12, color: 'var(--ink2)', marginBottom: 5 }}>项目</div>
            <ProjectField
              value={chaptersProject || ''}
              onChange={(v) => onChaptersProjectChange(v.trim() ? v : null)}
              options={allProjectOptions}
              disabled={studioEditorOpen}
            />
            {/* 编辑器开着时这个选择器必须锁死——它在编辑器上方,原来照样能点,换个项目之后编辑器
                和里面的字原样留着,再点保存就把这一章写进了别的项目。 */}
            {studioEditorOpen && (
              <div style={{ fontSize: 11, color: 'var(--ink2)', marginTop: 4 }}>正在编辑,先存好或取消再换项目</div>
            )}
          </div>
          {chaptersProject ? (
            <ChaptersStudio base={base} envOk={envOk} project={chaptersProject} onEditorOpenChange={setStudioEditorOpen} />
          ) : (
            <div className="card" style={{ ...glassCardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)' }}>
              先选一个项目,才能看它的章节架~
            </div>
          )}
        </>
      )}

      {mainTab === 'read' && (
      <>
      {/* ══ 连载列表(草稿归章节工房管,这里只铺已发布的) ══ */}
      {cview === 'list' && (
        <>
          {/* project 子tab——只有一个 project 时(混排不成立)不渲染这一行,省得占地方却没用 */}
          {projectTabs.length > 1 && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
              {projectTabs.map((p) => {
                const active = p === projectTab;
                return (
                  <button
                    key={p || '（未分类）'}
                    className="serc"
                    onClick={() => setProjectTab(p)}
                    style={{
                      fontSize: 12, color: active ? 'var(--card-bg)' : 'var(--ink2)',
                      background: active ? 'var(--scale-2)' : 'var(--card-bg)',
                      border: active ? '1px solid transparent' : '1px solid var(--line-soft)',
                      borderRadius: 20, padding: '5px 13px', cursor: 'pointer', fontFamily: 'inherit',
                    }}
                  >
                    {p === '' ? '未分类' : p}
                  </button>
                );
              })}
            </div>
          )}

          {listLoading ? (
            <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)' }}>正在翻这一柜…</div>
          ) : listError ? (
            <div className="card" style={{ ...cardStyle, padding: '20px 24px', fontSize: 13, color: '#c2693f' }}>翻不开：{listError}</div>
          ) : chapters.length === 0 ? (
            <div className="card" style={{ ...glassCardStyle, padding: '20px 24px', fontSize: 13, color: 'var(--ink2)' }}>
              连载还没开张~去「章节工房」写第一章,发布了就摆到这儿来
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {visibleChapters.map((c) => (
                <div
                  key={c.id}
                  onClick={() => openRead(c.id)}
                  className="card"
                  style={{ ...cardStyle, padding: '16px 20px', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11.5, color: 'var(--card-bg)', background: 'var(--scale-2)', borderRadius: 20, padding: '2px 10px' }}>{c.project}</span>
                      {c.chapter_no != null && c.chapter_no !== '' && <span style={{ fontSize: 12, color: 'var(--ink2)' }}>第{c.chapter_no}章</span>}
                      <span className="serc" style={{ fontSize: 15.5, color: 'var(--ink-deep)' }}>{c.title}</span>
                    </div>
                    <span style={{ fontSize: 11.5, color: 'var(--ink2)', flex: 'none' }}>{fmtMD(c.published_at)}</span>
                  </div>
                  {c.preview && <div style={{ fontSize: 12.5, color: 'var(--ink-body)', marginTop: 8, ...clamp2 }}>{c.preview}</div>}
                  <div style={{ fontSize: 11.5, color: 'var(--ink2)', marginTop: 8 }}>{c.comment_count ?? 0} 条留言</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ══ 阅读页 ══ */}
      {cview === 'read' && (
        <div className="card" style={{ ...cardStyle, padding: '24px 28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
            <button className="serc" onClick={() => setCView('list')} style={pillStyle}>← 返回连载</button>
            {/* 写操作统一归章节工房:这颗不再当场开编辑器,而是带着这一章的项目跳过去 */}
            {chapter && <button className="serc" onClick={jumpToStudio} style={pillStyle}>去章节工房改 →</button>}
          </div>

          {readLoading ? (
            <div style={{ fontSize: 13, color: 'var(--ink2)' }}>正在翻这一章…</div>
          ) : readError ? (
            <div style={{ fontSize: 13, color: '#c2693f' }}>翻不开：{readError}</div>
          ) : !chapter ? null : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11.5, color: 'var(--card-bg)', background: 'var(--scale-2)', borderRadius: 20, padding: '2px 10px' }}>{chapter.project}</span>
                {chapter.chapter_no != null && chapter.chapter_no !== '' && <span style={{ fontSize: 12.5, color: 'var(--ink2)' }}>第{chapter.chapter_no}章</span>}
              </div>
              <div className="serc" style={{ fontSize: 24, color: 'var(--ink-deep)', marginTop: 8 }}>{chapter.title}</div>
              <div style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 6 }}>{fmtDT(chapter.published_at)} 发布</div>

              {chapter.summary && (
                <details style={{ marginTop: 16 }}>
                  <summary className="serc" style={{ cursor: 'pointer', fontSize: 13, color: 'var(--ink-body)', background: 'var(--scale-0)', display: 'inline-block', borderRadius: 20, padding: '6px 16px' }}>本章总结</summary>
                  <div style={{ marginTop: 10, fontSize: 13, color: 'var(--ink-body)', lineHeight: 1.8, whiteSpace: 'pre-wrap', background: 'var(--scale-0)', borderRadius: 14, padding: '14px 16px' }}>{chapter.summary}</div>
                </details>
              )}

              <div
                className="serc"
                style={{
                  marginTop: 22, paddingTop: 18, borderTop: '1px solid var(--line-soft)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'break-word',
                  fontSize: 16, color: 'var(--ink-body)', lineHeight: 2,
                }}
              >
                {chapter.content || <span style={{ color: 'var(--ink2)' }}>(还没写内容)</span>}
              </div>

              {/* ── 评论区 ── */}
              <div style={{ marginTop: 30, paddingTop: 20, borderTop: '1px solid var(--line-soft)' }}>
                <div className="serc" style={{ fontSize: 16, color: 'var(--ink-deep)', marginBottom: 14 }}>留言区</div>

                {commentsLoading ? (
                  <div style={{ fontSize: 13, color: 'var(--ink2)' }}>正在翻留言板…</div>
                ) : commentsError ? (
                  <div style={{ fontSize: 13, color: '#c2693f' }}>翻不开：{commentsError}</div>
                ) : comments.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--ink2)' }}>还没有留言,来说第一句吧~</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {comments.filter((c) => !c.reply_to).map((c) => (
                      <div key={c.id}>
                        <CommentRow c={c} stage={cDelStage[c.id] || 0} onDelete={() => onCommentDeleteClick(c.id)} onReply={() => setReplyTo(c.id)} />
                        {comments.filter((r) => r.reply_to === c.id).map((r) => (
                          <div key={r.id} style={{ marginLeft: 34, marginTop: 10 }}>
                            <CommentRow c={r} stage={cDelStage[r.id] || 0} onDelete={() => onCommentDeleteClick(r.id)} onReply={() => setReplyTo(c.id)} />
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 18 }}>
                  {replyTo && (
                    <div style={{ fontSize: 12, color: 'var(--ink2)', marginBottom: 6 }}>
                      回复给 {replyTarget ? authorLabel(replyTarget) : ''}
                      <button onClick={() => setReplyTo(null)} style={{ marginLeft: 8, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>取消回复</button>
                    </div>
                  )}
                  <textarea
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    rows={3}
                    placeholder="留几句给作者看看…"
                    style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-sans)' }}
                  />
                  {postError && <div style={{ fontSize: 12.5, color: '#c2693f', marginTop: 6 }}>{postError}</div>}
                  <div style={{ marginTop: 10 }}>
                    <button
                      className="serc"
                      onClick={handlePostComment}
                      disabled={posting || !commentDraft.trim()}
                      style={{ ...btnPrimaryStyle, opacity: posting || !commentDraft.trim() ? 0.6 : 1 }}
                    >
                      {posting ? '发送中…' : '发送留言'}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      </>
      )}
    </>
  );
}

// ── 单条评论(供顶层评论 + 楼中楼回复共用) ──
function CommentRow({ c, stage, onDelete, onReply }: { c: CommentRec; stage: 0 | 1; onDelete: () => void; onReply: () => void }) {
  return (
    <div style={{ background: 'var(--scale-0)', borderRadius: 14, padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="serc" style={{ fontSize: 13.5, color: 'var(--ink-deep)' }}>{authorLabel(c)}</span>
        <span style={{ fontSize: 11, color: 'var(--ink2)' }}>{fmtDT(c.created_at)}</span>
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--ink-body)', marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{c.content}</div>
      <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
        <button onClick={onReply} style={{ fontSize: 11.5, color: 'var(--ink2)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>回复</button>
        <button onClick={onDelete} style={{ fontSize: 11.5, color: stage === 1 ? '#c2693f' : 'var(--ink2)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
          {stage === 1 ? '真的删?再点一次' : '(馆长)删除'}
        </button>
      </div>
    </div>
  );
}
