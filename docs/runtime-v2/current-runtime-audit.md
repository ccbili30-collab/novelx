# NovelX 当前 Agent Runtime（Agent 运行时）审计

审计日期：2026-07-12  
范围：桌面端 Steward（大管家）对话链，不包含 Player/GM（玩家/游戏主持人）和 Decomposer（拆解器）的完整内部链。  
方法：只读 TypeScript 源码；未以测试、Prompt（提示词）或产品描述替代真实调用关系。

## 1. 结论

当前运行时是一个 Electron（桌面运行壳）主进程监管、独立 Node Worker（工作进程）执行 Pi Agent、主进程独占项目文件与 SQLite（数据库）写入的单机架构。安全边界基本正确：Renderer（渲染进程）不直接访问 Provider（模型服务）、项目数据库或文件系统；Worker 不直接持有数据库；模型写入必须通过主进程工具网关和 Change Set（变更集）。

主要结构性问题不是“没有分层”，而是状态和终态分散：

- 会话消息与 UI 会话状态属于全局 `application.db`。
- 项目审计、事实、文档、Change Set、Checkpoint（检查点）属于项目 `.novax/workspace.db`。
- 项目原始文件属于工作区磁盘目录。
- 活跃运行、待处理工具、AbortController（取消控制器）只存在于内存。
- Provider 调用、工具调用、审计写入、会话落库之间没有端到端事务或可重放日志。

因此，进程退出或跨数据库写入失败时，系统可能留下“用户消息已保存，但运行审计未开始”“项目变更已提交，但助手消息未保存”或“会话长期停留 working”等可观察不一致。

## 2. 真实调用链

```mermaid
sequenceDiagram
    participant UI as Renderer: StewardRuntimePanel
    participant Preload as Preload: novaxDesktop.agent
    participant Main as Main: registerDesktopIpc
    participant Registry as application.db
    participant Sup as AgentProcessSupervisor
    participant ProjectDB as .novax/workspace.db
    participant Worker as agent-worker/index
    participant Runtime as StewardRuntime + StateMachine
    participant Pi as Pi Agent Adapter
    participant Provider as OpenAI-compatible Provider
    participant Gateway as WorkspaceAgentToolGateway
    participant Files as Project Files

    UI->>Preload: agent.start(request)
    Preload->>Main: ipcRenderer.invoke(agentStart)
    Main->>Registry: validate session/project; load history/context
    Main->>Registry: append user message; state=working
    Main->>Sup: start(request, history, collaboration)
    Sup->>ProjectDB: beginRun audit
    Sup->>Worker: fork + run.start over process IPC
    Worker->>Runtime: runStewardRuntime
    Runtime->>ProjectDB: audit.request invocation.started
    Runtime->>Pi: adapter.run(prompt, history, tools, guard)
    Pi->>Provider: streamSimple(context, tools)
    Provider-->>Pi: text/tool deltas
    Pi->>Worker: projected tool events
    Worker->>Sup: tool.request
    Sup->>ProjectDB: beginTool audit
    Sup->>Gateway: invoke validated tool
    Gateway->>ProjectDB: retrieval/audit/Change Set
    Gateway->>Files: list/read/search or versioned mutation
    Gateway-->>Sup: typed result/error
    Sup->>ProjectDB: tool terminal audit
    Sup-->>Worker: tool.response
    Worker-->>Provider: continue Agent loop
    Provider-->>Runtime: submit_steward_result
    Runtime->>ProjectDB: invocation.terminal audit
    Worker-->>Sup: run.completed/run.failed
    Sup->>ProjectDB: run terminal audit
    Sup-->>Main: AgentRunEvent callback
    Main->>Registry: append assistant/error; update session state
    Main-->>Preload: webContents.send(agentEvent)
    Preload-->>UI: validated subscription event
```

### 2.1 Renderer 到主进程

`StewardRuntimePanel.sendMessage()` 先把用户消息乐观追加到 React 本地 `entries`，再调用 `window.novaxDesktop.agent.start()`；开始成功后只保存 `runId`。事件订阅按 `sessionId` 过滤，`run.started`/`run.activity` 更新内存状态，终态事件追加助手或错误消息。[`src/renderer/src/features/agent/StewardRuntimePanel.tsx:61`](../../src/renderer/src/features/agent/StewardRuntimePanel.tsx) [`src/renderer/src/features/agent/StewardRuntimePanel.tsx:119`](../../src/renderer/src/features/agent/StewardRuntimePanel.tsx)

Preload 对请求和事件都用 Zod Schema（结构校验）验证；请求走 `ipcRenderer.invoke`，运行事件走 `ipcRenderer.on`。无流式文本进入 Renderer，因为 Worker Controller 明确丢弃 `text.delta`。[`src/preload/desktopApi.ts:492`](../../src/preload/desktopApi.ts) [`src/agent-worker/workerController.ts:88`](../../src/agent-worker/workerController.ts)

### 2.2 主进程启动与全局会话持久化

`registerDesktopIpc` 验证 `sessionId` 与 `projectId`，从 `ApplicationRegistryRepository` 读取最近会话和协作上下文，然后依次写入用户消息、将会话设为 `working`，最后调用 Supervisor。[`src/main/registerDesktopIpc.ts:42`](../../src/main/registerDesktopIpc.ts)

该顺序不是一个事务。`appendMessage()` 自身只保证“消息插入 + session.updated_at”原子；`setSessionState()` 是另一条独立 UPDATE。[`src/domain/application/applicationRegistryRepository.ts:258`](../../src/domain/application/applicationRegistryRepository.ts)

全局数据库在 `app.getPath("userData")/application.db`；项目数据库在工作区 `.novax/workspace.db`。[`src/main/index.ts:49`](../../src/main/index.ts) [`src/domain/workspace/workspaceRepository.ts:15`](../../src/domain/workspace/workspaceRepository.ts)

### 2.3 Supervisor、租约与 Worker

Supervisor 在内存 `#runs` 中拥有活跃运行，读取 Provider Profile（模型配置），取得 Workspace Session（工作区会话）的 runtime lease（运行租约），解析授权 scope（范围），先在项目数据库写 `agent_runs` 审计，再 `fork()` Worker。Worker 只在 `spawn` 后收到包含明文 API Key（应用内进程 IPC）的 `run.start`；完成后 Worker 将该对象中的 `apiKey` 清空。[`src/main/agentProcessSupervisor.ts:143`](../../src/main/agentProcessSupervisor.ts) [`src/main/agentProcessSupervisor.ts:163`](../../src/main/agentProcessSupervisor.ts) [`src/agent-worker/index.ts:68`](../../src/agent-worker/index.ts)

租约只通过计数阻止工作区在运行期间关闭/回溯；它不是数据库连接隔离或快照。工具调用仍读取调用时的当前数据库状态。[`src/main/workspaceIpc.ts:254`](../../src/main/workspaceIpc.ts)

### 2.4 Worker 到 Provider

Worker 启动时验证 Prompt Registry（提示词注册表），为每个 run 创建 AbortController，构造基础工具和 Writer/Checker（写手/检查器）专用工具，然后进入 `runStewardRuntime()`。[`src/agent-worker/index.ts:16`](../../src/agent-worker/index.ts) [`src/agent-worker/workerController.ts:38`](../../src/agent-worker/workerController.ts)

Steward Runtime 先通过 Audit Bridge（审计桥）要求主进程落 `invocation.started`，再创建强制执行计划/工具顺序/最终结构化提交的状态机，最后调用 Adapter（适配器）。最终结果必须恰好有一次有效 `submit_steward_result`，否则运行失败。[`src/agent-worker/stewardRuntime.ts:45`](../../src/agent-worker/stewardRuntime.ts) [`src/agent-worker/stewardRuntime.ts:70`](../../src/agent-worker/stewardRuntime.ts)

`NovaxPiRuntimeAdapter` 使用 `@earendil-works/pi-agent-core` 的 `Agent`，工具串行执行；每次 Provider 请求前执行上下文 admission（准入）和输出预算计算，并通过 OpenAI-compatible（兼容 OpenAI 协议）Provider 的 `streamSimple()` 调用真实网络服务。[`src/agent-worker/pi/NovaxPiRuntimeAdapter.ts:98`](../../src/agent-worker/pi/NovaxPiRuntimeAdapter.ts) [`src/agent-worker/pi/NovaxPiRuntimeAdapter.ts:131`](../../src/agent-worker/pi/NovaxPiRuntimeAdapter.ts) [`src/agent-worker/pi/NovaxPiRuntimeAdapter.ts:303`](../../src/agent-worker/pi/NovaxPiRuntimeAdapter.ts)

### 2.5 工具、SQLite 与文件

Pi 工具的 `execute()` 不直接操作项目。`AgentWorkerToolBridge` 生成 UUID 请求，通过 Node process IPC 发给 Supervisor，并在 Worker 内维持 pending map、20 秒默认超时和取消监听。[`src/agent-worker/tools/agentWorkerToolBridge.ts:28`](../../src/agent-worker/tools/agentWorkerToolBridge.ts)

Supervisor 二次验证 envelope、工具名、参数和 runId；为每次调用写审计 started/terminal，并施加主进程 15 秒超时。真实执行委派给 `WorkspaceAgentToolGateway`。[`src/main/agentProcessSupervisor.ts:283`](../../src/main/agentProcessSupervisor.ts) [`src/main/agentProcessSupervisor.ts:357`](../../src/main/agentProcessSupervisor.ts)

网关的读取能力分为：

- `retrieve_graph_evidence`：由 `ContextPacketService` 从项目数据库读取稳定文档和权威断言。
- 项目文件工具：由 `ProjectFileService` 在项目根目录内 list/stat/glob/search/read。
- task notes（任务笔记）：由 `AgentTaskNoteRepository` 持久化到项目数据库。
- `propose_change_set`：校验审计工具身份，建立候选 Change Set。

写入通过 `WorkspaceSession.#serializeWrites()` 排队，避免同一 Workspace Session 内并发 Change Set 写入；读取不进队列。[`src/main/workspaceAgentToolGateway.ts:20`](../../src/main/workspaceAgentToolGateway.ts) [`src/main/workspaceIpc.ts:443`](../../src/main/workspaceIpc.ts)

Change Set 的“候选记录”和“正式提交”是两个事务。正式提交在 `BEGIN IMMEDIATE` 内创建 Checkpoint、应用数据库项目和记录输出；真实文件由 `WorkspaceChangeSetApplier` 暂存/回滚，数据库 COMMIT 后才 finalize 文件变更，随后 projection（投影）在事务外运行。[`src/domain/changeSet/changeSetService.ts:443`](../../src/domain/changeSet/changeSetService.ts) [`src/domain/changeSet/changeSetService.ts:582`](../../src/domain/changeSet/changeSetService.ts)

### 2.6 终态回 UI

Worker 将结构化 StewardOutput（大管家输出）投影成公共 message/artifacts，过滤本地路径、内部 ID、raw JSON（原始 JSON）等泄露，再发送 `run.completed`；异常映射为 `run.failed`。[`src/agent-worker/workerController.ts:106`](../../src/agent-worker/workerController.ts) [`src/agent-worker/workerController.ts:193`](../../src/agent-worker/workerController.ts)

Supervisor 在项目数据库写 run terminal，释放租约并 kill Worker；主进程回调再把助手/错误消息和会话状态写入全局数据库，最后向原始 `webContents` 推送事件。[`src/main/agentProcessSupervisor.ts:297`](../../src/main/agentProcessSupervisor.ts) [`src/main/registerDesktopIpc.ts:53`](../../src/main/registerDesktopIpc.ts)

## 3. 状态归属

| 状态 | 权威拥有者 | 持久性 | 恢复能力 |
|---|---|---|---|
| Composer draft、feed、activeRunId、activity | Renderer React state | 无 | 重载后从消息表恢复 feed；运行状态不能恢复 |
| 项目、会话、消息、共享记忆、handoff、session state | `application.db` | 有 | 可查询；与项目 DB 无统一恢复 |
| 活跃 run、pending tools、计时器、AbortController、lease count | Main/Worker 内存 | 无 | 进程退出即丢失 |
| Prompt/Profile 身份、run/invocation/tool audit | `.novax/workspace.db` | 有 | 可查未终态审计，但启动时未见自动 reconciliation（对账） |
| 世界、OC、故事、文档、断言、Change Set、Checkpoint | `.novax/workspace.db` | 有 | Checkpoint/分支机制恢复项目状态 |
| 原始项目文件及快照 | 工作区磁盘与 `.novax/file-snapshots` | 有 | 由 ProjectFileVersionService/Change Set 回滚；不属于单一 SQLite 事务 |
| Provider 会话上下文 | Pi Agent/Provider 请求内存 | 无 | 依赖 application.db 最近消息、协作上下文、项目检索重建 |
| API Key | Main Provider store -> Worker command/profile | 运行期内存 | Worker finally 清空对象字段；进程转储风险仍存在 |

## 4. 事务边界

1. `application.db.appendMessage()`：单条消息与 session `updated_at` 原子。
2. `application.db.setSessionState()`：独立 UPDATE，不与消息或 Agent 启动原子。
3. `AgentAuditRepository`：多数 audit 操作独立写入；部分 terminalization 使用本地事务。
4. `ChangeSetService.propose()`：候选 Change Set 独立事务；Free（自由）模式可能在该事务完成后立即进入另一个正式提交事务。
5. `ChangeSetService.#commitPrepared()`：项目数据库提交是核心事务；文件 finalize 和 projection 位于 COMMIT 之后。
6. Worker/Provider 网络请求：不参与任何数据库事务。
7. 主进程 terminal event：项目审计终态先写，随后 application.db 助手消息与 session state 分开写。

不存在覆盖 `application.db + workspace.db + filesystem + Provider` 的原子边界，也不存在统一 outbox（发件箱）或可重放 event log（事件日志）。

## 5. 隐含耦合

- **工具集合与状态机硬耦合**：协议 enum、TypeBox 参数、Worker Bridge、Supervisor switch、Gateway、activity label、artifact label、runtime profile 和状态机工具顺序必须同步修改。
- **审计身份与字符串约定耦合**：Steward invocation id 固定为 `${runId}:steward`；specialist parent id、Prompt Manifest、Profile hash 必须完全一致。
- **运行终态与 UI 会话状态耦合**：`run.completed.outcome` 被映射为 `idle/review/blocked`，映射逻辑位于 `registerDesktopIpc`，不是领域状态机。
- **当前工作区单例耦合**：Runtime lease 来自当前 `WorkspaceSession`，请求携带 `projectId`，但工具真正作用于当前打开的 workspace；两者依赖上层 UI 保持一致。
- **公共显示与内部输出耦合**：Worker Controller 同时负责内部输出投影、敏感字段过滤、artifact 构造和工具中文标签。
- **上下文预算与 Pi Context 结构耦合**：admission policy 依赖 Pi 消息、工具协议和模型 metadata 的具体形态。
- **文件提交与 DB 提交耦合**：WorkspaceChangeSetApplier 必须遵守 prepare/rollback/finalize 生命周期，ChangeSetService 通过 `instanceof` 识别其额外职责。

## 6. 不可恢复点与失败窗口

按风险排序：

1. **项目已变更、对话未记载**：workspace.db Change Set 已提交后，`applicationRegistry.appendMessage(assistant)` 失败，项目事实存在但会话没有助手终态。
2. **用户消息已记载、run 未建立**：主进程先写 user message 和 `working`，随后 Supervisor audit beginRun、fork 或 send 失败；虽通常会发 failed event，但应用在中间崩溃会留下 working。
3. **COMMIT 后文件 finalize/projection 失败**：数据库已提交，文件 finalize 和 projection 在事务外；当前 catch 不能回滚已 COMMIT 的数据库。
4. **Worker/Main 崩溃后的开放审计**：正常 supervisor interrupt 会 terminalize；整个应用被强制终止时没有机会执行。未发现启动时扫描并关闭 stale run 的恢复器。
5. **事件只发给启动请求的 webContents**：窗口销毁后终态仍可落库，但新窗口无法订阅既有 run；Renderer 也没有 run reattach（重新附着）协议。
6. **取消是先对外终态、后 Worker 停止**：Supervisor 先写 cancelled、emit failed、释放 lease，再发送 cancel 并等待 kill；若 Worker/Provider 或工具忽略取消，短暂存在“已取消但旧进程仍执行”的窗口。工具 AbortController 降低风险，但不能证明外部 Provider 已停止计费。
7. **双超时来源**：Worker Bridge 默认 20 秒、Supervisor 默认 15 秒；当前主进程通常先返回超时，但两层定时器会形成不同错误时序。
8. **乐观 UI 消息重复风险**：Renderer 先本地 append 用户消息，主进程也落库；重载/refresh 依赖重新拉取消息去重，当前 feed entry 没有 client id/idempotency key（幂等键）。

## 7. 协议风险

- Electron IPC、Node process IPC 和 Provider tool schema 是三层不同协议，虽均有 Schema 验证，但没有统一协议版本协商。
- `agentRunStartResponse` 只返回 `runId`；没有 run snapshot、last sequence、resume token 或 event sequence。
- `AgentRunEvent` 是瞬时事件，不带单调 sequence，无法检测丢包、重复或乱序。
- 工具请求用 UUID 关联，但 audit、tool response 和 activity 是不同消息，UI 无法可靠组成一次完整工具生命周期。
- 工具错误经过 public mapping；安全性合理，但诊断信息与可恢复建议不属于结构化协议。
- Provider Profile（含 API Key）整体通过 process IPC；Worker 隔离降低 Renderer 暴露，但不是 secret handle（密钥句柄）模型。
- 会话历史只取最近 16 条/24 KB 默认预算，遗漏只以 completeness 元数据传入；恢复长期任务依赖模型主动检索和 task notes，没有系统级确定性 continuation（续作）检查点。
- Worker 代码同时承载 Steward、Player、Decomposer 三类命令，入口用 Schema 依次尝试解析；协议扩张会增加歧义和启动耦合。

## 8. Runtime V2 迁移接缝

以下接缝可在不改变产品语义的前提下逐步替换：

1. **Renderer 接缝**：保持 `novaxDesktop.agent.start/cancel/subscribe` 外观，内部升级为带 sequence 的 `RunSnapshot + RunEvent`。
2. **Main 编排接缝**：以 `AgentProcessSupervisor` 为 facade（门面），将内存 `#runs` 抽成可持久化 Run Coordinator（运行协调器）。
3. **Worker 接缝**：保留 `RuntimeAdapter.run()`，Pi Agent 继续作为 Provider/工具循环实现；V2 不应直接重写 Pi。
4. **工具接缝**：保留 `AgentToolGateway` 的主进程能力边界，将 switch 分发改为注册表并为工具声明权限、读写性质、事务策略和恢复语义。
5. **审计接缝**：`AgentAuditStore` 已是接口，可演进为 append-only run journal（仅追加运行日志），再投影到现有 audit tables。
6. **写入接缝**：`ChangeSetService` 继续作为唯一项目正式写入口；增加 durable intent/outbox（持久意图/发件箱）协调 DB、文件 finalize、projection。
7. **会话接缝**：Application Registry 增加 `runId`、message idempotency key 和 terminal reconciliation；不必先合并两个 SQLite 文件。
8. **恢复接缝**：启动时扫描 `working` session 与无终态 run，依据 workspace audit journal 生成确定性 recovered/failed terminal，而不是让 UI 猜。
9. **Secret 接缝**：Provider 配置改传短生命周期 credential handle，由 Worker 请求主进程受控代理或一次性 token；API Key 不再进入通用 run command。
10. **可观测接缝**：统一 run/tool/invocation sequence，UI 的“已处理”直接消费结构化事件，不再从终态 artifacts 反推过程。

## 9. 建议的 V2 不变量

- 每个已接收用户消息必须关联唯一 `runId`，重复 start 不得创建第二个 run。
- 每个 run 必须最终拥有且仅拥有一个 terminal event；应用重启后仍能补齐。
- 项目变更提交前必须存在 durable run/tool identity；提交后必须存在可重放的对话终态意图。
- UI 可通过 `getRunSnapshot(runId, afterSequence)` 恢复全部可见状态，不依赖旧窗口存活。
- 所有工具由注册表声明 schema、权限、timeout、audit projector 和 result projector；新增工具不得修改多个散落 enum/switch 才能运行。
- Provider 响应、工具结果和最终输出仍必须经过现有 fail-closed（失败关闭）Schema 和职责边界，不以“可恢复”为由放松验证。

## 10. 证据限制

- 本文是源码静态审计，不证明 Provider 网络、Electron 打包版或崩溃恢复的实际表现。
- 工作树在审计期间包含并行开发中的基础文件工具/task notes 改动；本文描述的是读取时的当前代码，而非已发布 `v0.2.5` 的严格标签快照。
- 未完整审计 Player/GM、Decomposer、自动更新和 Provider 凭据存储实现；不得将本文结论外推为这些链路已满足同样边界。
