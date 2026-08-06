# tavern-study · 酒馆书房

> 开源 · 免费 · MIT
>
> 📖 本文前半段写给人看；从「[🤖 以下写给接线的 AI](#-以下写给接线的-ai)」起写给机看——零编程的姐妹读完前半段，把仓库整个丢给自家 AI 就行。

一间搬进你家的写作书房——不用再开电脑终端，躺着在自家玩 RP 推剧情，还能发布连载让小机追更。

给这样的你：有自建的前后端和记忆库，喜欢 AIRP 写故事；用过酒馆，或者被酒馆的搭建劝退过。这里把「推剧情要用的一整套」做成了现成的房间——预设、世界书、正则直接导入就能写，推完的剧情存成连载，还有一套完整的记忆总结系统。

**接线条款**：你只需要「接」和「导入」——数据库、模型、部署换成**自己家的**。本仓不为任何特定环境（SillyTavern、某个云平台、某个模型供应商……）做适配承诺，只保证核心合同本身可用、有测试兜底。

预设、角色卡等资源自行去各大 Discord 社群搜索，此处不赘述。

> 🖼 图文版导览页：**https://tricksterflare.github.io/tavern-study/** （源文件在 [docs/index.html](docs/index.html)）——打字桌图解导览、术语小抄都在那边，第一次逛建议先看它。

## 项目简介

### 三个房间

- **书架** 📚（私人 · 设定的家）——角色卡、世界观、大纲、随手记的散记，一条一条立在架上。世界书就长在这些条目上。
- **读书角** 📖（共读 · 剧情总结与连载）——推完的剧情整理成章、发布成连载。家机来追更，还能在楼里留言——这间是搭给两个人的。
- **打字桌** ⌨️（主战场 · AIRP 写作台）——导入你的预设直接开写，一楼一楼往上盖。状态板、时光带、重摇都在桌上，写完顺手收进读书角。

### 怎么上手

1. **起个项目门牌** —— project 就是一个名字（比如「雪夜行」）。书架、打字桌和读书角的内容全靠这个project名称归堆；第一次在哪儿填了这个名字，以后就会出现在下拉选项里。
2. **书架放设定** —— 角色卡、世界观、大纲一条条立上架。想让 AI 自动看见的条目，配上世界书的进场方式：常驻 / 关键词 / 在场档（三种档位的区别见下面记忆框架第 2 层）。进场方式之后要调整，去打字桌顶栏的世界书浮窗（[世]）里点开条目编辑。
3. **导入酒馆家当** —— 打字桌的文具盒里有导入口：预设、世界书、正则、角色卡（.json 和 .png 的卡都认）整包进来，直接用。预设的条目还可以自己调整保存成配方，不顺手的丢进积木仓库。
4. **写核心记忆** —— 给这个故事写一段总纲。已有剧情就压几百字精简概括，只讲最核心的走向；从零开始则随意起个头。它是权重最高的一层记忆，每一楼都带着。
5. **开写作窗，开写** —— 一楼一楼往上盖；不满意就 roll，候选并排放着随时切回去比较，也能直接编辑。状态板每楼记着谁在场、什么状态，老楼自动折进时光带。每层楼有两幅面孔：美化=正则排版+预设自带的美化卡（沙箱里渲染），素颜=模型吐出的原文一字不动，楼层动作条上一键切换，怎么切原文都完整保留。断网、超时、模型抽风都不怕：半截楼不会进账本，你的存档永远是完整的。
6. **推完收章节** —— 把这段剧情整理成章、发布进读书角变成连载，改、撤回、删都行。收章节 = 把短期记忆转成长期记忆：只有变成章节，淡出时光带的剧情才能被"旧章召回"重新想起来。
7. **把钥匙给自家 AI** —— 把 companion 钥匙发给 TA，TA 就能来读书角追更、在楼里留言（怎么发钥匙在下半篇的「MCP 面」里）。

### 记忆框架

写到第 999 楼，它还记得第 1 楼吗？——记得。每写一楼，它眼前的"前情"是现场拼出来的，配方如下：

> 当前这一楼的记忆 = **核心记忆** + **世界书 & 角色卡** + **旧章召回** + **时光带摘要** + **近景楼层原文** + **状态板**

亲测 400 万字的 OC 故事搬进来之后，角色设定、伏笔和往期剧情全部清晰——后期平均每楼注入约 2.5 万 token。

1. **核心记忆 · 故事的总纲**（你手写 · 你定稿）——整个故事此刻的大局：世界的背景、剧情走到哪一步了、关系现在是什么状态。它永远常驻在最前面，是整个世界的底色，每一楼都带着——所有记忆里权重最高的一层。可以让 AI 起草，但由你定稿。
2. **世界书 & 角色卡 · 用到才上桌**（你建 · 自动进场）——设定不会一股脑全塞进去，有三种进场方式：**常驻**（标了常驻的一直在，比如大纲）、**关键词**（正文提到才上桌，如角色卡或关键物品清单）、**在场档**（专为"单字名"角色设计——比如叫"寻"的角色会被"寻找"误触；开启"只认状态板在场角色"后，可以用 @角色名 强行让角色卡触发）。谁在戏里，谁的设定才占位置。
3. **旧章召回 · 写过的故事会被想起来**（自动 · 阈值可调）——读书角里发布的章节总结，是长期记忆的正本。打字桌常态下只召回最新章节；写到相关剧情时，够像的旧章（向量阈值超过 0.55，可自行修改）才会被自动"想起来"，并按章节顺序拼进前情。（这层需要配语义检索；没配只是这层不开，其他照常。）
   💡 强烈建议每一章不要搬原文，而是自己压缩、或搬时光带的总结进来。否则每章原文几万字，几十章之后 token 爆窗根本跑不动。
4. **时光带 · 本窗老楼的摘要**（全自动）——同一个写作窗里，更早的楼会自动折成一段一段的摘要，用很小的位置替原文站岗。每 20 层触发一次，折叠老的 16 楼，留最近 6 楼原文。
   ⚠️ **时光带是有上限的**：每窗最多 20 段，写得越长，最老的摘要会淡出它的视野（原文不会被删）。建议太老的楼层及时搬进读书角的章节连载。
5. **近景楼层 · 最近的原文一字不落**（全自动）——最新的若干楼保持原文全量在场，它写下一楼时看的是真字句，不是转述。
6. **状态板 · 硬性状态不靠"凭印象"**（AI 写 · 你可改）——每一楼都带一块结构化的板：谁在场、受没受伤、好感几分。模型自己写、你可以改、也能按正文一键重算。数值和在场关系看板，不看模型的记性。
   💡 板上字段的"形状"会代代相传——每一楼照着上一楼的板写。新窗第一楼定了调，后面就一直跟着；想换形状不用改设置，下一楼带句 OOC（比如"状态板的衣装请按角色分条"），它改写这一楼后就会一直沿用。

收章节这一步，我们刻意没做全自动。因为 AI 写总结，总会漏掉你最在意的那个细节，或者把不重要的写得太满——而这段文字将来是要当"前情记忆"喂回去的。让 AI 起草，你来审：删两句、补一句。这一分钟决定了它以后"记得"的是什么版本的故事。

写、收、忆是一个圈——**圈的最后一道工序在你手里。**

## 先说清楚的小事

免费分享的自用工具，能力边界都摆在明处——不夸大，也不藏着。

- **这套玩法的源头是 SillyTavern**——预设、世界书、正则的概念和运作方式都来自酒馆社区，不是我们的原创。我们做的是照这套思路自己重写了一版，为长剧情补了些自家的取舍；代码全部自写，创意归酒馆。
- 它是单人用的框架，没有账号系统，也不提供托管。
- 维护佛系：有空就修，不承诺适配所有环境。MIT 协议，拿去随便用。
- 一句安全提醒：陌生预设包里的美化卡**会真的跑脚本**——导入前自己掂量来源。完整的安全须知在下半篇。

---

## 🤖 以下写给接线的 AI

看完想开张？**把仓库交给你自己的 AI**——从这里往下就是写给 TA 的。姐妹们各家的记忆库长得都不一样，把数据库、模型换成你们家的这一步，本来就该由最懂你家系统的那位来干。人类读者到这儿可以合上页面了。

### 开工单

接线 Agent 按这个顺序干活：

1. **先验货**：`npm install && npm test` —— 不要 API 钥匙、不花钱，测试全绿 = 核心合同完整。
2. **读 [`docs/data-model.md`](docs/data-model.md)** —— 每张表的形状，接自家数据库照着建。
3. **读 [`docs/wiring.md`](docs/wiring.md)** —— 存储 / 模型 / 部署三处怎么换成宿主自己的。
4. **要实现的合同只有四类**（详见下方「架构」）：`StorageAdapter`（六个子存储接口）、`ModelBackend`（一个 `streamChat` 方法）、`SemanticSearchAdapter`（可选，缺失时语义检索优雅降级）、`AuthContext`（actor 身份 + scopes）。`MemoryStorage`（`src/adapters/memoryStorage.ts`）是最简单的"接自己的数据库"参照样板。

最小可跑示例——纯内存宿主：

```ts
import { createMemoryStorage } from './src/adapters/memoryStorage.ts';
import { FakeModelBackend } from './src/adapters/fakeModelBackend.ts';
import { TavernStudyHost } from './src/core/tavernStudyHost.ts';
import { TavernStudyMcpServer } from './src/mcp/server.ts';

const storage = createMemoryStorage({ /* 你的章节、配方、资产种子数据 */ });
const model = new FakeModelBackend({
  ok: true, terminal: 'clean', text: '下一段正文。', thinking: '',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const host = new TavernStudyHost({ storage, model, defaultModel: 'your-model' });
const mcp = new TavernStudyMcpServer(host, authContext);
```

把 `mcp.handle(request)` 注册到你自己的 MCP 传输层背后；可信的 `AuthContext` 要在传输边界自己构造，构造 session server 时一并绑定——它的 scopes 决定工具可见性和评论署名身份。每个 MCP 会话用一个独立的 server 实例，生命周期和 actor 状态不要跨客户端共享。然后在你已有的应用里加一个"书房"入口即可。框架本身不预设 UI 框架、数据库、身份提供方或部署平台。

## 架构

- **core services**（`src/core/`）：`ReadingService`（发布/评论）、`StudyService`（私人书房笔记，含可选语义检索）、`DeskService` + `DeskGenerationService`（打字桌窗口/楼层/原子化轮次提交）。这些服务只依赖四类合同，不知道自己跑在哪：
  - `StorageAdapter`（`src/core/storage.ts`）：`reading`/`study`/`desk`/`deskAssets`/`deskStory`/`deskTurn` 六个子存储接口。
  - `ModelBackend`（`src/core/modelBackend.ts`）：`streamChat(args): Promise<StreamChatResult>` 一个方法，流式对话的唯一注入点。
  - `SemanticSearchAdapter`（`src/core/storage.ts`）：可选，缺失时语义检索优雅降级，其余功能不受影响。
  - `AuthContext` / `authenticate()`（`src/auth.ts`）：actor 身份 + scope 集合，MCP 面和参考 Worker 的评论/发布路由共用。
- **`TavernStudyHost`**（`src/core/tavernStudyHost.ts`）：把上面几类合同和三个服务组装成一个注入式入口，`reading`/`study`/`desk` 挂在实例上，另外提供 `generateDeskTurn`/`foldDeskTimeline`/`refreshDeskBoard`/`importDeskAssetPack` 几个跨服务动作。
- **`TavernStudyMcpServer`**（`src/mcp/server.ts`）：只暴露两个 MCP 工具（`shelf`/`bookclub`）的传输无关调度器，见下文「MCP 面」。
- **`MemoryStorage`**（`src/adapters/memoryStorage.ts`）：纯内存实现全部 `StorageAdapter` 子接口，是测试地基，也是最简单的"接自己的数据库"参照样板。
- **`examples/cloudflare/`**：D1 + 可选 Vectorize/Workers AI 的参考宿主。⚠️它自己的打字桌聊天/时光带折叠/状态板重算路由（`src/chat/desk.ts`、`src/chat/deskTimeline.ts`、`src/chat/deskBoardRefresh.ts`）是直接拼 D1 存储 + Anthropic 调用写的，**不经过 `TavernStudyHost`**；`TavernStudyHost`/`TavernStudyMcpServer` 只在这份参考里被当作"如何嵌入"的说明，`/mcp` 路由本身返回 `501`，故意不提供托管 MCP 会话，见下文「MCP 面」。
- **`frontend/`**：Next.js 静态导出的书房界面，通过 `NEXT_PUBLIC_WORKER_URL` + `NEXT_PUBLIC_AUTH_TOKEN` 两个环境变量拼出 API base（`${WORKER_URL}/${AUTH_TOKEN}`），对接参考 Worker 的 `/{AUTH_TOKEN}/api/oc/*` 写手管理面。
- **模型通道只有一条**：直连 Anthropic Messages API 的流式适配器（`src/adapters/streamModelBackends.ts` 的 `AnthropicStreamBackend`）。可选环境变量 `ANTHROPIC_BASE_URL` 能把三条生成链的端点整体指到一个 **Anthropic 兼容网关**（完整 Messages 端点 URL、仅 https、拒绝 URL 内嵌凭据；协议不变，网关兼容性由网关自己负责，见 `docs/wiring.md`）。曾经存在过的网关/多后端切换实现已经整体删除，不在本仓范围内；见下文「边界与降级」。
- **MCP 只有两个工具**：`shelf`、`bookclub`。没有第三个。
- 这不是完整网站、不提供托管服务、不提供账号系统、不是 SillyTavern 的替代品或迁移工具。它只吃 ST 预设/世界书/正则这几类资产里被验证过的一个子集方言，不是全量语义复刻。

## MCP 面

`TavernStudyMcpServer` 只暴露两个工具，`shelf` 和 `bookclub`。

- **`shelf`**：私人书房的只读视图。`action` 为 `list`（默认，按 project/category/tag/keyword/limit 过滤浏览）、`get`（带 `id`，读一条全文）、`stats`（按分类/项目分组计数）。没有写入动作——底层 `StudyService` 支持写，这里不通过 MCP 暴露。要求 `study:read` scope。
- **`bookclub`**：发布区。`action` 为 `chapters`（默认，列出已发布章节）、`read`（带 `id`，读一章全文）、`comments`（带 `chapter_id`，列出评论）、`comment`（带 `chapter_id`+`content`，可选 `reply_to`，发一条评论）。`chapters`/`read` 要求 `published:read`；`comments` 要求 `comments:read`；`comment` 要求 `comments:write`。评论署名永远从调用方的 `AuthContext`（`actorId`/`actorType`/`displayName`）派生，不读请求体。

`TavernStudyMcpServer` 是传输无关的，每次调用处理一条 JSON-RPC 请求（不支持 batch 数组）。HTTP 状态码、Bearer token 校验、MCP 会话保活、限流、CORS、审计策略都属于宿主边界，本类不管。参考 Worker 的 `/mcp` 路由只演示了鉴权和发布区 REST 策略，故意返回 `501 mcp_transport_not_configured`——部署者需要自己接一个支持会话的传输层。不要把参考 Worker 当成已经能用的托管 MCP 服务器。

### token 档位（`src/auth.ts`）

- `OWNER_TOKEN`（+ `OWNER_TOKEN_PREVIOUS` 供轮换）：拥有全部 scope，`actorType: 'owner'`。
- `COMPANION_TOKEN`（+ `COMPANION_TOKEN_PREVIOUS`）：默认只有 `published:read` + `comments:read`；`COMPANION_COMMENT_WRITE=true` 时再加 `comments:write`。`actorType: 'ai'`，展示名取 `COMPANION_NAME`。
- `Scope` 类型里还有 `study:write`/`chapters:read`/`chapters:write`/`desk:read`/`desk:write`，`OWNER_SCOPES` 都包含它们，但参考 Worker 目前只在发布/评论/MCP 路由上做 scope 检查——写手管理面 `/{AUTH_TOKEN}/api/oc/*` 走的是独立的路径 token 闸，不看这些 scope。想把更多 scope 接进你自己的路由，直接调用 `hasScope(auth, scope)` 即可。

给自家 AI 注册这个 MCP：把 `COMPANION_TOKEN` 当 Bearer token 发给它，让它按 MCP 客户端协议连接你托管的传输层（`initialize` → `tools/list` → `tools/call`）；owner 自己接入时用 `OWNER_TOKEN`。

## 兼容边界矩阵

下面每一行都对着代码核实过，不是从旧版描述抄的；差距是故意的边界，不是遗漏的 bug。

| 能力 | 支持到什么程度 | 边界 |
|---|---|---|
| 预设导入（prompt_order） | 只认 `prompt_order` 数组的第一份 | ST 每次对话按角色/群取一份 order；多角色/多 order 预设导入时会带 `warning` 提示"预设带 N 份 prompt_order，只认第一份"（`src/tools/desk.ts`） |
| 宏 | 只实现 `{{user}}`/`{{char}}`/`{{setvar::name::value}}`/`{{getvar::name}}`/`{{trim}}` 这五个 | 未识别的宏（如 `{{time}}`、`{{roll:1d6}}`）原样保留，不猜、不吞（`src/tools/deskMacro.ts`） |
| Marker 保留字 | 只对 `worldInfoBefore`/`worldInfoAfter`/`charDescription`/`charPersonality`/`scenario`/`chatExamples`/`personaDescription` 这几个 identifier 做特殊展开 | 其余 marker 块（如 `main`）原样走宏替换，不做任何展开（`src/chat/deskAssemble.ts` `renderBlock`） |
| Injection position/depth | 导入时解析并落库（`injection_position`/`injection_depth`/`injection_order`） | 装配排队只按 `queue_pos` 排序，**不按 injection depth 重新定位**——是"有解析、无完整 ST 注入语义"，不是"完整实现"（`src/tools/desk.ts` 导入 vs `src/chat/deskAssemble.ts` `buildOrderedQueue`） |
| 队列里 system/user/assistant 混排 | 队列前段（chatHistory 之前）遇到第一个 user/assistant 角色块之后，后续块全部降级进 tail、带角色标签 | 这是 Claude 单 system envelope 不支持"历史中途再插一条真 system"的限制，不是能力阉割；相对顺序仍然保留（`src/chat/deskAssemble.ts` 装配 pre 队列处的注释） |
| 世界书 / 角色卡关键词 | 基础关键词子串命中（大小写不敏感）+ `constant`（常驻）+ `presence`（本项目扩展的"仅看结构化在场名单"档位） | **不支持** secondary keys、AND/NOT 逻辑、递归触发预算、扫描深度模拟（`src/tools/deskMacro.ts` `matchLoreKeys`、`src/chat/deskAssemble.ts`） |
| 长期摘要（时光带） | 每窗口最多保留 20 段摘要，超限淘汰最老一段；原始楼层原文永不删除，只是淘汰段离开模型上下文 | 这是**有损**设计，明说不装：淘汰段之后不可再被模型看到，除非人工回读原文楼层（`src/chat/deskTimeline.ts`、`src/core/tavernStudyHost.ts`，segs 数组硬顶 20） |
| 角色卡导入 | 支持 SillyTavern V1/V2/V3 角色卡文件（`.json` / PNG 内嵌 `ccv3`/`chara` tEXt 块）导入，落成书架一条 `is_char=1` 条目；`character_book` 按世界书子集语义一并导入 | 不认识的字段一律忽略并计入 `warnings`；`first_mes`/`alternate_greetings` 只回吐给前端展示，不落库（`src/core/characterCard.ts` 解析、`src/tools/desk.ts` `importCharacterCard` 落库） |
| 语义检索 | 可选 `SemanticSearchAdapter` | 不绑定时 `StudyService.search()` 返回 `capability:'disabled'`，其余 CRUD 与关键词世界书正常工作（`src/core/studyService.ts`） |
| 模型连接 | Anthropic Messages 流式子集 | 见下方「边界与降级」 |

## 边界与降级

**模型侧：**

- 默认直连 `api.anthropic.com`；配了可选的 `ANTHROPIC_BASE_URL`（完整 Messages 端点 URL）就改打你的 Anthropic 兼容网关，线协议不变。仅认 https、拒绝 URL 内嵌凭据，配错会得到明确报错而不是悄悄回落官方端点；网关是否忠实实现 Messages 协议（流式事件、stop_reason、usage 字段）由网关自己负责。
- `cache_control`（prompt caching）是否真的生效，取决于你接的网关/供应商自己怎么处理这个字段——本仓的参考适配器原样透传 `cache_control: { type: 'ephemeral', ttl: '1h' }`，但透传之后是否命中缓存不由本仓保证。
- `thinking`（扩展思考）的透传程度因供应商而异，本仓不对齐所有网关的思考语义，也不会静默把"没有思考"伪装成"关闭了思考"。
- 一条硬规矩：**流结束不等于成功**。`AnthropicStreamBackend.streamChat` 只在观察到合法的协议终态（`message_stop` 且 `stop_reason` 属于 `end_turn`/`max_tokens`）时才返回 `ok:true`；中断、协议错误、超时都返回结构化失败，半截文本不会被当成一次成功轮次提交。

**可选绑定：**

没有绑定 Vectorize/Workers AI（`OC_VECTORIZE`/`AI`）时，只有语义搜索和往事召回（书房关键词检索、章节语义回忆）关闭，其余一切照常：书房笔记 CRUD、发布/评论、打字桌世界书关键词匹配、宏、正则、时光带折叠都不依赖这两个绑定。

## 参考部署：Cloudflare

```powershell
npm install
npm run typecheck
npm test
npm run build
```

三步接线细节见 [`docs/wiring.md`](docs/wiring.md)，数据表结构见 [`docs/data-model.md`](docs/data-model.md)。最简版本：

```powershell
npm run db:init:local
npm run db:migrate:local
```

`examples/cloudflare/schema/init.sql` 是给全新数据库用的建表脚本；`examples/cloudflare/schema/migrations/` 下按序号排列的文件是既有数据库的升级路径。给持久化的 D1 数据库跑迁移前请自己先备份。Vectorize 和 Workers AI 绑定是可选的，只在你想开语义检索时才需要；开启时 embedding 模型、向量维度、距离度量三者必须自洽。

## 安全须知（如实三句）

1. **美化卡 iframe 会执行包内脚本。** 打字桌渲染卡片用的是 `sandbox="allow-scripts"` 的 `srcDoc` iframe（`frontend/app/study/TypingDesk.tsx`），卡片自带的内联脚本会真的跑起来。导入不可信来源的预设/卡片包之前，请自己掂量这份包里可能带什么。
2. **URL 路径 token 和 Bearer token 都只是参考鉴权，不是生产级门禁。** 参考 Worker 用 `/{AUTH_TOKEN}/api/oc/...` 路径 token 网关写手管理面，用 Bearer `OWNER_TOKEN`/`COMPANION_TOKEN` 网关 MCP 和评论/发布路由（`src/auth.ts`）。公网部署前请自己换成更强的鉴权方式，或者在前面再挂一层访问网关。
3. **导入不做自动审查。** 预设/世界书/正则包导入时只做形状校验和敏感键名扫描（防凭据泄露），不对内容做任何"这段提示词是否安全"的判断——整包原样进库，内容是否可信由导入者自己负责。

## 发布保证与非目标

- 测试覆盖纯内存宿主/MCP 流程、模型流式协议合同、内存与 D1 两条打字桌原子提交路径、JSON 冲突场景、空 schema 两条安装路径。
- 这是单部署者框架，不是多租户账号系统。
- 不承诺完整前端产品、托管服务、一键部署按钮。
- Maintenance 是 best effort。鉴权、备份、内容审核、模型成本控制、UI 沙箱这些全部由接入者自己负责。

## License

MIT，见 [LICENSE](LICENSE)。版权署名：**阿日 & 柒**——一位人类和她的 AI 搭子，这间书房本来就是我们俩一起搭、搭给两个人用的。

特别感谢 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 社区：预设、世界书、正则这套玩法的开创者。本仓创意致敬酒馆，代码全部自写，不含任何 SillyTavern 代码。

---

一间先给自己搭的书房，整理干净，分享给同路的人。
拿去随便用，改成你家的样子。
