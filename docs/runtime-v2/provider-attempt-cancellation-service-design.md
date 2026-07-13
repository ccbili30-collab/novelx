# Provider Attempt Cancellation Service（模型请求尝试取消服务）设计

日期：2026-07-13

状态：Proposed（提议中）

范围：Durable Run Cancel A2.2（持久化任务取消第二批之模型请求取消）

依赖：A2.1 `RunCancellationIntentProof`（任务取消意图证明）、Provider Sent v2（模型发送边界第二版）、Operational Recovery（运行恢复）、Workspace Runtime Lease（工作区运行时租约）

## 1. 文档目的

本文细化 `durable-run-cancel-a2-plan.md` 中的 Provider Attempt Cancellation Service。它只解决一个严格问题：当持久化的 RunCancel（任务取消）确实在 Provider Sent（模型请求已发送）之前赢得线性化竞争时，如何把同一 `ProviderAttempt` 从 `Requested` 原子地推进到 `CancelledBeforeSent`，并在崩溃、重启、并发和幂等重放后仍能证明没有发送 HTTP 请求。

本文不是完成声明。当前代码已有 `provider.cancelled_before_sent` 事件、Global CAS（全局比较并交换）、PreSendLinearizationGate（发送前线性化闸门）和 Operational Recovery interruption（运行恢复中断），但这些能力尚未通过不可伪造的证明类型接成安全写入链。

核心决定：

1. 取消服务不接受裸 `intent_id`、任意 SHA-256、布尔取消状态或普通 Gate snapshot（闸门快照）。
2. 写入必须同时消费 sealed IntentProof（密封意图证明）和 one-shot GateProof（一次性闸门证明）。
3. Recovery interruption proof（恢复中断证明）由服务从 Journal（事件日志）内部查询，不信任调用方提供的可序列化结构。
4. 服务在同一 Workspace Runtime Lease 和 Provider Attempt execution guard（模型请求执行锁）保护下，使用 Global + Run + Attempt 三重 CAS 写入。
5. `Sent` 是否赢得竞争只能由持久事件顺序判定，不能由进程内 Gate 状态猜测。

## 2. 当前实现事实与安全缺口

### 2.1 Provider Attempt 写入口过宽

当前 `ProviderAttemptCancelledBeforeSent::derive` 接受调用方提供的任意 `String`，只检查它是否为小写 SHA-256。`ProviderAttemptAggregate::cancel_before_sent` 只复核 Attempt 的 Requested sequence（已请求序列）、definition hash（定义哈希）、evidence hash（证据哈希）以及调用方传入的 Run / Global sequence。

它没有独立证明：

- Run 中存在完全匹配且仍活动的 `run.cancellation_intent_recorded`；
- cancellation hash 来自该真实 RuntimeEvent（运行时事件）；
- RunCancel 而非 RuntimeShutdown（运行时关闭）或 HostDisconnected（宿主断开）赢得发送前闸门；
- 当前进程持有保护同一个规范数据库的 Workspace Runtime Lease；
- Recovery owner（恢复所有者）已经持久化不可恢复的 RunCancel interruption；
- `provider.sent` 是否已经以更早的 Run sequence（运行序列）提交。

因此，现有低层方法只能作为待收窄的 aggregate transition kernel（聚合转换内核），不能继续充当 live service API（真实服务接口）。

### 2.2 EventJournal 已有正确的原子写栅栏

`EventJournal::append_at_global_sequence` 在同一个 SQLite `Immediate` transaction（立即事务）中校验：

- message ID（消息标识符）与 idempotency key（幂等键）；
- Global Event Clock（全局事件时钟）；
- Run sequence；
- target aggregate sequence（目标聚合序列）；
- 最终事件插入。

这个原语应继续作为最终线性化点。服务不能在它之外用“先检查、后普通 append”的方式模拟三重 CAS。

EventJournal 会在检查 Global CAS 之前识别完全相同的已存在事件。取消服务必须利用这一点，但要先重放精确事件，再生成新的 timestamp（时间戳）。若重试时复用确定性 message ID 却生成新时间戳，`same_full_event` 会把它识别为冲突，而不是幂等成功。

### 2.3 Hub 当前只有观察信息，没有写入权限证明

现有 `PreSendGateSnapshot`、`ActiveRunCancellation`、`CancellationSignalReceipt` 和 `AbandonBeforeSentReceipt` 都是进程内观察结果。`AbandonBeforeSentReceipt` 只说明 registration（注册）是否存在、取消原因和可选 intent ID，不绑定：

- 规范数据库身份；
- workspace / run / attempt；
- Hub instance（取消中心实例）；
- registration ID；
- Intent event hash（意图事件哈希）；
- sticky signal sequence（粘性信号序列）。

它们不能授权持久写入 `provider.cancelled_before_sent`。

### 2.4 Recovery interruption 仍可被裸字符串伪造

`OperationalRecoveryInterruptionRequest` 当前接受 `Option<String>` cancellation intent ID，`OperationalRecoveryExecutionInterruption` 也是可克隆、可序列化的普通数据。它们能够提供审计字段，但不是密封证明。

另有一个跨重启幂等缺口：当前 `interruption_id` 的派生材料包含 recorder instance ID（记录器实例标识符）和 lease epoch（租约世代）。如果 interruption 事件已经提交、返回 ACK（确认响应）前进程崩溃，新进程取得新 lease 后会派生不同 ID；当前精确 ID 去重无法阻止第二条语义相同的 interruption。

### 2.5 Foreground 尚未进入统一 Gate 协议

`LiveAgentLoopRunner::execute_provider_round` 当前没有把 Foreground Provider effect（前台模型副作用）注册到 RuntimeCancellationHub。它向 `arm_authorized_dispatch` 传入 `watch::Receiver<bool>` 的当前布尔值。布尔读取与 `provider.sent` 写入之间存在竞态，也不能产生 GateProof。

`ProviderEffectAuthorizationService` 与 Recovery 对应服务还必须在授权时检查：

```rust
if !run.permits_new_side_effects() {
    return Err(RunCancellationPending { intent_id });
}
```

Run lifecycle（运行生命周期）仍为 `Running` 不代表允许副作用；正交的 cancellation state（取消状态）可能已经是 `IntentRecorded`。

## 3. 必须保持的安全不变量

1. **Journal authority（事件日志权威）**：Hub、watch signal 和内存 task 状态只控制执行，不构成业务取消事实。
2. **No raw hash authority（裸哈希无权限）**：任意格式正确的 SHA-256 不能授权取消 Attempt。
3. **Gate-before-cancel（先闸门后取消）**：没有同一 RunCancel 赢得发送前闸门的密封证明，不得写 `CancelledBeforeSent`。
4. **Sent is durable（发送以持久事件为准）**：Gate snapshot 不能覆盖已经提交的 `provider.sent`。
5. **Recovery-before-attempt-terminal（先恢复中断后请求终态）**：活跃 Recovery execution 必须先有精确 RunCancel interruption，再取消其 Attempt。
6. **Single owner（单一所有者）**：CancellationCoordinator（取消协调器）不能抢占仍持有 Attempt 的 Foreground 或 Recovery owner。
7. **Lease-protected write（租约保护写入）**：服务从证据读取到写入验证结束，全程持有同一数据库的 Workspace Runtime Lease。
8. **Exact replay（精确重放）**：崩溃或 ACK 丢失后的重试复用原事件，不生成语义相同但身份不同的新事件。
9. **Fail closed（失败关闭）**：证据缺失、歧义、损坏或顺序不可能时进入阻塞或隔离，不猜测安全取消。

## 4. A2.1 Sealed IntentProof（密封意图证明）依赖

A2.2 对 A2.1 是单向依赖：A2.1 不读取 Provider Attempt；A2.2 只能消费 A2.1 从 Journal 恢复出的证明和新鲜写栅栏。

所需最小契约：

```rust
pub struct RunCancellationIntentProof {
    database_identity_sha256: String,
    workspace_id: String,
    project_id: String,
    run_id: String,
    intent: RunCancellationIntent,
    intent_event_run_sequence: u64,
    intent_event_aggregate_sequence: u64,
    intent_event_sha256: String,
    pinned_identity_sha256: String,
}

pub struct RunCancellationWriteFence {
    proof: RunCancellationIntentProof,
    expected_run_sequence: u64,
    expected_run_aggregate_sequence: u64,
    expected_global_sequence: u64,
}
```

约束：

- 字段私有，不实现 `Deserialize`，不提供生产构造器。
- proof 只能来自 `record_intent`、`recover_active_intent` 或 `scan_active_intents` 的 Journal 重放。
- `intent_event_sha256` 覆盖完整 RuntimeEvent 地址、序列、消息、幂等键、事件类型、版本、payload 和时间，并使用版本化 Canonical JSON（规范 JSON）。
- proof 必须暴露 intent event 的 Run sequence；A2.2 依赖它判定 Sent 与 Intent 的持久顺序。
- `RunCancellationWriteFence` 不实现 `Clone`、`Serialize` 或 `Deserialize`，每次写入前调用 `refresh_write_fence(&proof)` 重新获得，并按值消费。
- `refresh_write_fence` 必须证明 Run 仍是同一 `IntentRecorded`、同一 pinned identity（固定身份），且两次读取之间 Global Clock 未变化。

A2.1 未满足这些契约前，A2.2 可以编写 aggregate/service 单元测试，但不得接入 live cancellation（真实取消）路径。

## 5. Provider Effect identity（模型副作用身份）统一

现有只面向 Recovery 的 task identity 应泛化为：

```rust
pub(crate) struct ProviderEffectTaskIdentity {
    database_identity_sha256: String,
    workspace_id: String,
    run_id: String,
    attempt_id: String,
    owner: ProviderEffectOwner,
}

pub(crate) enum ProviderEffectOwner {
    Foreground {
        invocation_id: String,
        inference_id: String,
    },
    Recovery {
        operation_id: String,
        execution_id: String,
    },
    CancellationCoordinator {
        intent_id: String,
    },
}
```

同一个 Attempt 在同一时刻只能有一个 owner。Foreground、Recovery 与 CancellationCoordinator 必须使用同一 owner registry（所有者注册表）、Gate、SentReservation（发送预约）和 terminal finalizer（终态收口器）。

## 6. One-shot GateProof（一次性闸门证明）

### 6.1 类型

```rust
#[must_use]
pub(crate) struct ProviderRunCancelGateProof {
    database_identity_sha256: String,
    hub_instance_id: Uuid,
    registration_id: Uuid,
    identity: ProviderEffectTaskIdentity,
    intent_id: String,
    intent_event_sha256: String,
    signal_sequence: u64,
}
```

该类型：

- 不实现 `Clone`、`Copy`、`Serialize` 或 `Deserialize`；
- 字段私有，`Debug` 不输出敏感或可复制证明材料；
- 只能由持有 registration 的同一个 RuntimeCancellationHub 创建；
- 按值交给取消服务并消费。

### 6.2 Hub API

```rust
pub(crate) fn take_run_cancelled_before_sent(
    &self,
    registration: ProviderEffectTaskRegistration,
    intent: &RunCancellationIntentProof,
) -> Result<ProviderRunCancelGateProof, RuntimeCancellationHubError>;
```

Hub 必须在同一互斥锁内：

1. 验证 registration ID、Hub instance、owner、database、workspace、run 和 attempt 完全一致。
2. 验证 Gate 状态严格为 `CancelledBeforeSent`。
3. 验证最早且实际生效的 cancellation cause 严格为 `RunCancel`。
4. 验证 sticky cancellation 保存的是同一 IntentProof 的 intent ID 和 intent event hash，而不只是相同字符串。
5. 删除 registration、attempt owner 和 execution owner。
6. 返回一次性 GateProof。

以下状态不得产生业务 RunCancel GateProof：

- `Open`；
- `SentReserved`；
- `SentCommitted`；
- `DispatchBoundaryUnknown`；
- 由 RuntimeShutdown 或 HostDisconnected 触发的 `CancelledBeforeSent`；
- 已被领取、注销或来自其他 Hub instance 的 registration。

现有 `abandon_before_sent` 只保留为生命周期清理接口，其 receipt 永远不能被 Provider Attempt Cancellation Service 接受。

`signal_run_cancel` 和 `hydrate_run_cancel` 的生产接口也必须改为接受 `&RunCancellationIntentProof`，Hub sticky 保存完整的 database / workspace / run / intent event hash 绑定；接受裸字符串的版本只能留在 `#[cfg(test)]`。

## 7. Recovery RunCancel InterruptionProof（恢复取消中断证明）

### 7.1 密封查询结果

```rust
pub(crate) struct OperationalRecoveryRunCancelInterruptionProof {
    database_identity_sha256: String,
    workspace_id: String,
    project_id: String,
    run_id: String,
    operation_id: String,
    execution_id: String,
    claim_id: String,
    fencing_token: u64,
    action_spec_sha256: String,
    interruption_id: String,
    interruption_event_sha256: String,
    recovery_revision: u64,
    recovery_last_event_hash: String,
    attempt_id: String,
    requested_aggregate_sequence: u64,
    requested_definition_sha256: String,
    requested_evidence_sha256: String,
    intent_id: String,
}
```

该证明不提供公开构造器，不实现 `Deserialize`。只有读取并严格重放 Operational Recovery aggregate（运行恢复聚合）的查询服务可以生成。

推荐查询接口：

```rust
pub(crate) enum RecoveryInterruptionRequirement {
    None,
    Exact(OperationalRecoveryRunCancelInterruptionProof),
}

pub(crate) fn resolve_for_attempt(
    &self,
    intent: &RunCancellationIntentProof,
    attempt: &ProviderAttemptAggregate,
) -> Result<RecoveryInterruptionRequirement, RecoveryInterruptionQueryError>;
```

取消服务应内部调用查询。即使集成层暂时传入 proof hint（证明提示），服务仍必须在同一个 Global fence 下重新读取并比较；调用方不能通过传 `None` 绕过活跃 Recovery owner。

### 7.2 活跃 owner 判定

查询必须枚举该 Run 中所有：

- 非 stale（未失效）；
- outcome 为空；
- 已开始 execution；
- claim action 为 `PersistedProviderAttemptDispatch`；
- action 指向目标 attempt 和取消前 Requested sequence；

的 Recovery operation。

分类：

- 0 个匹配 owner：`None`。
- 1 个匹配 owner：必须找到同一 operation / execution / claim / fencing token / action / attempt / intent 的 RunCancel interruption。
- 多于 1 个：`MultipleRecoveryOwners`，进入 Quarantined（隔离），不能任取一条。

精确 interruption 还必须证明 `transport_boundary_crossed = false`、`resumable = false`，并绑定取消前 Attempt 的 sequence、definition hash 和 evidence hash。

旧 interruption 的 recorder lease 不要求等于当前写入 lease。它证明的是过去记录动作由当时合法 lease 完成；当前 Workspace Runtime Lease 只负责保护当前查询和 Attempt 写入。

### 7.3 跨 lease 语义幂等缺口

在 A2.2 killpoint（强杀点）验收前，Operational Recovery recording 必须解决以下问题：

```text
interruption event 已提交
-> ACK 丢失 / 进程崩溃
-> 新进程取得新 recorderInstanceId 和 leaseEpoch
-> 相同语义请求派生出不同 interruption_id
```

允许的修复方向只有两个：

1. 写入前按 operation、execution、attempt、intent、Requested evidence 查询语义相同的既有 interruption，完全匹配时返回原事件；或
2. 引入 v2 稳定 RunCancel interruption ID，不再把 recorder instance / lease epoch 纳入身份哈希，只把它们保留为审计字段。

多个语义匹配但事件身份不同属于数据冲突，必须隔离。不能通过“选择最新一条”掩盖重复事件。

同时应拆分 recording API：RuntimeShutdown / HostDisconnected 使用普通 lifecycle interruption（生命周期中断）入口；RunCancel 入口必须接受 `&RunCancellationIntentProof`，禁止裸 intent hash。

## 8. ProviderAttemptCancellationService 接口

推荐最窄生产接口：

```rust
pub(crate) struct ProviderAttemptCancellationService {
    database_path: PathBuf,
    database_identity_sha256: String,
    max_cas_retries: u8,
}

pub(crate) fn cancel_requested_before_sent(
    &self,
    intent: &RunCancellationIntentProof,
    gate: ProviderRunCancelGateProof,
    lease: &WorkspaceRuntimeLease,
) -> Result<ProviderCancellationResult, ProviderAttemptCancellationError>;
```

不接收裸 `attempt_id`：目标 attempt 从 GateProof 的密封 identity 得到。不接收 caller-selected（调用方选择的）optional recovery proof：Recovery requirement 由服务内部查询。

结果类型：

```rust
pub(crate) enum ProviderCancellationResult {
    CancelledBeforeSent(ProviderCancellationReceipt),
    AlreadyCancelledBeforeSent(ProviderCancellationReceipt),
    SentBoundaryWon(ProviderAttemptTerminalSnapshot),
    KnownTerminal(ProviderAttemptTerminalSnapshot),
    OutcomeUnknown(ProviderAttemptTerminalSnapshot),
}

pub(crate) struct ProviderCancellationReceipt {
    run_id: String,
    attempt_id: String,
    intent_id: String,
    intent_event_sha256: String,
    cancellation_event_sha256: String,
    cancellation_event_run_sequence: u64,
    requested_aggregate_sequence: u64,
    cancelled_aggregate_sequence: u64,
    requested_definition_sha256: String,
    requested_evidence_sha256: String,
    cancelled_evidence_sha256: String,
}
```

`ProviderAttemptTerminalSnapshot` 至少包含 state、aggregate sequence、definition hash、evidence hash，以及可用时的 Sent event Run sequence。结果不能只返回枚举标签，否则后续 Coordinator 无法构造可审计 evidence manifest（证据清单）。

建议错误分类：

- `WorkspaceLeaseMismatch`
- `DatabaseIdentityMismatch`
- `IntentProofMismatch`
- `IntentNotActive`
- `GateProofMismatch`
- `GateDidNotProveRunCancel`
- `AttemptOwnerActive`
- `AttemptIdentityMismatch`
- `RecoverySubjectMismatch`
- `RecoveryInterruptionRequired`
- `RecoveryInterruptionConflict`
- `MultipleRecoveryOwners`
- `SentAfterCancellationIntent`
- `CancelledByDifferentIntent`
- `CancellationEvidenceConflict`
- `EvidenceContended`
- 包装后的 Journal / storage（存储）错误

## 9. 固定调用顺序

### 9.1 外部 Saga 顺序

```text
A2.1 persist exact Run cancellation intent with Global CAS
-> Hub signal exact IntentProof
-> current Provider owner drains
-> Recovery owner first persists exact RunCancel interruption when applicable
-> CancellationCoordinator obtains/creates the sole owner registration
-> sticky Intent makes the fresh Gate RunCancel-cancelled
-> coordinator takes one-shot GateProof
-> A2.2 cancels the Requested Attempt
-> Recovery outcome / AgentLoop / Run settlement continue
-> only after durable settlement and zero registrations clear sticky cancellation
```

若原 Foreground 或 Recovery owner 仍活跃，Coordinator 等待其收口，不能注册同一 Attempt 抢占所有权。为了让崩溃恢复和正常路径一致，推荐原 owner 释放后由 CancellationCoordinator 创建新的、同一 sticky Intent 下的 registration，再领取 GateProof。

### 9.2 服务内部顺序

1. 校验 IntentProof 和 GateProof 的 database、workspace、run、attempt、intent event hash。
2. 校验 Workspace Runtime Lease 保护同一 canonical database identity（规范数据库身份）。
3. 获取 `ProviderAttemptExecutionGuard` 并持有到结果验证结束；若已有 sender owner，返回 `AttemptOwnerActive`。
4. 在生成新 metadata 和时间戳前，快速重放完全相同的既有 `provider.cancelled_before_sent`；存在则返回 `AlreadyCancelledBeforeSent`。
5. 调用 `RunCancellationService::refresh_write_fence(intent)` 获得新鲜 Run + Global fence。
6. 重放 Provider Attempt 及其原始事件，定位真实 `provider.sent`。
7. 比较 Sent event Run sequence 与 Intent event Run sequence。
8. 在同一稳定快照内解析 Recovery interruption requirement。
9. 对无需写入的 terminal 分类，再读 Global Clock；变化则重新读取，不能返回过期结论。
10. Attempt 仍为 Requested 时，从 IntentProof、GateProof、Attempt 和 fence 派生取消 payload。
11. 只有确认不存在既有事件后，才构造确定性 idempotency/message material（幂等与消息材料）和新 timestamp。
12. 使用 Global + Run + Attempt CAS 原子追加。
13. 重放精确取消事件和 Attempt，验证事件哈希并返回 receipt。
14. 释放 execution guard；Workspace lease 由调用方在整个 Saga 写阶段继续持有。

## 10. 跨聚合验证清单

每次写入必须验证：

- IntentProof 的 database / workspace / project / run / pinned identity 与当前 Run 完全一致。
- Run cancellation state 仍为同一 `IntentRecorded`，并定位到同一 intent event hash。
- GateProof 来自当前 Hub、同一 database / workspace / run / attempt / intent event，且 cause 为 RunCancel。
- GateProof 不表示任何 Sent gate state。
- Attempt definition 中的 run、invocation、request、context、model/provider identity 与目标完全一致。
- Attempt 当前没有活跃 execution guard owner。
- 当前 Workspace Runtime Lease 保护同一 canonical database。
- Global Clock 在读取证据和最终 append 之间未变化。
- 已存在 cancellation event 为空，或与当前 intent、Requested sequence、definition/evidence 完全相同。

存在 Recovery owner 时还必须验证：

- Recovery subject 的 workspace / project / run 完全一致。
- operation、execution、claim、owner instance、fencing token 和 action spec 精确匹配。
- action 指向同一 Attempt 及取消前 Requested sequence。
- interruption cause 为 RunCancel，intent、attempt、definition/evidence 完全匹配。
- `transport_boundary_crossed = false`、`resumable = false`。
- operation 未 stale、未产生 outcome。

## 11. Sent / Intent 持久顺序

真实顺序按 RuntimeEvent 的 Run sequence 判定：

| 持久证据 | 分类 | 动作 |
| --- | --- | --- |
| 无 Sent，Attempt=Requested | Pre-Sent candidate（发送前候选） | 满足全部证明后允许取消 |
| Sent sequence < Intent sequence | `SentBoundaryWon` | 不写发送前取消，进入真实终态或 Unknown |
| Sent sequence > Intent sequence | `SentAfterCancellationIntent` | 安全不变量破坏，隔离并停止自动处理 |
| Sent sequence = Intent sequence | 不可能 | Journal 地址/序列损坏，隔离 |
| Attempt=Responded/Failed | `KnownTerminal` | 返回真实证据，不改写为取消 |
| Attempt=OutcomeUnknown | `OutcomeUnknown` | 等待对账，不写 `CancelledBeforeSent` |

Intent 赢得 Global CAS 后，旧 Provider authorization 的 Sent append 应因 Run/Global fence 过期而失败。若仍观察到 Intent 后的 Sent，说明某条发送路径绕过统一授权或 CAS，不能自动“修正”为安全取消。

## 12. CAS 与幂等分类

| 重读结果 | 服务结果 | 是否重试 |
| --- | --- | --- |
| 完全相同 cancellation event | `AlreadyCancelledBeforeSent` | 否 |
| 同幂等身份但 payload/message 不同 | `CancellationEvidenceConflict` | 否，隔离 |
| Attempt 仍 Requested，仅无关 Global/Run 前进 | 刷新全部 proof/fence | 有界重试，建议最多 3 次 |
| Sent 早于 Intent | `SentBoundaryWon` | 否 |
| Sent 晚于 Intent | `SentAfterCancellationIntent` | 否，隔离 |
| Responded / Failed | `KnownTerminal` | 否 |
| OutcomeUnknown | `OutcomeUnknown` | 否 |
| 被不同 Intent 取消 | `CancelledByDifferentIntent` | 否，隔离 |
| Run 已不再是同一 IntentRecorded | `IntentNotActive` | 否 |
| Recovery proof 缺失、变化或歧义 | 对应结构化错误 | 否，等待/隔离 |
| execution guard 忙 | `AttemptOwnerActive` | 由 Coordinator 等待 owner drain，不在服务内抢占 |
| SQLite / Journal 错误 | 原样传播 | 不推断安全，不盲重试 |
| 连续 CAS 竞争超过预算 | `EvidenceContended` | 否 |

幂等键建议保持：

```text
provider:{attemptId}:cancel-before-sent:{intentId}:{requestedEvidenceHash}
```

message ID 使用同一稳定材料派生 UUID v5。服务必须先查原事件，避免 deterministic message ID（确定性消息标识符）与新 timestamp 发生 full-event 冲突。

## 13. 必须收窄或替换的 API

- `ProviderAttemptCancelledBeforeSent` 字段改为 private，并只提供审计 getter。
- `ProviderAttemptCancelledBeforeSent::derive` 改为 private / `pub(crate)`，接收 `&RunCancellationIntentProof`，不接收 `String`。
- `ProviderAttemptAggregate::cancel_before_sent` 改为 private / `pub(crate)` kernel；生产调用只允许经过取消服务。
- kernel append 返回实际持久 RuntimeEvent 或类型化 write outcome（写入结果），不能只返回 `()`。
- `RuntimeCancellationHub::signal_run_cancel` / `hydrate_run_cancel` 删除生产裸字符串版本。
- `active_run_cancellation`、snapshot 和 signal receipt 明确标注 observation-only（仅观察）。
- `abandon_before_sent` 与 `take_run_cancelled_before_sent` 分离，前者不能返回授权证明。
- `OperationalRecoveryRecordingService::record_execution_interruption` 拆分 lifecycle 与 RunCancel 路径，后者强制 IntentProof。
- 删除 Foreground `arm_authorized_dispatch(cancelled_before_sent: bool)`。
- Foreground / Recovery authorization 都检查 `run.permits_new_side_effects()`。
- 所有 Provider dispatch 都使用统一 registration、SentReservation 和 Global CAS arm 路径。

## 14. Foreground 接线前置条件

A2.2 不得先接 Recovery、以后再假设 Foreground 自然安全。进入 live 路径前必须完成：

1. Foreground 在最终授权前向 Hub 注册完整 ProviderEffectTaskIdentity。
2. Foreground 与 Recovery 共用相同 PreSendLinearizationGate 和 SentReservation。
3. Authorizer 在读取 Run 后拒绝 `!run.permits_new_side_effects()`。
4. `provider.sent` 使用 Run + Attempt + Global CAS，并在 Gate reserve 后、HTTP 前提交。
5. Intent CAS 赢时，Sent reservation 被释放且 HTTP 调用次数为 0。
6. Sent CAS 赢时，取消路径只能进入 Post-Sent，HTTP 至多一次。
7. watch channel 只用于停止 AgentLoop 后续工作，不作为 Attempt 取消证明。

在这些条件完成前，Foreground Requested Attempt 无法提供合格 GateProof，A2.2 只能保持未接线状态。

## 15. 测试矩阵

### 15.1 类型与 Gate 单元测试

- 同一 sticky IntentProof + RunCancel Gate 只能领取一次证明。
- 错误 intent、event hash、database、workspace、run、attempt、Hub instance、registration 全部拒绝。
- RuntimeShutdown / HostDisconnected 不能生成业务 RunCancel proof。
- Open / SentReserved / SentCommitted / DispatchBoundaryUnknown 全部拒绝。
- 已领取或 stale registration 不能产生第二份 proof。
- 编译可见性测试证明 GateProof 不可 Clone、Deserialize、公开构造。

### 15.2 Cancellation Service 单元测试

- Requested + 全部精确证明写入一条 `CancelledBeforeSent`。
- 完全相同重放返回 `AlreadyCancelledBeforeSent`，事件数不增加。
- API 层无法用任意 64 位 hash 构造 live cancellation。
- 无 GateProof 的调用在类型层面不可表达。
- Intent / Gate / Lease / database / Attempt 任一不匹配时零写入。
- execution guard 忙时返回 `AttemptOwnerActive`。
- 活跃 Recovery + 精确 interruption 成功。
- 活跃 Recovery 无 interruption、错误 intent/attempt/sequence/hash/execution/fence、stale 或已有 outcome 全部阻塞。
- 多个 Recovery owner 隔离。
- 被其他 intent 取消返回冲突。
- Sent / Responded / Failed / OutcomeUnknown 返回真实分类。
- Intent 后 Sent 触发安全不变量错误。
- 相同幂等键但不同 payload/event 触发硬冲突。

### 15.3 CAS 竞态测试

- 取 fence 后另一个 workspace 写事件：刷新后只追加一条取消事件。
- Intent 赢 Sent reservation：Sent append CAS 失败，0 Sent、0 HTTP，最终取消。
- Sent 赢 Intent：恰好一条 Sent，绝无 `CancelledBeforeSent`。
- Attempt 在写前变成终态：返回真实终态。
- Run 在写前结算：不写取消事件。
- 连续 Global churn（全局时钟抖动）达到预算后返回 `EvidenceContended`。

### 15.4 Foreground 集成测试

- sticky cancellation 在 registration 前存在：新注册立即取消，0 Sent、0 HTTP。
- 授权后、reserve 前取消：0 Sent、0 HTTP。
- reserve 后、Sent CAS 前 Intent 赢：0 Sent、0 HTTP。
- Sent CAS 先赢：恰好一条 Sent、HTTP 至多一次、最终真实终态或 Unknown。
- 测试证明 bool-only arm 路径已删除。

### 15.5 Recovery 集成测试

- RunCancel -> interruption -> Attempt cancel -> Recovery `CancelledSafe`，重启后 0 redispatch（重新派发）。
- RuntimeShutdown / HostDisconnected interruption 保持 resumable，不能调用业务取消服务。
- interruption 后崩溃，新 Coordinator registration 取得 GateProof，取消同一 Attempt，0 HTTP。
- 活跃 owner 必须等待，不得被 Coordinator 抢占。
- Run A 取消不影响 Run B。
- 第二 Runtime 在取消和恢复终态写完前不能取得 Workspace lease。
- 启动 hydrate Requested Attempt 时无需 Provider binding 即可零网络收口。

### 15.6 Killpoint（强杀点）测试

| Killpoint | 重启后必需结果 |
| --- | --- |
| GateProof 后、execution guard 前 | 重新 hydrate / register，最终一条取消事件、0 HTTP |
| execution guard 后、refresh fence 前 | 同上，不保留幽灵 owner |
| refresh fence 后、append 前 | 重新读取全部证明，至多一条取消事件 |
| append commit 后、返回前 | 重放原事件为 Already，不能重复写 |
| interruption 已持久、Attempt 未终态 | 只补 Attempt cancellation |
| Attempt 已取消、Recovery outcome 未写 | 只补 Recovery `CancelledSafe` |
| Intent 已持久、Hub 尚未 signal | 启动 hydrate 捕获同一 Intent |
| Sent append 已提交、取消尚未分类 | 不得写 `CancelledBeforeSent` |
| Run settlement 已提交、Hub 尚未 clear | 重启不 hydrate、不重复取消 |
| 无关 Global CAS 使 fence 失效 | 有界重读，不盲写 |

Windows 子进程测试必须有硬超时、隐藏窗口、`kill + wait`、输出线程 join，并在结束后确认没有遗留 Runtime 或 Electron 进程。

## 16. 失败模式与处理

| 失败模式 | 影响 | 处理 |
| --- | --- | --- |
| 调用方伪造 hash | 错误取消其他 Attempt | 类型层只接受 sealed IntentProof |
| Gate receipt 被当作权限 | 没有赢 Sent 也写安全取消 | 使用一次性、Hub 内生成的 GateProof |
| Foreground 未注册 Hub | Intent 与 Sent 双赢 | 未统一前禁止 live 接线 |
| Recovery interruption 重复 | 重启后出现两条语义中断 | 语义查询复用或稳定 v2 ID |
| old lease 与 current lease 混淆 | 合法历史证明被拒绝或当前写越权 | 历史事件验证旧 lease；当前写强制当前 lease |
| ACK 丢失后新时间戳重试 | 幂等键与 full event 冲突 | 构造 metadata 前重放精确事件 |
| Intent 后仍出现 Sent | 取消安全性被绕过 | 隔离并审计发送路径，绝不改写为安全取消 |
| CAS 持续竞争 | 活锁或无限重试 | 有界重读后 `EvidenceContended` |

## 17. 实施切片

1. 完成并验收 A2.1 IntentProof / WriteFence 契约。
2. 泛化 ProviderEffectTaskIdentity，并实现 one-shot GateProof。
3. 修复 Foreground / Recovery authorization 对 cancellation barrier 的遗漏。
4. 修复 Recovery RunCancel interruption 的 proof-only 写入与跨 lease 语义幂等。
5. 实现 Recovery interruption query 和密封 proof。
6. 收窄 Provider Attempt aggregate API，并实现 Cancellation Service。
7. 接入 Coordinator，完成 Foreground / Recovery 统一竞态。
8. 运行单元、集成、CAS、killpoint 和 Windows 子进程测试。

任何切片都不能通过 mock Provider（模拟模型服务）、固定延迟或布尔状态冒充 live 安全性。

## 18. 不能宣称

在本文全部实现并通过测试前，不能宣称：

- `ProviderAttemptCancellationService` 已完成；
- Foreground 和 Recovery 已统一安全取消；
- Requested Attempt 可在重启后可靠零网络取消；
- 无 Gate / 任意 hash / Sent 误取消已经被消除；
- Durable Run Cancel A2 已闭环。

即使本文全部验收通过，也只能证明 Provider Attempt 的 Pre-Sent cancellation（模型请求发送前取消）闭环。ToolCall（工具调用）、Change Set（变更集）、Artifact（产物）、Assignment（智能体分配）和其他副作用尚未进入统一 Evidence Collector（证据收集器）时，仍不能宣称通用 Durable Run Cancel 或完整 NovelX Harness（运行框架）闭环。

当前最大未决风险是 Recovery interruption 跨 lease epoch 的语义幂等。这个问题未关闭前，`interruption persisted -> ACK lost -> restart` 强杀点不合格，A2.2 不能进入 live 路径。
