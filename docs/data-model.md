# 数据模型

这一页把 `examples/cloudflare/schema/init.sql` 里的表结构逐张摘出来，给"接自己数据库"的人照着建表用——不管你最终落在 SQLite、Postgres 还是别的地方，字段和关系是同一套，只是 SQL 方言要自己翻译。

**D1/SQLite 只是参考方言，不是合同的一部分。** `StorageAdapter`（`src/core/storage.ts`）合同只关心方法签名和返回的 TypeScript 类型（`src/core/types.ts`），不关心你后面是什么数据库。下面每张表列出的字段是 D1 参考实现的选择，你完全可以换成别的列名/类型/拆分方式，只要你写的 adapter 能满足对应的存储接口。

参考实现的公共写法：布尔字段用 `INTEGER CHECK(x IN (0,1))`，JSON 结构用 `TEXT` 存字符串化后的 JSON（`lore_keys`/`tags`/`variants`/`report`/`overrides`/`injection`/`meta` 等都是这样），时间戳用 ISO 字符串而不是数据库原生时间类型。

## `schema_versions`

迁移进度标记，只有一行会被 `INSERT` 更新。

| 字段 | 含义 |
|---|---|
| `version` (PK) | 当前已应用的迁移版本号 |
| `applied_at` | 应用时间 |

## `memories`（书房笔记 / `StudyEntry`）

对应 `StudyStorage`（`src/core/storage.ts`）。project 到 category 到 tag 是三层过滤维度；`lore_*` 字段是同一条记录被打字桌世界书系统复用时的额外字段（一条书房笔记既可以是纯笔记，也可以是打字桌的世界书/角色卡条目）。

| 字段 | 含义 |
|---|---|
| `id` (PK) | 笔记 id |
| `project` | 所属项目/故事线，空字符串表示未分类 |
| `category` | `world`/`plot`/`outline`/`session` 四选一 |
| `title` | 标题 |
| `tags` | JSON 字符串数组 |
| `chapter` | 关联章节标记（自由文本） |
| `content` | 正文 |
| `lore_keys` | JSON 字符串数组，世界书触发关键词（子串匹配，见 README 兼容边界矩阵） |
| `lore_position` | `before`/`after`，世界书命中后插入 system 的位置 |
| `is_char` | 是否作为"角色卡"参与打字桌在场角色判定 |
| `lore_constant` | 是否常驻（不看关键词，永远命中） |
| `trigger_mode` | `scan`（正文子串扫描）/`presence`（只看结构化在场名单，本项目扩展） |
| `lore_enabled` | 是否参与世界书装配 |
| `lore_fields` | JSON 对象，角色卡结构化字段（description/personality/scenario/mes_example 等），支持手填，也可从 SillyTavern V1/V2/V3 角色卡文件导入（`src/core/characterCard.ts` + `src/tools/desk.ts` `importCharacterCard`） |
| `created_at`/`updated_at` | 时间戳 |

索引：`(project, category, updated_at DESC)`，服务列表页的默认排序/过滤。

## `oc_chapters`（发布章节 / `Chapter`）

对应 `ReadingStorage`。草稿与已发布共用一张表，`status` 区分。

| 字段 | 含义 |
|---|---|
| `id` (PK) | 章节 id |
| `project` | 所属项目 |
| `chapter_no` | 章节序号（自由文本，非严格递增数字） |
| `title` | 标题 |
| `content` | 正文 |
| `summary` | 摘要，用于列表预览 |
| `status` | `draft`/`published` |
| `published_at` | 发布时间，草稿为空 |
| `created_at`/`updated_at` | 时间戳 |

索引：`(project, status, chapter_no, id)`，发布列表的过滤+排序。

## `oc_comments`（评论 / `ChapterComment`）

对应 `ReadingStorage.createPublishedComment`/`listPublishedComments`。支持一层回复（`reply_to` 必须指向同一章节的评论，两条触发器强制这一约束，见下）。

| 字段 | 含义 |
|---|---|
| `id` (PK) | 评论 id |
| `chapter_id` | 所属章节，`ON DELETE CASCADE` |
| `reply_to` | 父评论 id，可空；`ON DELETE CASCADE` |
| `author_id` | 评论者 id（`AuthContext.actorId`，如 `owner`/`companion`） |
| `author_type` | `owner`/`ai` |
| `display_name` | 展示名 |
| `content` | 正文，长度限制 1–2000 字符（`CHECK` 约束） |
| `created_at` | 时间戳 |

索引：`(chapter_id, created_at, id)`，游标分页用。

触发器 `comments_reply_same_chapter_insert`/`_update`：插入或更新时如果 `reply_to` 指向的父评论不在同一 `chapter_id` 下，直接 `RAISE(ABORT)`。跨章节回复在存储层就会被拒绝，不依赖应用层校验。

## `comment_rate_buckets`（评论限流）

按分钟窗口计数，`dimension` 区分是按 actor 限流还是按 IP（哈希后）限流。

| 字段 | 含义 |
|---|---|
| `dimension` | `actor`/`ip` |
| `subject` | actor id 或 IP 哈希 |
| `minute_bucket` | 分钟粒度的时间桶（ISO 字符串截到分钟） |
| `request_count` | 该桶内已计数的请求数 |
| `updated_at` | 最后更新时间 |

主键 `(dimension, subject, minute_bucket)`。触发器 `comment_rate_limit_guard`：`request_count` 更新到超过 5 时 `RAISE(ABORT)`，把限流判断下推到数据库层，避免读-改-写之间的竞态。这张表是参考 Worker 自己的限流实现，不是 `StorageAdapter` 合同的一部分——换存储时可以用别的限流方案代替。

## `oc_state`（键值状态）

打字桌的核心记忆（`desk_core:{project}`）等零散状态用这张表存，对应 `DeskStoryStorage.getState`。

| 字段 | 含义 |
|---|---|
| `key` (PK) | 状态键 |
| `value` | 状态值（字符串，通常是 JSON 字符串化） |
| `updated_at` | 时间戳 |

## `usage_log`（模型用量记账）

每次模型调用（不论成功失败）记一笔，供成本追踪用；不是 `StorageAdapter` 合同的一部分，是参考 Worker 自己的记账实现（`src/storage/usageSink.ts`）。

| 字段 | 含义 |
|---|---|
| `id` (PK) | 记录 id |
| `channel` | 调用来源（desk chat / timeline fold / board refresh 等） |
| `model` | 模型标识 |
| `input_tokens`/`output_tokens`/`cache_read_tokens`/`cache_write_tokens` | 用量 |
| `status` | 成功/失败标记 |
| `created_at` | 时间戳 |

## 打字桌资产表（`DeskAssetStorage`/`DeskStorage`/`DeskTurnStorage`）

### `desk_presets`（预设包）

导入的 ST 预设文件，一份预设包对应一行。

| 字段 | 含义 |
|---|---|
| `id` (PK) | 预设包 id |
| `name` | 名称 |
| `raw_json` | 原始预设 JSON（原样保存，供导出/追溯） |
| `params` | JSON，解析出的参数快照 |
| `block_count` | 积木块数量 |
| `created_at` | 时间戳 |

### `desk_blocks`（预设积木块）

对应导入器解析出的 prompt 积木（`DeskPromptBlock`）。见 README 兼容边界矩阵："只认 prompt_order 第一份"。

| 字段 | 含义 |
|---|---|
| `id` (PK) | 内部 id（`{preset_id}:{identifier}`） |
| `preset_id` | 所属预设包 |
| `identifier` | ST 原始 identifier（UUID 或 `main`/`worldInfoBefore` 等保留字） |
| `name` | 积木名称 |
| `role` | `system`/`user`/`assistant` |
| `content` | 积木正文 |
| `marker` | 是否为保留字占位块（决定是否走特殊展开，见 README） |
| `injection` | JSON，`injection_position`/`injection_depth`/`injection_order`（**只解析落库，装配时不参与排序**，见 README） |
| `in_queue` | 是否在 `prompt_order` 队列里 |
| `queue_pos` | 队列位置（装配排序唯一依据） |
| `enabled_default` | 队列里的默认启用状态 |

唯一约束 `(preset_id, identifier)`；索引 `preset_id`。

### `desk_recipes`（配方）

把一份预设 + 覆盖参数 + 正则选择绑定到一个项目，是打字桌真正拿来装配上下文的单位。

| 字段 | 含义 |
|---|---|
| `id` (PK) | 配方 id |
| `project` | 所属项目 |
| `name` | 名称 |
| `preset_id` | 引用的预设包 |
| `weight` | `light`（跳过预设队列，只用 `light_system`）/`heavy`（走完整预设队列装配） |
| `overrides` | JSON，按 identifier 覆盖 enabled/pos |
| `regex_ids` | JSON 字符串数组，引用的正则规则 |
| `params` | JSON，模型参数覆盖 |
| `light_system` | 轻配方模式下直接使用的 system 文本 |
| `created_at`/`updated_at` | 时间戳 |

索引：`project`。

### `desk_regex`（正则规则）

ST 正则脚本子集：`find`/`replace`/`flags`/`direction`。见 `src/tools/deskMacro.ts` 的方言说明（`{{match}}` 翻译成 `$&`，只跑在楼层正文上，不跑在预设积木上）。

| 字段 | 含义 |
|---|---|
| `id` (PK) | 规则 id |
| `scope` | `preset`（挂在某个预设包下）/`global` |
| `preset_id` | `scope='preset'` 时的所属预设包 |
| `name` | 名称 |
| `find` | 匹配正则（字符串） |
| `replace` | 替换字符串（支持 ST 的 `{{match}}` 写法） |
| `flags` | 正则 flags |
| `direction` | `up`（应用于楼层原文）/`down`（应用于渲染输出）/`both` |
| `enabled` | 是否启用；导入时编译失败的规则会被强制降级为禁用 |
| `meta` | JSON，`invalid`/`unsafe` 等标记（ReDoS 防御用，见 `src/shared/regexSafety.ts`） |
| `sort_order` | 应用顺序 |

### `desk_windows`（打字桌窗口）

一个"聊天窗口"实例，绑定一个配方，持有状态板/时光带/变量池。

| 字段 | 含义 |
|---|---|
| `id` (PK) | 窗口 id |
| `project` | 所属项目 |
| `title` | 标题 |
| `recipe_id` | 使用的配方 |
| `note` | 作者笔记（导演note） |
| `note_depth` | 笔记插入深度 |
| `state_board` | JSON，当前状态板（在场角色/开放线索等结构化字段） |
| `timeline_state` | JSON，`{ segs: [...], cutoff, rev }`——时光带摘要段数组（硬顶 20 段）、折叠截止点、版本号 |
| `vars` | JSON，宏变量池（`{{setvar}}`/`{{getvar}}`） |
| `created_at`/`updated_at` | 时间戳；`updated_at` 同时是乐观并发锁的版本戳（见 `DeskStorage.updateTimelineState` 的 `expectedUpdatedAt` 参数） |

索引：`project`。

### `desk_floors`（楼层）

一问一答的最小单位；`variants` 支持同一楼层的多个候选版本（reroll 历史）。

| 字段 | 含义 |
|---|---|
| `id` (PK) | 楼层 id |
| `window_id` | 所属窗口 |
| `role` | `user`/`assistant` |
| `content` | 当前生效正文（等于 `variants[active_variant]`） |
| `variants` | JSON 字符串数组，历史候选版本 |
| `active_variant` | 当前选中的 variant 下标 |
| `thinking` | 模型思考过程（可空） |
| `report` | JSON，装配报告 + `boardBefore`/`boardAfter` 快照（`roll` 重生成时用来找回生成时刻的状态板，见 `TavernStudyHost.generateDeskTurnLocked`） |
| `created_at` | 时间戳，同时是楼层排序依据 |

索引：`(window_id, created_at)`。

`DeskTurnStorage`（`commitAssistantFloor`/`rollAssistantFloor`）没有单独的表——它是对 `desk_floors`/`desk_windows` 的原子写入约束：一次成功的模型轮次要同时写入新楼层内容和更新窗口的状态板/时光带引用，`roll` 场景还要额外校验目标楼层没有在生成期间被并发修改（乐观并发），细节看 D1 参考实现 `examples/cloudflare/adapters/d1DeskTurnStorage.ts`。
