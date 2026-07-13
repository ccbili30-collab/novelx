# ADR-0016: Operational Recovery Cancellation and Host Control Plane（运行恢复取消与宿主控制面）

## Status

Accepted — 2026-07-13

## Context

Provider bind（模型绑定）当前同步等待整个 Operational Recovery Barrier（运行恢复屏障）。等待期间主循环不再读取 stdin，所以 `runtime.shutdown`、Host EOF（宿主输入关闭）和 `run.cancel` 都无法到达恢复任务。恢复 Service（服务）内部创建的 `watch::channel(false)` 永远不会触发，不是真实取消能力。

这会产生三个不可接受的结果：

- shutdown 只能等待 Provider 超时，或由 Host 强杀进程；
- Sent（已发送）之后强杀可能来不及持久化 Attempt 终态；
- `run.cancel` 看不到不在 RuntimeActor（运行时执行器）任务表中的恢复派发，可能在外部副作用仍运行时错误取消业务 Run（任务）。

约束：

- Structural Recovery Barrier（结构恢复屏障）仍必须在 `runtime.ready` 前同步完成，并且永久零 Provider / Tool（模型 / 工具）副作用。
- Provider 绑定后的 Operational Recovery Barrier 结束前，普通业务命令不得执行。
- 取消先于 Sent 时必须证明 0 Sent、0 HTTP；Sent 先于取消时不得伪装成安全取消。
- shutdown / EOF 是 Runtime 生命周期事件，不得修改小说创作业务 Run 状态。
- user `run.cancel` 是业务意图，必须使用独立、可审计的安全取消状态。
- Workspace Lease（工作区租约）必须保留至 Attempt 终态和 Recovery outcome（恢复结果）全部持久化。

## Decision

### 1. 分离宿主控制面与顺序业务调度

主进程引入 HostCommandPump（宿主命令泵）和 OrderedDispatcher（顺序调度器）：

- Pump 持续读取、解析并验证 Host sequence（宿主序列）。
- Operational Recovery Barrier 运行期间只允许控制面处理：`runtime.shutdown`、stdin EOF / Host disconnect（宿主断连）和目标 `run.cancel`。
- 其他已验证命令按原序排队；屏障完成后再执行。
- `provider.bound` 只有在屏障完成或形成类型化中断结果后才返回，不能提前把普通命令放进未恢复的工作区。

### 2. 使用 RuntimeCancellationHub（运行时取消中心）

Hub 以以下精确身份注册恢复派发：

```text
workspaceId + runId + operationId + executionId + attemptId
```

Hub 支持：

- shutdown / EOF：广播 Runtime 生命周期中断；
- `run.cancel`：只命中指定 Run；
- 新注册任务继承已经发生的全局 shutdown / disconnect；
- 每个派发有独立 pre-send gate（发送前闸门）和 HTTP cancellation receiver（网络取消接收器）。

### 3. 取消与 Sent 共用线性化闸门

闸门状态：

```text
Open
  -> CancelledBeforeSent   // cancellation wins
  -> SentReserved         // dispatch wins
       -> SentCommitted
```

- 取消与 Sent reservation 必须通过同一原子 CAS 或互斥临界区竞争。
- `CancelledBeforeSent` 后 capability（副作用能力）不能 consume（消费），Attempt 保持 Requested，HTTP 次数为 0。
- `SentReserved` 必须在同一临界区完成 capability consume + `provider.sent v2` CAS append；成功后进入 `SentCommitted`。
- 取消若输掉竞态，仍向 HTTP receiver 发信号，但语义已经是 post-Sent；最终只能 Responded、Failed 或 OutcomeUnknown。
- Sent append 失败且 Attempt 仍 Requested 时可以释放 reservation；不得把失败 reservation 当作已发送。

### 4. 区分 Runtime 中断与业务取消

shutdown / EOF 的 pre-Sent 结果为：

```text
InterruptedBeforeSent {
  cause,
  operationId,
  executionId,
  attemptId,
  transportBoundaryCrossed: false,
  resumable: true
}
```

它不是 `OperationalRecoveryOutcome`，也不是 Run Cancelled。聚合追加 `operational_recovery.execution_interrupted` 审计事件，但保留 Operation 可恢复；新进程仍须取得 ResumeAuthorized（恢复授权）。

`run.cancel` 必须先持久化用户取消意图：

- pre-Sent 获胜且证明无外部副作用后，才能写一等 `CancelledSafe`（安全取消）或等价 abandoned-safe（安全放弃）恢复结果并取消业务 Run；
- post-Sent 时只能写 cancellation requested（请求取消），随后持久化真实终态或 OutcomeUnknown；Run 进入 reconciliation（对账），不能直接标成 Cancelled。

禁止用 `FailedSafe` 冒充用户取消。

### 5. shutdown 必须 drain 后 stopped

顺序固定为：

```text
signal cancellation
-> drain Provider Attempt terminal
-> persist Operational Recovery interruption/outcome
-> release task Arc lease
-> emit runtime.stopped
-> release root Arc lease
```

`runtime.stopped` 之后不得再 `abort_all` 丢弃未持久化副作用。无法 drain 的硬杀场景不发送 stopped；重启依赖 Sent 证据零网络收口 OutcomeUnknown。

### 6. 结构化结果与可观察性

内部结构至少包括：

- `RecoveryTaskIdentity`（恢复任务身份）
- `CancellationCause`（取消原因）：RuntimeShutdown、HostDisconnected、RunCancel
- `ProviderDispatchRecoveryResult`（模型派发恢复结果）：Completed、InterruptedBeforeSent、AwaitingAttemptOwner

Host lifecycle v2（宿主生命周期第二版）输出 drained count（已排空数量）、outcome-unknown count（结果未知数量）和中断原因；详细错误与状态必须来自持久化证据，不能用笼统“规划失败”。

## Non-Functional Requirements（非功能要求）

- **Safety（安全）**：任一 Attempt 身份最多一次 HTTP；取消竞态不得形成 Requested + 已发 HTTP 的无证据状态。
- **Durability（持久性）**：Sent 后的 shutdown 必须先持久化终态或 OutcomeUnknown。
- **Responsiveness（响应性）**：控制面在恢复屏障期间仍可接收 shutdown / EOF / 目标 Run cancel；普通命令不得穿透。
- **Auditability（可审计性）**：中断原因、线性化胜负、transport boundary（传输边界）、lease epoch（租约纪元）和恢复身份可查询。
- **Windows hygiene（Windows 清理）**：所有测试子进程有硬超时、kill + wait 和隐藏窗口策略。
- **Compatibility（兼容）**：历史 Sent v1 继续只做零网络 OutcomeUnknown 投影。

## Consequences

### Positive

- shutdown、断连和 Run cancel 不再依赖强杀或 Provider 超时。
- pre-Sent 与 post-Sent 取消语义可被严格证明。
- Provider bind 仍保持恢复屏障，不会让普通命令看到半恢复状态。
- Runtime 生命周期与小说业务取消不再混为一谈。

### Negative

- stdin 读取、命令调度和恢复执行从单循环变为显式状态机。
- 需要新增 Hub、闸门、聚合事件、协议 DTO 和迁移测试。
- RuntimeActor 现有“先 stopped 再 abort”行为必须重构。

### Neutral

- 强杀仍可能发生，但必须依靠已完成的 Sent/Responded 故障窗口恢复，而不是假设优雅退出永远成功。

## Alternatives Considered

### 只把 watch receiver 传给 Service

拒绝。命令循环被同步屏障堵住，取消信号仍无法产生；并且 `borrow()` 与 Sent append 之间存在竞态。

### provider.bound 立即返回，恢复放后台

拒绝。普通命令可能穿透 Operational Recovery Barrier，看到或修改未完成恢复的状态。

### shutdown 直接 abort 所有任务

拒绝。Sent 后会丢失 Attempt terminal / Recovery outcome 持久化窗口。

### 所有取消都写 FailedSafe

拒绝。Runtime 生命周期中断、用户取消和真实安全失败语义不同，混用会污染正史与审计。

## Migration Plan

1. 实现并测试 pre-send gate 与 RuntimeCancellationHub，不接 Host。
2. 将 Recovery Service / Supervisor 接入 Hub，完成 pre/post-Sent 单元与集成测试。
3. 拆分 HostCommandPump / OrderedDispatcher，使 shutdown / EOF 在 Provider bind 屏障期间可达。
4. 新增 `execution_interrupted`，实现 shutdown / EOF signal -> drain -> stopped。
5. 新增业务 `CancelledSafe` 语义并接入 `run.cancel`。
6. 完成并发 Run、租约顺序、断连和历史 Sent v1 全矩阵验收。

## Required Tests（必需测试）

- 初始已取消：Requested、0 Sent、0 HTTP。
- cancel-vs-Sent 两种可控胜负。
- held HTTP 时 shutdown：恰好 1 Sent、至多 1 HTTP、终态/OutcomeUnknown 先于 stopped。
- stdin EOF 的 pre-Sent / post-Sent 窗口。
- 现有三个硬杀 failpoint 重启零重发。
- `run.cancel` 的 pre-Sent safe cancel 与 post-Sent reconciliation。
- 单 Run cancel 不影响其他 Run。
- Attempt terminal 与 Recovery outcome 前第二实例不能取得 Workspace Lease；stopped 后可以。
- 屏障期间普通命令排队，shutdown / EOF 可达。
- 历史 Sent v1 零网络兼容。

## References

- ADR-0012: Fenced Operational Recovery Claim（带栅栏的运行恢复认领）
- ADR-0013: Provider Dispatch Resume and Single Flight（模型派发恢复与单航班）
- ADR-0015: Provider Effect Capability and Authorized Sent Boundary（模型副作用能力与授权发送边界）
- `docs/runtime-v2/startup-recovery-state-machine.md`
