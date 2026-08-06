# 接线说明

这一页讲清楚"接自己的东西"具体要接哪三处：存储、模型、部署。本仓不预设你接哪一种，下面每一节都先给合同，再给参考实现当样板。

## 一、存储

`StorageAdapter`（`src/core/storage.ts`）是一个聚合接口，六个子接口分别对应一类数据：

| 子接口 | 负责什么 | 谁在用它 |
|---|---|---|
| `StudyStorage` | 书房笔记 CRUD + 统计 | `StudyService` |
| `ReadingStorage` | 章节 CRUD/发布 + 评论 | `ReadingService` |
| `DeskStorage` | 打字桌窗口/楼层 CRUD + 楼层截断 | `DeskService` |
| `DeskAssetStorage` | 配方/预设/正则/世界书的只读查询 + 资产包导入 | `assembleDesk`（`src/chat/deskAssemble.ts`） |
| `DeskStoryStorage` | 核心记忆状态 + 已发布章节召回（给打字桌"近期章"用） | `assembleDesk` |
| `DeskTurnStorage` | 打字桌轮次的原子提交（新轮次 / `roll` 重生成） | `DeskGenerationService` |

写自己的存储，实现这六个接口（或者只实现你要用到的那几个——`TavernStudyHost` 的三个服务各自只碰自己需要的那部分）。每个方法的输入输出类型见 `src/core/storage.ts` 和 `src/core/types.ts`，字段语义对照见 [`docs/data-model.md`](data-model.md)。

**两份参照实现：**

- `src/adapters/memoryStorage.ts`（`MemoryStorage`）：纯内存实现，全部六个子接口都有，是测试地基，也是最短的"这个方法应该干什么"参照——每个方法通常只有一行，逻辑一目了然。用 `createMemoryStorage(seed)` 直接得到一个可用实例。
- `examples/cloudflare/adapters/`：D1 参考实现，一个文件对应一个子接口（`d1StudyStorage.ts`/`d1ReadingStorage.ts`/`d1DeskStorage.ts`/`d1DeskAssetStorage.ts`/`d1DeskStoryStorage.ts`/`d1DeskTurnStorage.ts`）。`DeskTurnStorage` 这份值得多看一眼：`rollAssistantFloor` 用一整套 `CASE WHEN`/`json_valid` 拼出的乐观并发 `UPDATE ... WHERE`，SQL 语法换了数据库要重写，但校验逻辑（"提交前楼层内容必须和生成开始时的快照完全一致，否则拒绝"）是合同要求，不能丢。

`SemanticSearchAdapter`（`src/core/storage.ts`）是第七个、独立于 `StorageAdapter` 的可选合同：`upsert`/`delete`/`search` 三个方法。不传就相当于没开语义检索，`StudyService.search()` 会返回 `{ success: false, capability: 'disabled' }`，其余功能不受影响。参考实现是 `examples/cloudflare/adapters/vectorizeSemanticSearch.ts`（Vectorize + Workers AI 做 embedding）。

## 二、模型

`ModelBackend`（`src/core/modelBackend.ts`）只有一个方法：

```ts
interface ModelBackend {
  streamChat(args: StreamChatArgs): Promise<StreamChatResult>;
}
```

`StreamChatArgs` 带 `system`（`{ text, cache }[]`）、`prompt`（string）、`model`、可选 `signal`、可选 `onEvent` 回调（用于把 `text`/`thinking`/`usage`/`ping` 事件转发给你自己的 SSE/WebSocket 层）。`StreamChatResult` 只有两种形态：

```ts
| { ok: true; terminal: 'clean'; text: string; thinking: string; usage: ModelUsage; stopReason?: string }
| { ok: false; kind: 'config'|'http'|'timeout'|'aborted'|'protocol'|'limit'|'empty'|'fetch'; detail?: string; usage?: ModelUsage }
```

**这是本仓唯一的可注入模型合同。** `TavernStudyHost` 构造时传入的 `model` 就是这个接口，`generateDeskTurn`/`foldDeskTimeline`/`refreshDeskBoard` 全部通过它调用模型，不关心背后是 Anthropic 还是别的什么。参考实现是 `src/adapters/streamModelBackends.ts` 的 `AnthropicStreamBackend`，直连 Anthropic Messages 流式 API，把 SSE 事件解析成上面这套 `text`/`thinking`/`usage` 事件流。

**注意一个不对称之处：** `examples/cloudflare/` 参考 Worker 自己的打字桌聊天/时光带折叠/状态板重算路由（`src/chat/desk.ts`/`src/chat/deskTimeline.ts`/`src/chat/deskBoardRefresh.ts`）**不经过 `TavernStudyHost`**，是直接拼 D1 存储写的。其中打字桌聊天用的还是上面这个 `AnthropicStreamBackend`（`ModelBackend` 接口），但时光带折叠和状态板重算用的是 `src/chat/modelBackend.ts` 里的 `completeText`——一个独立的、**协议钉死 Anthropic Messages、不可注入替换**的一次性调用函数，专供这两条参考路由使用，不是 `ModelBackend` 接口的一部分。如果你想让这两个功能换模型供应商，要么直接改 `src/chat/modelBackend.ts`，要么改用 `TavernStudyHost.foldDeskTimeline()`/`refreshDeskBoard()`——这两个方法走的是注入的 `ModelBackend.streamChat`，天然可替换。

**换端点不换协议的轻量出口：** 上面三条参考路由都认可选环境变量 `ANTHROPIC_BASE_URL`（普通 var，不是 secret）——填一个 **Anthropic 兼容网关的完整 Messages 端点 URL**（如 `https://your-gateway.example.com/v1/messages`），三条生成链就都改打这个端点，线协议仍是 Anthropic Messages。仅认 https、URL 内嵌凭据会被拒；配了但非法——**包括配成空值**——会得到明确报错（`bad_base_url`/`config`），不会悄悄回落官方端点。网关背后接的是什么模型、是否忠实实现 Messages 协议，由网关自己负责——本仓不为任何网关做适配承诺。不配这个变量 = 直连 `api.anthropic.com`。

### 自建网关：NDJSON 协议参考

本仓不带任何网关实现——上面两条路径要么直连 Anthropic，要么走你自己实现的 `ModelBackend`。如果你不想直连模型供应商，而是想在中间架一层自己的网关服务（统一鉴权、限流、多模型路由……），下面是一份可以参考的网关线协议形状，自架者照这份协议自己写一个消费它的 `ModelBackend` 实现（本仓不提供）：

- 传输：NDJSON（每行一个 JSON 对象）流式响应。
- 帧类型（`t` 字段区分）：
  - `t: 'd'`：一段增量数据，具体字段（如正文片段）由网关自行约定。
  - `t: 'think'`：一段思考过程增量。
  - `t: 'end'`：终态帧，必须带 `ok`（boolean）和 `usage`；这是流唯一的成功/失败判定点。
  - 另外两种控制帧：`limit`（额度/限流类失败）、`ping`（心跳，不代表任何内容进度）。

**大字铁句：收到 EOF 不等于成功。只有观察到合法的 `end` 帧、且该帧 `ok:true`，才允许把这次生成结果当作成功轮次提交入库。** 连接被服务端悄悄断开、代理超时、网络中断都会产生"看起来正常结束"的 EOF，但没有 `end` 帧、或 `end` 帧 `ok:false`，必须一律按失败处理——这条规矩和 `AnthropicStreamBackend` 对 Anthropic 原生 SSE 强制要求合法 `message_stop` 终态是同一个纪律，换协议不换纪律。

## 三、部署（以 `examples/cloudflare/` 为例）

三步接线：

1. **改名占位符。** 复制 `wrangler.toml`，把 `database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"` 换成你自己的 D1 database id；如果要开语义检索，把 `index_name = "REPLACE_WITH_YOUR_VECTORIZE_INDEX"` 也换掉，否则删掉 `[[vectorize]]`/`[ai]` 两段（`StudyService`/`assembleDesk` 会在缺绑定时自动降级，不需要代码改动）。
2. **建库。** 全新数据库用 `npm run db:init:local`（跑 `examples/cloudflare/schema/init.sql`）；已有数据库用 `npm run db:migrate:local`（跑 `examples/cloudflare/schema/migrations/` 下按序号排列的迁移文件）。这两个 script 都带 `--local`，只落在 wrangler 本地模拟环境；部署到真实 D1 时把 `wrangler d1 execute .../wrangler d1 migrations apply ...` 命令里的 `--local` 换成 `--remote` 自己跑一遍（生产库跑迁移前先备份）。
3. **配 secrets。** `ANTHROPIC_API_KEY`、`AUTH_TOKEN`、`OWNER_TOKEN`（可选 `OWNER_TOKEN_PREVIOUS`/`COMPANION_TOKEN`/`COMPANION_TOKEN_PREVIOUS`）都用 `wrangler secret put <NAME>` 设置，不要写进源码或 `wrangler.toml`。`AUTH_TOKEN` 单独网关 `/{AUTH_TOKEN}/api/oc/*` 写手管理面；`OWNER_TOKEN`/`COMPANION_TOKEN` 是 Bearer token，网关 MCP 和发布/评论路由（细节见 README「MCP 面」一节）。

`npm run build` 是 `wrangler deploy --dry-run --outdir dist`（干跑，不实际发布），`npm run release:check` 在此基础上再跑 typecheck/test/hygiene 扫描。真正发布用你自己的 `wrangler deploy`。

本地开发两个易冤枉人的坑：①`wrangler dev` 的 secrets（`.dev.vars`）**只在启动时读一次**，改了钥匙必须重启 dev server，热重载不管这个；②重启前把旧实例真正杀干净——wrangler 的 workerd 子进程可能残留并继续霸着端口用旧配置接客，表现为"明明配了却报没配"。确认端口上只有一个监听者再排障。

**frontend 两个环境变量：** 复制 `frontend/.env.example` 为 `frontend/.env.local`，填：

```
NEXT_PUBLIC_WORKER_URL=https://your-worker.example.workers.dev
NEXT_PUBLIC_AUTH_TOKEN=replace-with-your-own-auth-token
```

前端把每个 API base 拼成 `${NEXT_PUBLIC_WORKER_URL}/${NEXT_PUBLIC_AUTH_TOKEN}`，对应上面写手管理面的路径 token 网关。这两个变量在构建时内联进静态导出的产物里，不是运行时可改的密钥——换 token 要重新构建前端。

## 四、MCP：注册给自家 AI

`TavernStudyMcpServer`（`src/mcp/server.ts`）只暴露 `shelf`/`bookclub` 两个工具，见 README「MCP 面」一节的完整 action 面、scope 要求。这里补充"怎么接进自己的宿主"：

1. 构造好 `StorageAdapter`/`ModelBackend`，new 一个 `TavernStudyHost`。
2. 在你的 MCP 传输层（HTTP/WebSocket/stdio，随你）收到请求时，先在传输边界完成鉴权（校验 Bearer token，见 `src/auth.ts` 的 `authenticate()`/`hasScope()`，或者你自己的鉴权逻辑），得到一个 `AuthContext`。
3. 用这个 `AuthContext` 和 `host` 构造 `new TavernStudyMcpServer(host, authContext)`，调用 `.handle(request)` 处理单条 JSON-RPC 请求。**每个 MCP 会话一个独立 server 实例**，不要跨客户端复用（`initialized` 状态和 `auth` 都绑定在实例上）。

给自家 AI（companion）的姿势：把 `COMPANION_TOKEN` 当 Bearer token 交给它，它按标准 MCP 客户端协议连接你的传输层——先 `initialize`，再按需 `tools/list`/`tools/call`。`COMPANION_TOKEN` 默认只能看到 `bookclub`（`published:read`+`comments:read`），看不到 `shelf`（需要 `study:read`，只有 `OWNER_TOKEN` 有）；想让它也能发评论，把 `COMPANION_COMMENT_WRITE` 设成 `"true"`。owner 自己接入时用 `OWNER_TOKEN`，两个工具都能看到。
