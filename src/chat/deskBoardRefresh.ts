// src/chat/deskBoardRefresh.ts
// 打字桌状态板刷新。
//
// 场景:模型写完一楼,她对细节不满意、手改了正文。改完之后状态板还停在模型当初写的那版——
// 原来只能手动去状态板里一格格改。这个口子让她按一下,照**改过之后的正文**重算一份状态板。
//
// 三条设计上的钉子:
//   1) **不落库,只回草稿**。这个函数只 return 一份 board,写不写由前端(她点保存)决定——
//      刷歪了点取消就行,符合本仓"不点保存就不落库"的家法。所以这里一句 UPDATE 都没有。
//   2) **只对模型写的那楼生效**(部署者拍板)。最后一楼若是她刚发出去、模型还没回的 user 楼,
//      直接拒绝——那时候"最新正文"是她的指令不是故事正文,拿它更新状态板会把板带偏。
//   3) **复用 parseStateBoard**,不自己写第二个解析器。那个函数已经处理过断头围栏
//      (模型被 max_tokens 腰斩)、8KB 上限、形状校验(只收纯对象、拒数组/基本类型)——
//      另起炉灶等于把这些坑重踩一遍。所以 prompt 里"用 ```stateboard 围栏、围栏必须在文本末尾"
//      那句是硬要求,不是装饰:parseStateBoard 只认锚定在全文末尾的围栏。
//
// 模型请求统一收口进 completeText，直连 Anthropic API，不在此复制调用细节。
// 错误文案与记账仍留本文件——合同层只回结构化终态。

import { makeD1UsageSink } from '../storage/usageSink';
import { completeText, type CompleteTextUsage } from './modelBackend';
import { parseStateBoard } from './desk';

interface DeskBoardRefreshEnv {
  OC_DB: D1Database;
  [k: string]: any;
}

const REFRESH_MODEL = 'claude-sonnet-4-5'; // 部署者拍板:抽结构化字段比写摘要简单,走便宜档,不烧她写作那档的钱

// 系统提示词是产品正文；规则 4 要求状态板按本楼终态更新。
// 未收伏笔加"失效/被绕过的也移除"+上限7条,与 deskAssemble.ts 的 in-band 指令同批同款
// (她的原话:"文字是死的人是活的,那个终稿只是上一份终稿")。除此之外逐字未动;
// 往后再要改仍是先提、由她拍板(家规)。几处不能松的地方,给以后动这个文件的人标一下:
//   · 规则1「正文未提及的字段完整沿用原值」是防丢的:只喂一楼,板上那些这楼没提到的键
//     (尤其「未收伏笔」)很容易被模型当成"没有了"。
//   · 规则2「字段集合固定 + 禁止变更数据类型」是防漂的:状态板的键集合是协议钉死的
//     (在场角色/衣装/位置/关系/时间地点 + 可选的未收伏笔),它一发挥,装配那边就对不上了;
//     类型漂移(比如「关系」从对象被刷成字符串)是静默的,更难发现。
//   · 输出规范那句「围栏必须处于文本末尾」直接卡在 parseStateBoard 的判据上,见文件头。
const REFRESH_SYS =
  `你在维护连载小说的「状态板」，输出仅为记录客观事实的JSON，不进行文学创作。

输入包含两项：
【当前状态板】上一轮保存的状态数据
【最新正文】为本楼最终文本，若经过手动编辑，一切以此内容为最高标准。

生成更新后的状态板，严格遵守规则：
1. 所有修改仅依据【最新正文】明确记载的信息。正文未提及的字段，完整沿用【当前状态板】原有数值，不得清空、删除或擅自修改。
2. 字段集合固定：不新增原有状态板不存在的键，不删除任何已有键，禁止变更字段数据类型。
3. 「在场角色」仅填写本楼场景实际现身人物；仅被提及、回忆、口述的人物不计入。
4. 若存在「未收伏笔」字段：新增本楼埋下的线索、悬置约定、未解疑问；已经了结收束、已然失效或被剧情绕过的伏笔予以移除；不重复添加已有伏笔；该字段最多保留7条，超出时合并同类项，优先保留对后续剧情最关键的条目；即使【最新正文】未提及伏笔相关内容，超出上限时也须执行本条整理。区分未执行计划与已成事实的事件。若无此字段，禁止自行创建。
5. 仅做事实记录，禁止脑补、推测后续剧情、补充原文不存在的细节；信息无法确认时，保留原有状态板数值。

输出规范：
使用 \`\`\`stateboard 围栏包裹JSON内容。围栏必须处于文本末尾，围栏前后不允许添加任何解释、额外文字。`;

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function deskBoardRefresh(env: DeskBoardRefreshEnv, windowId: string): Promise<any> {
  if (!windowId) return { success: false, error: '缺 window_id' };
  const usageSink = makeD1UsageSink(env);

  let win: any;
  try {
    win = await env.OC_DB.prepare(`SELECT id, state_board FROM desk_windows WHERE id = ?`).bind(windowId).first<any>();
  } catch (e: any) {
    return { success: false, error: e.message };
  }
  if (!win) return { success: false, error: '这扇窗不存在' };

  // 最后一楼:排序跟 chat/desk.ts 取 lastFloor 那处一模一样(created_at DESC, id DESC),
  // 两边必须同口径——不然"刷新读的那楼"和"重 roll 覆盖的那楼"会是两楼。
  let floor: any;
  try {
    floor = await env.OC_DB
      .prepare(`SELECT id, role, content FROM desk_floors WHERE window_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
      .bind(windowId).first<any>();
  } catch (e: any) {
    return { success: false, error: e.message };
  }
  if (!floor) return { success: false, error: '这扇窗还没有楼层' };
  // 部署者拍板:只对模型的回复生效。她刚发出去还没生成的那种 user 楼不给刷。
  if (floor.role !== 'assistant') {
    return { success: false, error: '最后一楼不是模型写的——刷新只按模型回复的正文重算,先让它写完这楼' };
  }
  const content = String(floor.content || '').trim();
  if (!content) return { success: false, error: '最后一楼是空的,没有正文可以据此更新' };

  const board = safeJsonParse<Record<string, any>>(win.state_board, {});
  if (!board || typeof board !== 'object' || Array.isArray(board)) {
    return { success: false, error: '当前状态板不是一个对象,先去状态板面板把它修好再刷新' };
  }
  if (Object.keys(board).length === 0) {
    // 空板刷不出东西:规则2 说"不新增原有状态板不存在的键",一个键都没有的话模型只能干瞪眼。
    // 明说,别让她按了没反应还以为坏了。
    return { success: false, error: '当前状态板是空的——刷新是"按最新正文更新已有的键",先让模型写一楼把板立起来' };
  }

  // 正文是小说素材不是指令。这里做的是**结构上的**防伪造(同 deskTimeline 对 <楼层原文> 的处理):
  // 把正文里字面出现的同名标签换成全角,免得台词/协议残渣把边界演出来。只改这次请求的临时副本,
  // D1 里的楼层正本一个字不动。
  // 本链路不追加 timeline 的防注入句；提示词内容由产品终稿单独维护。
  // "走的都是咱家自己的东西"——这个口子吃的是她自己写的小说正文和她自己的状态板,不像 AISay/
  // 出门那类要过封条的外来文字;而且刷出来的板只进草稿、要她点保存才落库,错了她当场看得见。
  // 结构上的防伪造(下面把正文里字面出现的同名标签转全角)照做,那一层跟话术无关、成本为零。
  // 哪天这个口子开始吃外部来的正文(比如导进来的别人的稿子),这条结论要重新拿给她看。
  const safeContent = content
    .replace(/<最新正文>/g, '＜最新正文＞')
    .replace(/<\/最新正文>/g, '＜/最新正文＞');
  const user =
    `【当前状态板】\n${JSON.stringify(board, null, 2)}\n\n` +
    `【最新正文】\n<最新正文>\n${safeContent}\n</最新正文>`;

  // 渠道守门(文案主权在本文件,合同层只回结构化终态):缺 key 在动手前拦下。
  if (!env.ANTHROPIC_API_KEY) {
    console.error('[desk-board-refresh] ANTHROPIC_API_KEY 没配,刷新走不通');
    await usageSink.logUsage('desk-board-refresh', REFRESH_MODEL, undefined, 'failed');
    return { success: false, error: 'ANTHROPIC_API_KEY 没配' };
  }

  // 请求统一走 completeText 的超时与终态合同。
  // 刷新钮的口吻("再试一次")留在这层翻译,不进合同。
  let text = '';
  let apiUsage: CompleteTextUsage | undefined;
  {
    const r = await completeText(env, { system: REFRESH_SYS, prompt: user, model: REFRESH_MODEL });
    apiUsage = r.usage;
    if (!r.ok) {
      const reason =
        r.kind === 'no_key' ? 'ANTHROPIC_API_KEY 没配' :
        r.kind === 'http' ? `模型没答应(${r.detail})` :
        r.kind === 'empty' ? `模型没给出内容(${r.detail || 'empty'})` :
        r.kind === 'truncated' ? '刷新结果被截断(max_tokens),再试一次' :
        r.kind === 'refusal' ? '模型拒答了(refusal),再试一次' :
        r.kind === 'timeout' ? '刷新超时(100s)被砍了,再试一次' :
        `刷新请求失败: ${r.detail}`;
      // 日志与前端文案分离；底层终态只在本层翻译成状态板语义。
      const logMsg =
        r.kind === 'http' ? `summary ${r.detail}` :
        r.kind === 'empty' ? `summary ${r.detail || 'empty'}` :
        reason;
      console.error(`[desk-board-refresh] ${logMsg}`);
      await usageSink.logUsage('desk-board-refresh', REFRESH_MODEL, apiUsage, 'failed');
      return { success: false, error: reason };
    }
    text = String(r.text);
  }

  // 跟机器写入路径共用同一个解析器:断头围栏/8KB上限/形状校验全在里头(见文件头第3条钉子)
  const { board: nextBoard } = parseStateBoard(text);
  if (!nextBoard) {
    await usageSink.logUsage('desk-board-refresh', REFRESH_MODEL, apiUsage, 'failed');
    return { success: false, error: '模型没有按格式吐出状态板围栏(或者被截断了),再试一次' };
  }

  // parseStateBoard 只保证对象形状和字节上限；字段协议仍须在此校验。
  // 提示词里规则2 白纸黑字要求"字段集合固定、不删键、禁止变更数据类型",但那只是**对模型的请求**
  // ——模型没照做的时候得有人拦。最险的是它吐个 `{}`:解析成功、前端显示一块空草稿,她一点保存
  // 整块板就没了。所以这里拿输入那份板当尺子,逐项对一遍;对不上宁可这次白刷,也不把歪板递出去。
  const beforeKeys = Object.keys(board);
  const afterKeys = Object.keys(nextBoard);
  const missing = beforeKeys.filter((k) => !Object.prototype.hasOwnProperty.call(nextBoard, k));
  if (missing.length) {
    await usageSink.logUsage('desk-board-refresh', REFRESH_MODEL, apiUsage, 'failed');
    return { success: false, error: `重算回来的板少了这些键:${missing.join('、')}——没敢用,再试一次` };
  }
  const added = afterKeys.filter((k) => !Object.prototype.hasOwnProperty.call(board, k));
  if (added.length) {
    await usageSink.logUsage('desk-board-refresh', REFRESH_MODEL, apiUsage, 'failed');
    return { success: false, error: `重算回来的板多出了这些键:${added.join('、')}——没敢用,再试一次` };
  }
  // 顶层值的"形状档位"要一致:数组 / 纯对象 / 标量三档不许互串。同档里的内容随便它改(那正是
  // 刷新要干的事),但 `关系` 从对象被刷成一句话这种漂移是静默的,回头装配那边才发作。
  const shapeOf = (v: any): string => (Array.isArray(v) ? 'array' : v !== null && typeof v === 'object' ? 'object' : 'scalar');
  const drifted = beforeKeys.filter((k) => shapeOf((board as any)[k]) !== shapeOf((nextBoard as any)[k]));
  if (drifted.length) {
    await usageSink.logUsage('desk-board-refresh', REFRESH_MODEL, apiUsage, 'failed');
    return { success: false, error: `这些键的数据类型被改了:${drifted.join('、')}——没敢用,再试一次` };
  }

  await usageSink.logUsage('desk-board-refresh', REFRESH_MODEL, apiUsage, 'ok');
  // 只回不写:落库由她在状态板面板点保存(见文件头第1条钉子)。floor_id 带回去给前端对账用——
  // 万一她按刷新的时候模型又写了一楼,前端能看出这份板是照哪一楼算的。
  return { success: true, board: nextBoard, floor_id: floor.id };
}
