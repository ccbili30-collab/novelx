# Runtime V2 Startup Recovery（启动恢复）状态机

## 1. 文档目的

本文定义 NovelX Runtime V2 在进程启动后如何恢复未终止的 `Run（运行）`、`AgentLoop（Agent 循环）`、`ProviderAttempt（模型调用尝试）` 和 `ToolCoordination（工具协调）`。

目标不是“尽可能继续”，而是在不重复模型请求、不重复外部副作用、不丢失已持久化结果的前提下继续。无法证明结果的操作必须进入 `Outcome Unknown（结果未知）` 或等待 Host（宿主）处理，禁止猜测成功、猜测失败或直接重发。

本文依据以下当前实现：

- `runtime/crates/novelx-runtime/src/recovery.rs`
- `runtime/crates/novelx-runtime/src/agent_loop_service.rs`
- `runtime/crates/novelx-runtime/src/agent_loop_journal.rs`
- `runtime/crates/novelx-runtime/src/live_agent_loop_runner.rs`
- `runtime/crates/novelx-runtime/src/provider_attempt.rs`
- `runtime/crates/novelx-runtime/src/tool_coordination_service.rs`
- `runtime/crates/novelx-runtime/src/project_tool_execution_service.rs`
- `runtime/crates/novelx-runtime/src/main.rs`

## 2. 当前事实与缺口

### Assist continuation proposal/ack（协助续跑提议/确认）

Assist 工具决定全部持久化后，Runtime 不再与 Operational Recovery（运行恢复）并发启动续跑。顺序固定为：授权决定落盘且 AgentLoop 仍为 `AwaitingApproval` → 完成 recovery barrier → 持久化 ToolResult、续接 Context 和 `inference-started` → 发布 `provider.inference.continuation.proposed` → Host 校验并先登记 continuation identity → Host 发送 `provider.inference.continuation.acknowledge` → Runtime 精确核对 identity hash、父推理身份和授权证据 → 写出 `provider.inference.continuation.accepted` → 才允许 Provider 请求。

`continuationId` 等于已持久化的 continuation `inferenceId`。终态事件以该 ID 作为 `correlationId`，Host 继续执行完整 inference identity 校验。Approve 和 Deny 都进入第二轮；Deny 以严格配对的 `TOOL_DENIED` ToolResult 继续，不能直接结束并破坏工具协议。

当前 acknowledgement 幂等状态只保存在进程内。程序重启后尚不能从 Journal 重建未确认 proposal，也不会自动重新发布 proposal；因此这只是 live Assist 双向握手闭环，不是 durable continuation recovery（持久续跑恢复）闭环。

启动入口先取得工作区独占锁，运行 `RecoveryCoordinator`、Assignment structural recovery、local-only Operational Recovery Supervisor，并在 `runtime.ready` 前记录完整扫描结果。没有 Provider 绑定时不会调用模型。Host 后续完成 `provider.bind` 后，Runtime 依次运行 local projection Supervisor、Provider Dispatch Supervisor、再次运行 local projection Supervisor，再发布刷新后的恢复状态。

当前启动链已经能处理一个已持久化并已启动的 `ProviderDispatch`：新 Runtime 通过专用 ResumeAuthorization 续接 `Requested`，或零网络收口 `Sent/OutcomeUnknown/Responded/Failed`。它仍没有统一驱动全部 active AgentLoop phase，也没有 Tool Dispatch Supervisor，因此这里只是 Provider 子链闭环，不是完整启动恢复闭环。

`AgentLoopJournalRepository::find_active_for_run` 已能找出一个 Run 的唯一 active loop，并拒绝多个 active loop；但 `LiveAgentLoopRunner` 的常规入口只接受 `AwaitingProvider`，`resume_after_assist` 只接受 `AwaitingApproval`。因此 Journal 可恢复不等于启动后能继续执行。

2026-07-12 本批已经关闭此前最危险的身份窗口。旧实现曾按以下顺序运行：

1. 先把 AgentLoop 从 `AwaitingInferenceStart` 持久化为 `AwaitingProvider`；
2. 再随机生成新的 `attempt_id` 和 `inference_id`；
3. 随后才进入 ProviderInferenceService 并持久化 Provider Attempt。

当前 `InferenceDispatchIdentity（推理派发身份）` 会在进入 `AwaitingProvider` 前与 AgentLoop checkpoint 一起持久化，包含 `inference_id`、`attempt_id`、request/context identity、attempt number 和业务幂等键。`resume_awaiting_provider` 只能使用完全相同的身份恢复；Provider completion 也必须逐字段匹配该身份。

服务级测试与真实 Runtime 子进程测试都已覆盖“身份、phase、Requested Attempt 和 Started Recovery Execution 已持久化，但网络尚未派发”的恢复。新 Runtime 初始化后等待 `provider.bind`，随后只发送一次，持久化响应并完成本地 AgentLoop 投影；同进程再次绑定和完整重启后再次绑定均不会重复请求。尚缺强杀点矩阵以及其余 phase 的统一恢复。

## 3. 恢复判定优先级

每个非终态 Run 必须按以下顺序恢复，不能只看 RunState 决定是否重启：

1. 恢复 Run Aggregate，并检查是否终态或 `Committing（提交中）`。
2. 恢复该 Run 唯一 active AgentLoop；零个或多个都必须产生明确诊断。
3. 恢复 AgentLoop 当前 phase 对应的持久 intent。
4. 枚举并关联 Provider Attempt 或 Tool Coordination。
5. 先消费已经持久化的终态结果，再判断是否可以派发新工作。
6. 任何已跨越外部副作用边界、但没有终态证据的工作进入 Outcome Unknown，禁止自动重派。

`Created / Preparing / Running / Retrying` 只能说明 Run 尚未终止，不能单独证明“可自动继续”。`WaitingForApproval` 与 `WaitingForReconciliation` 必须等待 Host。`Committing` 必须依据提交 manifest/checkpoint 对账，不能直接重复提交。

## 4. AgentLoop phase 恢复矩阵

| AgentLoop phase | 必须恢复的数据 | 自动继续条件 | 等待 Host / Outcome Unknown | 当前实现结论 |
| --- | --- | --- | --- | --- |
| `AwaitingProvider` | request number、context compilation、inference identity、关联 attempt identity | Attempt=`Requested` 在精确 Provider 绑定和专用恢复授权后只发送一次；Attempt=`Responded` 消费持久响应并本地投影 | Attempt=`Sent/OutcomeUnknown` 零网络收口为未知；retryable Failed 尚待持久重试策略 | Provider Dispatch Supervisor 已接 `provider.bind`，跨进程授权和正式子进程测试已通过；无 Attempt 创建与强杀矩阵仍未完成 |
| `AwaitingApproval` | pending tool requests、每项 Tool Coordination、已持久化审批决定 | 不自动批准；所有请求已有终态决定与工具终态结果后，可继续汇总 | 未决审批等待 Host；Running tool 无终态 manifest 为 Outcome Unknown | Host 命令可调用 `resume_after_assist`；不是启动自动恢复 |
| `AwaitingToolResults` | pending requests、Provider call ID、Tool Coordination、lease、completion/failure manifest | Authorized 且未开始可安全启动；Completed/Failed/Denied 收集持久结果；全部终态后进入 Context Compilation | Requested+Assist 等待 Host；Running 无终态 manifest 为 Outcome Unknown，禁止重派 | Tool orphan 可局部校准，但没有启动级 loop 驱动器 |
| `AwaitingContextCompilation` | 完整 ContextCompileIntent、base compilation identity、intent hash、目标 request number | 相同 intent 的编译已完成则复用 receipt；未完成则用稳定 idempotency key 重新调用编译 | intent/来源编译记录缺失或 hash 冲突时阻塞 | intent 存在于 checkpoint；ContinuationContextService 已以 base id + intent hash 生成幂等键，但启动不调用 |
| `AwaitingInferenceStart` | NextInferenceIntent、稳定 inference identity、首个 attempt identity 或确定性创建规则 | 已有 matching Attempt 时按 Attempt 状态处理；没有 Attempt 且持久 intent 明确标记未派发时，创建并持久化 Requested 后发送 | 发现多个 matching Attempt、身份冲突或发送边界不明时阻塞/对账 | 正常 Runner 路径已在 phase 转换时持久派发身份；尚无启动级 phase 驱动器 |
| `Completed/Cancelled/Failed` | 终态 checkpoint | 不恢复执行，只重建投影 | 终态与未知 Provider/Tool 外部结果并存属于一致性错误，需人工审计 | 已是终态 |

## 5. Provider Attempt 恢复矩阵

当前 `provider_attempt.rs:167-178` 的分类原则应保留：

| Provider state | 恢复分类 | 正确动作 |
| --- | --- | --- |
| `Requested` | `SafeToSend` | 只有当前 owner 或持有最新专用 ResumeAuthorization 的新 Runtime 可以发送同一 attempt；不得生成新 attempt identity |
| `Sent` | `OutcomeUnknown` | 禁止自动重发；恢复 Execution 只做零网络未知收口，Run 保持/进入 `WaitingForReconciliation` |
| `OutcomeUnknown` | `OutcomeUnknown` | 等待 Host 选择接受已验证响应、取消或进入受控重试 |
| `Responded` | `Completed` | 使用持久 response receipt/body 继续 AgentLoop，不再调用 Provider |
| `Failed(retryable=true)` | `RetryEligible` | 由持久重试策略决定新 attempt number、退避和 deadline；不是立即无条件重发 |
| `Failed(retryable=false)` | `TerminalFailure` | 终止或阻塞本次 Run，保留失败证据 |

Provider Attempt 与 AgentLoop 的关联不得依靠“取最新一条”。必须至少匹配：

- `run_id`
- `invocation_id`
- `request_number`
- `context_compilation_id`
- `inference_id`
- `attempt_id / attempt_number`
- `canonical_context_sha256`
- `transport_payload_sha256`

## 6. Tool Coordination 恢复矩阵

`tool_coordination_service.rs:347-430` 已能依据 lease 和 terminal manifest 校准部分孤儿状态；`project_tool_execution_service.rs:235-244` 已明确拒绝重新派发 Running 工具。启动恢复应复用该原则：

| Tool state / evidence | 正确动作 |
| --- | --- |
| Requested，无 lease | Free 模式可重新执行授权步骤；Assist 模式等待 Host |
| Requested，有持久 lease | 幂等校准为 Authorized |
| Authorized，有有效 lease，未进入 Running | 可以自动开始同一 tool call |
| Running，有 completion manifest | 校准为 Completed，复用持久 Artifact |
| Running，有 failure manifest | 校准为 Failed，复用持久失败 |
| Running，无 terminal manifest | `PROJECT_TOOL_OUTCOME_UNKNOWN`；禁止重新派发 |
| Completed，缺 completion manifest | 一致性错误，阻塞恢复 |
| Failed，缺 failure manifest | 一致性错误，阻塞恢复 |
| completion 与 failure 同时存在 | manifest 冲突，阻塞恢复 |
| Authorized/Running/Completed/Failed 缺 lease | 权限证据缺失，阻塞恢复 |

即使当前五个工具是只读项目工具，也不能把 Running unknown 自动当成失败再执行。该规则必须覆盖未来写文件、移动、删除、生成图像和外部服务调用。

## 7. 必须新增或强化的持久字段

### 7.1 AgentLoop inference intent

当前已在 `AwaitingInferenceStart -> AwaitingProvider` 转换中持久化 `InferenceDispatchIdentity`。完整启动恢复仍建议把它扩展为不可变 `InferenceDispatchIntent（推理派发意图）`：

```text
run_id
invocation_id
round
request_number
context_compilation_id
inference_id
inference_idempotency_key
first_attempt_id
next_attempt_number
provider_identity_sha256
canonical_context_sha256
transport_payload_sha256
dispatch_state = prepared | attempt_requested | sent | terminal
```

`inference_id` 和首个 `attempt_id` 必须在 intent 写入前生成并持久化，或由持久字段通过稳定算法确定性生成。不能在恢复执行器的内存中临时随机生成。

### 7.2 AgentLoop current provider identity

`AwaitingProvider` checkpoint 至少需要保存或可严格关联：

- 当前 `inference_id`
- 当前 `attempt_id`
- 当前 `request_number`
- 当前 `context_compilation_id`
- 当前 Provider Attempt aggregate address

完成响应消费后再清除这些字段。没有这些字段时，启动恢复只能扫描猜测关联关系，无法证明唯一性。

### 7.3 Context compilation identity

`ContextCompileIntent` 已包含足够内容生成稳定 intent hash。仍应在 checkpoint 或单独 aggregate 中保存：

- `base_compilation_id`
- `intent_sha256`
- `compile_idempotency_key`
- 预期 `request_number`
- 已完成时的 `result_compilation_id`

随机 `command_message_id` 只能作为传输消息身份，不能成为业务幂等身份。

### 7.4 Tool dispatch evidence

现有 tool call ID、Provider call ID、lease、completion/failure manifest 是正确基础。未来写工具还需要：

- side-effect class（副作用类别）
- dispatch nonce（派发随机标识）
- precondition/source version（执行前版本）
- write/change-set identity（写入或变更集标识）
- external idempotency key（外部系统支持时）

这些字段用于证明能否自动重试，而不是为了 UI 展示。

## 8. 最小正确启动恢复器

```text
Runtime start
  -> recover Run aggregates
  -> reconcile Provider OutcomeUnknown into WaitingForReconciliation
  -> local-only Operational Recovery barrier
  -> publish runtime.ready without Provider access
  -> after exact provider.bind:
       -> scan + record
       -> claim/start or authorize Provider Dispatch
       -> dispatch Requested once, or consume persisted terminal/unknown evidence
       -> run local persisted-result projection
  -> for remaining nonterminal Run phases:
       -> recover exactly one active AgentLoop
       -> dispatch by LoopPhase
       -> recover matching child aggregates
       -> consume durable terminal evidence first
       -> auto-continue only before an uncertain external-effect boundary
       -> otherwise persist waiting/recovery-required state
  -> publish recovery report and snapshots
  -> then accept new Host commands
```

恢复器本身必须有稳定 recovery operation ID，并保证重复启动不会追加不同语义的事件。启动期间新 Host 命令应等待 recovery barrier（恢复屏障）完成。

## 9. 必测矩阵

| ID | 崩溃点 / 初始状态 | 期望启动行为 | 禁止行为 |
| --- | --- | --- | --- |
| REC-LOOP-01 | AwaitingProvider + Requested Attempt | 发送原 Attempt，保持相同 identity | 创建新 Attempt |
| REC-LOOP-02 | AwaitingProvider + Sent Attempt | Run 进入 WaitingForReconciliation | 自动重发 |
| REC-LOOP-03 | AwaitingProvider + Responded Attempt | 消费持久响应并推进 loop | 再次请求 Provider |
| REC-LOOP-04 | AwaitingProvider，无 Attempt，但有未派发持久 intent | 创建该 intent 指定的首个 Attempt | 随机生成另一 inference identity |
| REC-LOOP-05 | AwaitingProvider，无 Attempt、无 intent | 阻塞并报告身份缺失 | 猜测为新请求 |
| REC-APP-01 | AwaitingApproval，存在未决请求 | 保持等待 Host | 自动批准或拒绝 |
| REC-APP-02 | AwaitingApproval，全部决策与结果已持久化 | 幂等汇总并推进 | 重复执行工具 |
| REC-TOOL-01 | AwaitingToolResults + Authorized | 启动原 tool call | 生成新 tool call ID |
| REC-TOOL-02 | AwaitingToolResults + Running + completion manifest | 校准 Completed 并推进 | 重派工具 |
| REC-TOOL-03 | AwaitingToolResults + Running，无 terminal manifest | 标记 Outcome Unknown / RecoveryRequired | 当作失败重试 |
| REC-TOOL-04 | Completed/Failed 缺对应 manifest | 阻塞并报告 journal/manifest 不一致 | 伪造结果 |
| REC-CTX-01 | AwaitingContextCompilation，编译未开始 | 用同一 intent/idempotency key 编译 | 改写 exchanges |
| REC-CTX-02 | 编译已经完成但 loop 未推进 | 复用原 receipt 并进入 AwaitingInferenceStart | 创建第二份 compilation |
| REC-INF-01 | AwaitingInferenceStart，持久 inference intent 存在 | 按 intent 创建/恢复 Attempt | 临时随机生成身份 |
| REC-INF-02 | phase 已转 AwaitingProvider，Attempt Requested 事件未写入 | 依据持久 intent 补写同一 Attempt | 生成不同 attempt identity |
| REC-RUN-01 | Run WaitingForApproval | 保持等待 Host | 自动继续 |
| REC-RUN-02 | Run WaitingForReconciliation | 保持等待 Host | 自动 retry |
| REC-RUN-03 | Run Committing，无明确 commit manifest | 标记 CommitUncertain | 重复提交 |
| REC-CONS-01 | 一个 Run 有多个 active AgentLoop | 初始化失败并给出一致性诊断 | 任取一个继续 |
| REC-CONS-02 | 终态 Run 仍有未对账 Provider/Tool unknown | 初始化失败或进入专用审计状态 | 隐藏未知结果 |
| REC-IDEM-01 | 连续启动恢复两次 | 第二次不产生重复业务事件或副作用 | 重复发送/执行/编译 |

测试至少分为三层：纯 aggregate 重放测试、服务级故障注入测试、真实子进程 kill/restart 黑盒测试。只有内存单元测试不能证明进程边界恢复。

## 10. 验收边界

完成以下条件前，不得宣称 Runtime V2 启动恢复闭环：

- 启动恢复覆盖全部五个 active AgentLoop phase。
- Provider Sent/OutcomeUnknown 和 Tool Running unknown 均有实际 kill/restart 证据，且没有重复派发。
- inference/attempt identity 在派发前持久化，并能跨进程唯一关联。
- Context Compilation 能以同一 intent 幂等恢复。
- Host 等待状态不会被自动批准、自动取消或自动 retry。
- 启动 recovery barrier 完成前不接受会改变同一 Run 的新命令。
- 恢复结果可通过 Run snapshot 和结构化错误审计，不依赖日志文本猜测。

当前实现额外完成了 Provider 派发身份预持久化、严格 completion identity 校验、结构恢复屏障、Provider 绑定后的 Operational Supervisor、跨进程专用授权、全 Provider 入口 single-flight，以及真实子进程初始化/绑定/重启黑盒测试。仍未覆盖全部 active phase、Tool Dispatch、Provider 强杀点矩阵和持久重试调度，因此仍不满足完整 Harness 启动恢复闭环。
