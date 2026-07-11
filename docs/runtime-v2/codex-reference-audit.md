# Codex CLI Harness（运行框架）官方参考审计

## 审计边界

- 唯一主要参考：[`openai/codex`](https://github.com/openai/codex)。
- 固定提交：`9e552e9d15ba52bed7077d5357f3e18e330f8f38`。
- 提交时间：`2026-07-11T21:03:12Z`。
- 上游许可证：Apache License 2.0；仓库根目录 `LICENSE` 和 `NOTICE` 均已核对。
- 本文只做架构与可移植性审计，不代表已经移植，也不构成法律意见。若复制实现代码，NovelX 必须保留许可证、版权与 NOTICE（声明）义务，并记录来源文件与固定提交。

## 总结判断

NovelX 不应该“把 Codex 换个 Prompt（提示词）”。应复用的是 Codex 的 Harness 分层原则：

```text
Thread（线程/会话）
  -> Turn（回合）
    -> Item/Event（条目/事件）
      -> Tool Call（工具调用）
        -> Domain Side Effect（领域副作用）
  -> Rollout（追加式运行记录）
  -> Context Window（模型上下文窗口）
  -> Compaction + Recovery（压缩与恢复）
```

NovelX 必须重写领域语义：项目、世界、OC（原创角色）、故事、正史、草稿、Change Set（变更集）、Free / Assist（自由/协助）、Checker（检查器）、玩家存档与世界包都不是 Codex 的代码编辑语义。

## 1. Core（核心运行层）

**官方证据**

- `codex-rs/core/src/codex_thread.rs`：`CodexThread` 是双向消息流入口，并保存线程级配置快照。
- `codex-rs/core/src/session/session.rs`：`Session` 明确约束“一个会话最多同时运行一个任务，可被用户输入中断”。
- `codex-rs/core/src/session/turn.rs`、`turn_context.rs`、`step_context.rs`：把一次用户请求、回合配置和模型步骤分层。
- `codex-rs/core/src/thread_manager.rs`：管理活动线程，而不是把模型调用直接塞进 UI。

**NovelX 应复用的概念**

- 每个会话是独立 Agent（代理）运行单元；同一会话只有一个活动 Turn（回合）。
- Thread（线程）保存稳定身份与长期设置，Turn 保存本次覆盖项，Step（步骤）保存一次模型/工具迭代。
- UI 只订阅事件，不直接裁决 Agent 状态。
- 中断、阻塞、等待确认、失败和完成必须是不同终态。

**可选择移植的 Apache-2.0 代码**

- `codex_thread.rs` 中配置快照、单活动任务和消息通道的结构模式。
- `session/turn_context.rs`、`session/step_context.rs` 的不可变上下文拆分方式。
- NovelX 已由 ADR-0003 决定建设聚焦的 Rust Sidecar（伴随进程）`novelx-runtime.exe`。可以在该内核中移植小型纯状态类型或测试思想，但不应机械复制 Codex 整套 Rust 异步对象图和代码领域模块。

**必须重写**

- Thread/Turn/Step 的字段必须包含 NovelX 项目 ID、会话 ID、范围资源、模式、Prompt 版本、Provider（模型服务）配置摘要、世界/故事 Canon（正史）基线和 Change Set 基线。
- 单活动 Turn 之外，后台 Checker、图谱抽取和图像任务需要独立 Job（作业）模型，不能伪装成当前对话 Turn。
- Free / Assist 权限与写入队列必须由主进程和数据库裁决，不能只依赖模型 Prompt。

**不应引入**

- Codex 的代码工作区假设、Git 仓库假设和 Shell（命令行）优先心智。
- 不应把已接受的 Rust Sidecar 决策扩大成完整 Codex CLI 分叉。NovelX 的 sidecar 只承载 ADR-0003 规定的权威运行状态、协议、上下文、工具、恢复、Provider 和策略内核；Electron + React + TypeScript 继续承担桌面宿主与表现层，迁移期保留现有 Pi Agent Worker 作为 legacy path（旧运行路径）。

## 2. Rollout / Event（运行记录 / 事件）

**官方证据**

- `codex-rs/rollout/src/recorder.rs`：`RolloutRecorder` 以追加顺序记录 canonical items（规范条目），支持 create/resume。
- `codex-rs/rollout/src/policy.rs`：持久化策略与运行事件生成分离，不是所有瞬时事件都永久保存。
- `codex-rs/protocol/src/protocol.rs`：`RolloutItem` 与 `EventMsg` 分离。
- `codex-rs/protocol/src/items.rs`：`TurnItem` 包含工具调用和 `ContextCompaction`（上下文压缩）等领域可见条目。
- `codex-rs/rollout-trace/src/reducer/*`：用 Reducer（归约器）从事件重建会话、工具和压缩状态。

**NovelX 应复用的概念**

- 建立 append-only（仅追加）规范运行日志；数据库投影和 UI 活动面板是可重建视图。
- Item（条目）有稳定 ID，并经历 started/completed/failed/blocked 等生命周期。
- 区分“模型历史”“审计记录”“用户可见活动”和“领域正式内容”，禁止混成一张消息表。
- 工具开始与结束必须可配对；崩溃后未闭合调用应被标记 interrupted（中断），不能消失。

**可选择移植的 Apache-2.0 代码**

- `rollout/src/recorder.rs` 的单写入顺序、Create/Resume 参数和批量落盘思想。
- `rollout/src/policy.rs` 的持久化过滤函数模式。
- `rollout-trace/src/reducer` 的“事件为事实、投影可重建”测试方式。

**必须重写**

- NovelX 事件类型：AgentMessage、ToolCall、Retrieval、ChangeSet、CheckerFinding、CanonConflict、DocumentRevision、ImageJob、Compaction、Checkpoint 等。
- 事件载荷必须做来源、项目、会话、Prompt、Provider、资源版本和用户可见性分级。
- SQLite（数据库）仍是正式存储；如引入 JSONL（逐行 JSON）旁路日志，只能作为诊断/导出，不得形成第二权威源。

**不应引入**

- Codex rollout 的目录布局和代码专用事件全集。
- 把原始 reasoning（推理）或 Provider 请求正文永久落盘；这会增加隐私、成本和协议风险。

## 3. Context Manager（上下文管理器）

**官方证据**

- `codex-rs/core/src/context_manager/history.rs`：`ContextManager` 维护 transcript（转录历史），`record_items`、`replace`、rollback 会递增 rewrite epoch（重写代次）。
- 同文件 `is_api_message` 明确模型上下文不只有聊天，还包含 reasoning、tool call、tool output、shell、web search 和 image generation。
- 同文件对图片和加密工具结果做独立 token（令牌）估算修正，而不是把 UTF-8 字节直接等同 token。
- `codex-rs/core/src/context_manager/normalize.rs`、`updates.rs`：规范化和历史更新是独立步骤。

**NovelX 应复用的概念**

- 上下文是有类型的 item 列表，不是拼接字符串。
- 每次重写历史必须增加 revision/epoch（修订代次），缓存和引用必须绑定该代次。
- token 预算分别统计系统协议、会话、工具、检索、图片和输出预留。
- 只有模型可见项进入上下文；审计信息不应自动全部注入模型。

**可选择移植的 Apache-2.0 代码**

- `ContextManager` 的 record/replace/rollback 接口形状和 rewrite epoch 思想。
- 不同 ResponseItem（响应条目）的 token 估算分派和饱和计算方式。
- `history_tests.rs` 中重写、边界和截断测试结构。

**必须重写**

- NovelX 的上下文条目必须包含 Canon assertion（权威断言）、世界资料、角色变体、故事范围、文档引用、会话记忆和冲突状态。
- Tokenizer（分词器）需按实际 Provider/模型选择；不支持精确 tokenizer 时才使用经过校准的保守估算，并明确误差。
- “检查当前项目”应使用轻量工具路径，不能默认装载整个项目或全部世界图谱。

**不应引入**

- Codex 对 shell、代码 diff 和加密 reasoning 的特定估算规则，除非 NovelX 以后正式开放对应能力。
- 继续使用 `Buffer.byteLength(json) <= contextWindowTokens` 这类字节/token 单位混用。

## 4. Compact（上下文压缩）

**官方证据**

- `codex-rs/core/src/compact.rs`：压缩是正式 TurnItem 生命周期，有 pre/post compact hooks（压缩前后钩子）、本地/远端策略和完整状态事件。
- 同文件 `build_compacted_history`：压缩后不是只留摘要，还保留用户消息并在规定位置重新注入 canonical initial context（规范初始上下文）。
- `InitialContextInjection` 区分 manual/pre-turn 与 mid-turn（回合中）压缩的注入位置。
- `codex-rs/core/src/compact_token_budget.rs`：即使不调用摘要模型，token-budget 重置仍作为压缩生命周期记录。
- `codex-rs/prompts/templates/compact/prompt.md`、`summary_prefix.md`：摘要 Prompt 与前缀是版本化资产。

**NovelX 应复用的概念**

- 压缩是可审计事件，不是静默删除消息。
- 压缩结果必须包含可恢复摘要、保留项、来源引用、被省略范围和新上下文窗口编号。
- 压缩后重新注入稳定规则与当前 Canon 基线；不能相信摘要承载全部事实。
- UI 可显示“已压缩上下文”，但不向普通用户暴露内部 JSON。

**可选择移植的 Apache-2.0 代码**

- `compact.rs` 的生命周期编排、初始上下文插入算法及对应测试。
- `collect_user_messages`、summary marker（摘要标记）和窗口编号思想。
- compact hook 的输入/输出契约模式。

**必须重写**

- NovelX 摘要需分层：任务进展摘要、用户意图变化、未决冲突、引用索引；世界事实本身应从正式文档/图谱重新检索，不应只写入自然语言摘要。
- 压缩后必须主动检索当前故事范围、角色状态和规则，而不是仅重新注入巨大固定 Prompt。
- 摘要 Prompt、Provider 与评测门必须纳入现有 Prompt 版本制度。

**不应引入**

- 把 Codex 的 summarization prompt 原文直接当 NovelX 世界记忆方案。
- 宣称压缩无损。Codex 自身会提示长线程和多次压缩降低准确性；NovelX 只能通过正式知识检索降低风险。

## 5. Function Tool（函数工具）

**官方证据**

- `codex-rs/tools/src/tool_executor.rs`：`ToolExecutor` 把 spec（模型可见定义）与 handle（真实执行）绑定；支持 Direct、Deferred、DirectModelOnly、Hidden 暴露级别。
- 同文件默认不允许并行工具调用，工具必须显式声明 `supports_parallel_tool_calls`。
- `codex-rs/tools/src/tool_call.rs`：`ToolCall` 带 turn_id、call_id、tool name、模型、截断策略、历史快照和环境。
- `codex-rs/tools/src/function_call_error.rs`：区分 `RespondToModel`（可反馈模型的失败）与 `Fatal`（致命运行错误）。
- `codex-rs/core/src/function_tool.rs` 只做兼容再导出，真实抽象已下沉到 `codex-rs/tools` crate（组件）。

**NovelX 应复用的概念**

- 工具 Schema（模式）与执行器同源，避免“Prompt 里说有工具、运行时没有”。
- 每次调用必须绑定 run/turn/call/tool，并保留结构化输入输出摘要。
- 工具分直接暴露、延迟发现和隐藏内部工具；工具越多，不应全部塞进初始上下文。
- 将可恢复领域错误返回模型，将协议/权限/运行时错误 fail-closed（失败关闭）。

**可选择移植的 Apache-2.0 代码**

- `ToolExposure`、`ToolExecutor`、`ToolCall` 和双级错误类型的接口思想。
- `tool_spec.rs`、`json_schema.rs` 的 Schema 规范化与测试。
- 并行能力默认 false 的安全默认值。

**必须重写**

- Rust Runtime V2 内的权威工具注册表、执行状态机、策略与审计接口；TypeScript/Zod/TypeBox（类型与模式库）只保留生成或校验后的宿主协议类型及迁移适配层。
- NovelX 工具应按读取、检索、创作候选、正式变更、后台任务分权；写工具绝不能绕过 Change Set。
- 文件不存在必须返回 `PROJECT_FILE_NOT_FOUND`，并引导 list/glob 恢复，不能伪装成授权失败。

**不应引入**

- 任意动态代码执行来注册小说工具。
- 让模型决定工具是否有权限，或让工具描述代替主进程授权。

## 6. MCP Tool Call（MCP 工具调用）

**官方证据**

- `codex-rs/core/src/mcp_tool_call.rs`：统一执行 started -> approval -> execute -> completed/skip 生命周期。
- 同文件区分 session approval（会话许可）与 persistent approval（持久许可），并通过稳定 key 记忆授权。
- 工具结果分别做 model sanitization（模型输入净化）与 event truncation（事件展示裁切）。
- `codex-rs/protocol/src/items.rs`：`McpToolCallItem` 有独立状态、结果与错误结构。
- `codex-rs/app-server-protocol/src/protocol/v2/item.rs`：MCP 工具条目被投影到客户端协议，而不是渲染器猜文本。

**NovelX 应复用的概念**

- MCP 或插件工具也必须进入统一 ToolCall 生命周期、审批、审计和 UI Artifact（产物）模型。
- 模型看到的结果和 UI/审计看到的结果可以是不同投影，但必须来自同一规范结果。
- 授权决定有明确作用域：单次、会话、项目或持久；默认不能无限扩权。

**可选择移植的 Apache-2.0 代码**

- started/completed/skip 配对、approval key、结果净化与事件裁切的纯函数和测试思想。
- `McpToolCallStatus` 与结构化错误字段设计。

**必须重写**

- NovelX 插件权限要按项目文件、世界包、图像、网络、发布等领域能力表达。
- Free / Assist 不能等同 MCP 的 allow/deny；内容进入正文/正史仍需 Change Set 与冲突检查。
- 秘钥、Provider、用户文稿和版权来源要有独立敏感字段策略。

**不应引入**

- Codex Apps、ChatGPT connector（连接器）认证和 Guardian（自动审批审查）全套实现。
- 在基础闭环前开放第三方 MCP 市场；这会扩大攻击面和支持成本。

## 7. Exec Policy（执行策略）

**官方证据**

- `codex-rs/core/src/exec_policy.rs`：把规则匹配、启发式判断、审批策略和 sandbox（沙箱）升级分开。
- `prompt_is_rejected_by_policy` 明确：当审批策略禁止询问用户时，不能弹窗绕过策略。
- `ExecPolicyManager` 生成审批需求，并支持前缀规则 amendment（修订）。
- `exec_policy_windows_tests.rs` 专门覆盖 PowerShell（Windows 命令行）包装与 Windows 行为。

**NovelX 应复用的概念**

- 权限策略先于 Prompt，并由宿主执行。
- policy decision（策略决定）、用户审批和实际执行是三个阶段。
- 策略拒绝时 fail-closed，不允许 Agent 自己换措辞继续执行。

**可选择移植的 Apache-2.0 代码**

- 决策枚举、审批需求、拒绝原因和“策略不允许弹窗时直接拒绝”的纯逻辑。
- Windows 专项测试思路。

**必须重写**

- NovelX 需要 Content/Project Policy（内容与项目策略），对象是 read/write/delete/publish/import/image/network，而不是 argv 命令前缀。
- 文件写入仍由项目根限制、风险评估、SHA-256 并发保护和 Change Set 决定。

**不应引入**

- 第一版不要开放 Shell、脚本执行和 Codex execpolicy 规则语言。用户已明确小说插件不等于在小说内运行代码。
- 不要把 Codex 沙箱当作开放任意命令的理由；NovelX 当前没有该产品需求。

## 8. App Server Protocol（应用服务协议）

**官方证据**

- `codex-rs/app-server-protocol/src/protocol/common.rs`：JSON-RPC 方法显式区分 `thread/start`、`turn/start` 以及对应 notifications（通知）。
- `protocol/v2/thread.rs`：ThreadStart/Resume/Fork/Archive/Delete/Read/List/Compact 均为结构化 API；Resume 优先推荐 thread_id，并支持 history/path 恢复。
- `protocol/v2/turn.rs`：TurnStart/Steer/Interrupt 与 started/completed 通知分离。
- `protocol/v2/item.rs`：消息、工具、文件变更、MCP、压缩等都是 tagged union（带标签联合类型）；流式 delta 与 completed item 分离。
- `schema/json`、`schema/typescript`：协议可导出 JSON Schema 和 TypeScript 类型。

**NovelX 应复用的概念**

- 主进程与 UI 使用版本化命令/响应/通知协议；所有消息有稳定方法名和结构化 Schema。
- Thread、Turn、Item 三层 ID 不混用。
- 流式 delta 只是临时显示，completed item 才是最终规范条目。
- Resume、Fork、Archive、Delete 是一等能力，不依赖 UI 临时状态。

**可选择移植的 Apache-2.0 代码**

- v2 thread/turn/item 的命名分层、状态枚举、分页和 Schema 导出方式。
- 客户端协议 fixture（夹具）与兼容测试思路。

**必须重写**

- Electron 宿主与 `novelx-runtime.exe` 之间的版本化双向 JSON-RPC Runtime v2 协议；初始采用 Windows-safe stdio（Windows 安全标准输入输出）传输，至少含 project/session/turn/item/tool/change-set/context/checkpoint/job。
- 协议必须使用中文用户展示字段与内部稳定 ID 分离；不得向玩家 UI 泄露内部 JSON、英文资产 ID 或 source debug。
- 协议升级需要 capability/version negotiation（能力/版本协商），不能依赖前后端同时更新的隐含假设。

**不应引入**

- 直接复制 Codex 数百个 API、实验字段和代码执行通知。
- 不应把本地 sidecar 协议扩大成开放网络服务。遵循 ADR-0003，初始使用 stdio JSON-RPC；未来可改 named pipes（命名管道），但不改变领域消息，也不默认暴露监听端口。

## 9. Session / Recovery（会话 / 恢复）

**官方证据**

- `codex-rs/core/src/session/rollout_reconstruction.rs`：从 rollout 与 context window 重建活动窗口，并处理 compaction replacement history（压缩替换历史）。
- `codex-rs/rollout/src/recorder.rs`：Resume 使用已有 path，并维持规范写入顺序。
- `app-server-protocol/src/protocol/v2/thread.rs`：Resume 支持 thread_id、history、path，并定义明确优先级；Fork 与 Resume 分开。
- `codex-rs/state/src/runtime/recovery.rs`：SQLite 损坏时只备份损坏数据库及 sidecar（旁路文件），不丢弃其他独立数据库。
- `codex-rs/cli/src/state_db_recovery.rs`：CLI 启动层调用恢复逻辑，而不是让业务查询自行吞掉损坏。

**NovelX 应复用的概念**

- 启动时先恢复未闭合 Turn/Tool，再开放 UI 操作。
- Resume（继续原会话）、Fork（从历史创建分支）和 Restore Checkpoint（恢复项目状态）是三种不同语义。
- 数据库损坏恢复应先备份证据，再局部重建；不能自动删除整个项目数据库。
- 恢复过程产出可审计记录和用户可理解状态。

**可选择移植的 Apache-2.0 代码**

- `state/src/runtime/recovery.rs` 的 SQLite corruption（损坏）识别、唯一备份目录和主文件/WAL/SHM 一组迁移算法。
- `rollout_reconstruction.rs` 的“压缩窗口 + 追加事件”重建思路和测试。

**必须重写**

- NovelX 需要同时恢复全局项目注册库、项目 workspace.db、Rust Runtime V2 运行状态、迁移期 legacy Agent Worker、文件快照和 Change Set 写入队列。
- 磁盘文件与数据库事务跨边界失败时，需要项目文件快照回滚及恢复日志。
- 玩家时间线、创作分支和会话 Fork 必须使用不同数据模型，不能用“回滚消息”冒充项目历史。

**不应引入**

- 仅靠 JSONL rollout 作为项目事实恢复源。
- 遇到数据库错误就新建空库并静默继续；这会造成用户误以为内容消失。

## 推荐的 NovelX Runtime v2 最小目标架构

这里的“最小”指最小正确边界，不是功能缩水或假实现：

```text
Renderer（渲染进程）
  <-> Electron Main Host（Electron 主进程宿主）
       - Desktop lifecycle / packaging
       - UI IPC adapter
       - Project path and OS integration
  <-> versioned stdio JSON-RPC
Rust Runtime V2 Sidecar（Rust Runtime V2 伴随进程）
  - Authoritative Thread / Turn / Item state
  - Tool registry + policy + Change Set gate
  - Typed context manager + compaction
  - Provider loop + retries + cancellation
  - Append-only runtime event store
  - Projection / recovery
  <-> Legacy Pi Agent Worker（迁移期旧 Agent 工作进程，仅兼容路径）

Authoritative stores（权威存储）
  - application.db
  - per-project workspace.db
  - project files + content-addressed snapshots
```

## 建议实施顺序

1. 先冻结 Rust Runtime v2 的 Thread/Turn/Item/ToolCall 状态机和 JSON-RPC Schema。
2. 在 sidecar 中建立 append-only RuntimeEvent 表和可重建投影；旧审计表暂作兼容来源。
3. 建立 Rust ToolRegistry（工具注册表），并通过迁移适配器接入现有 Agent Worker，区分领域错误与致命错误。
4. 引入 typed ContextItem（类型化上下文条目）和逐项 token 预算。
5. 实现可审计压缩，摘要只保存任务状态，正式事实压缩后重新检索。
6. 实现启动恢复：未闭合 Turn/Tool、待审 Change Set、Worker 中断和数据库备份。
7. 最后再考虑 MCP/Plugin（插件）；Shell/代码执行不在 Runtime v2 基础范围。

## 直接移植清单与许可证记录要求

若后续实际复制上游代码，建议仅限以下低耦合部分，并逐文件记录来源：

| 候选 | 官方路径 | 建议 |
|---|---|---|
| SQLite 损坏识别与备份算法 | `codex-rs/state/src/runtime/recovery.rs` | 可较直接移植到 Rust sidecar，补 Windows 文件占用测试 |
| 压缩后初始上下文插入算法 | `codex-rs/core/src/compact.rs` | 可移植纯函数与测试，领域摘要必须重写 |
| 工具暴露与错误分级 | `codex-rs/tools/src/tool_executor.rs`、`function_call_error.rs` | 移植接口思想或小型枚举 |
| Rollout 持久化过滤 | `codex-rs/rollout/src/policy.rs` | 移植纯策略模式，事件类型重写 |
| Thread/Turn/Item 协议分层 | `codex-rs/app-server-protocol/src/protocol/v2/*` | 借鉴类型结构，不复制完整协议面 |

每次移植必须在 NovelX 源文件头或第三方清单中至少记录：上游仓库、固定提交、原文件路径、Apache-2.0、修改说明，并随发行物保留适用的 `LICENSE`/`NOTICE`。其余部分优先 clean-room rewrite（洁净重写），因为 NovelX 与 Codex 的语言、数据权威源、权限对象和用户领域均不同。

## 最大风险

- 最大技术风险不是“工具不够多”，而是继续让消息文本同时承担协议、记忆、审计和正式事实。Codex 的结构化 Item/Event 分层正是要避免这种混杂。
- 最大产品风险是把代码 Agent 的 Shell/沙箱复杂度提前带入小说产品，拖慢核心创作闭环并扩大安全面。
- 最大记忆风险是把 compaction summary（压缩摘要）误认为权威记忆。NovelX 的正式事实必须仍从版本化文档、断言图谱和当前故事范围检索。
- 最大恢复风险是存在多个“看似权威”的日志和数据库。Runtime v2 必须明确 SQLite + 项目文件版本链的权威关系，事件日志只记录运行事实和重建投影。
