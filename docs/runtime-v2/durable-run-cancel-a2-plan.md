# Durable Run Cancel A2（持久化任务取消第二批）实施计划

日期：2026-07-13

状态：Proposed（提议中）

依赖：Durable Run Cancel A1（持久化任务取消第一批）、ADR-0016、Provider Sent v2（模型发送边界第二版）、Operational Recovery（运行恢复）、Workspace Runtime Lease（工作区运行时租约）

## 1. 目标与边界

A2 把 A1 已有的 Run cancellation aggregate（任务取消聚合）、`ProviderAttemptState::CancelledBeforeSent`、`OperationalRecoveryOutcome::CancelledSafe` 和 intent-aware RuntimeCancellationHub（带意图身份的运行时取消中心）接成一条可恢复 Saga（长事务链）。

固定权威顺序：

```text
persist RunCancellationIntent
-> signal RuntimeCancellationHub / RuntimeActor
-> drain Provider effect owners
-> classify and settle every Provider Attempt
-> settle Operational Recovery
-> settle AgentLoop
-> persist Run cancellation settlement
-> clear process-local sticky cancellation
```

任何路径都不得先发送内存信号再补事件，也不得因 RuntimeActor（运行时执行器）没有活动任务而直接写 `run.cancelled`。

A2 的验收名称只能是 Provider-only Durable Cancel（仅模型路径的持久取消）。以下副作用尚未进入统一 Evidence Collector（证据收集器）：

- ToolCall（工具调用）。
- Change Set（变更集）。
- Artifact（产物）写入。
- Assignment（智能体分配）终结与提交。
- 其他外部服务调用。

因此，A2 完成后也不能宣称通用 `run.cancel`、全部副作用安全取消或完整 Harness（运行框架）闭环。

## 2. 不可妥协的安全规则

1. Journal（事件日志）是唯一取消权威；Hub 和 Actor 信号只是执行控制。
2. 所有产生或终结外部副作用的写入都必须同时验证 Run、目标 aggregate（聚合）和 Global Event Clock（全局事件时钟）。
3. `Sent` 之后无法证明结果时必须进入 `OutcomeUnknown`，不能写 `CancelledBeforeSent`、`FailedSafe` 或 `CancelledSafe`。
4. A2 未覆盖的副作用存在时，Run 保持 `IntentRecorded` 并报告证据不完整，不得以功能降级为理由伪造安全终态。
5. Runtime shutdown（运行时关闭）和 Host EOF（宿主输入结束）不是业务 `run.cancel`，仍按可恢复 interruption（中断）处理。
6. 对同一幂等请求的重放必须复用原事件；CAS（比较并交换）冲突后必须重新读取并分类，禁止盲重试。

## 3. Authoritative Proof（权威证明）

### 3.1 类型

证明类型放在 `run_cancellation_service.rs`，字段私有，不实现 `Deserialize`，不提供公开构造器：

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
    expected_global_sequence: u64,
}

pub struct RunCancellationSettlementProof {
    workspace_id: String,
    run_id: String,
    intent_id: String,
    settlement_event_sha256: String,
    settlement_kind: RunCancellationSettlementKind,
}

pub enum RunCancellationSettlementKind {
    CancelledSafe,
    ReconciliationRequired,
}
```

`RunCancellationIntentProof` 可以在 crate（包）内部按值传递或受控克隆，但每一次写操作必须重新取得不可复用的 `RunCancellationWriteFence`。旧 Fence 在任何全局事件写入后自然失效。

### 3.2 API

```rust
RunCancellationService::record_intent(...)
    -> RunCancellationIntentProof

RunCancellationService::recover_active_intent(run_id)
    -> Option<RunCancellationIntentProof>

RunCancellationService::scan_active_intents(workspace_id)
    -> Vec<RunCancellationIntentProof>

RunCancellationService::refresh_write_fence(&proof)
    -> RunCancellationWriteFence

RunCancellationService::recover_settlement_proof(&proof)
    -> RunCancellationSettlementProof
```

`refresh_write_fence` 必须：

1. 读取 Global Event Clock 为 `G`。
2. 重放 Run。
3. 定位精确的 `run.cancellation_intent_recorded` 事件。
4. 校验 Intent ID、事件哈希、Run / Workspace / Project、Pinned Identity（固定身份）和当前 `IntentRecorded` 状态。
5. 再读 Global Event Clock；只有仍为 `G` 才返回 Fence。

事件哈希使用稳定的 Canonical JSON（规范化 JSON），覆盖 RuntimeEvent（运行时事件）的完整地址、序列、消息、幂等键、类型、版本、payload（载荷）和时间。哈希方案必须有固定版本和跨语言 golden vector（黄金向量）。

### 3.3 Hub 只接受证明

生产 API 改为：

```rust
RuntimeCancellationHub::signal_run_cancel(&RunCancellationIntentProof)
RuntimeCancellationHub::hydrate_run_cancel(&RunCancellationIntentProof)
RuntimeCancellationHub::authorize_settled(&RunCancellationSettlementProof)
RuntimeCancellationHub::clear_run_cancel(RunCancellationSettledCapability)
```

删除生产环境接受裸 `workspace_id / run_id / intent_id` 的入口。测试专用构造器只能存在于 `#[cfg(test)]`。

## 4. Intent Service（意图服务）

### 4.1 写入顺序

```text
read Global Clock G0
-> recover Run at RunSeq R0 / AggregateSeq A0
-> validate idempotent retry or conflicting intent
-> append_at_global_sequence(
     run.cancellation_intent_recorded,
     expected_run = R0,
     expected_aggregate = A0,
     expected_global = G0
   )
-> recover exact event
-> return RunCancellationIntentProof
```

`RunAggregate::record_cancellation_intent` 需要增加 Global CAS 版本并返回实际存储事件，不能只返回业务 Intent。

同一 `cancel_idempotency_key` 和同一 reason（原因）返回原证明。以下情况必须冲突且不写入：

- 同 key 改 reason。
- 同一个未结算 Run 上出现另一个 Intent。
- Intent ID 相同但任何规范字段不同。

### 4.2 Run 状态

- `Created / Preparing / Running / WaitingForApproval / Retrying`：允许记录 Intent。
- `Committing`：允许记录以阻止新副作用，但 A2 不得自动写 `CancelledSafe`。
- `WaitingForReconciliation`：拒绝新 Intent，要求使用 `run.reconcile`。
- `Blocked / Cancelled / Failed / Completed`：只返回现有状态，不写新取消事件。

`IntentRecorded` 后，所有 Provider Effect Authorization（模型副作用授权）都必须检查 `run.permits_new_side_effects()` 并 fail closed（失败关闭）。

## 5. Provider Attempt Cancellation Service（模型尝试取消服务）

新增：

```rust
ProviderAttemptCancellationService::cancel_requested_before_sent(
    intent_proof,
    attempt_id,
    pre_send_gate_proof,
    optional_recovery_interruption_proof,
    lease,
) -> ProviderCancellationResult

pub enum ProviderCancellationResult {
    CancelledBeforeSent,
    AlreadyCancelledBeforeSent,
    SentBoundaryWon,
    KnownTerminal,
    OutcomeUnknown,
}
```

写入前必须验证：

- Run 仍绑定同一个 IntentProof。
- Run cancellation state（任务取消状态）仍为 `IntentRecorded`。
- Attempt 仍为 `Requested`。
- Attempt definition、evidence、aggregate sequence 未变化。
- PreSend Gate（发送前闸门）确实由同一 Intent 的 `RunCancel` 获胜。
- 若 Attempt 属于已启动的 Recovery Execution（恢复执行），存在精确、已持久化的 RunCancel interruption proof（中断证明）。
- Workspace Runtime Lease 仍保护当前数据库。

写入顺序：

```text
read Global Clock G
-> recover Run / Attempt / optional Recovery interruption
-> derive ProviderAttemptCancelledBeforeSent
-> append_at_global_sequence(
     provider.cancelled_before_sent,
     expected_run = current RunSeq,
     expected_attempt_aggregate = RequestedSeq,
     expected_global = G
   )
```

CAS 输掉后重新重放：

- 完全相同的取消事件：幂等成功。
- `Sent / Responded / Failed / OutcomeUnknown`：进入 Post-Sent（发送后）分支。
- 其他证据变化：有界重试或结构化阻塞。

## 6. Provider Effect Owner（模型副作用所有者）统一

把 `RecoveryTaskIdentity` 泛化为：

```rust
ProviderEffectTaskIdentity {
    workspace_id,
    run_id,
    attempt_id,
    owner:
      Foreground { invocation_id, inference_id }
      Recovery { operation_id, execution_id }
      CancellationCoordinator { intent_id }
}
```

三个 owner（所有者）共用：

- Attempt 唯一所有权。
- RuntimeCancellationHub。
- PreSendLinearizationGate（发送前线性化闸门）。
- HTTP cancellation receiver（HTTP 取消接收器）。
- Provider Attempt terminal finalizer（模型尝试终态收口器）。

`CancellationCoordinator` 是真实的取消结算执行者，不能伪装成 Foreground 或 Recovery。

`ProviderEffectAuthorizationService` 与 Recovery 版本都增加：

```rust
if !run.permits_new_side_effects() {
    return Err(RunCancellationPending(intent_id));
}
```

Intent 先提交时，旧 Authorization（授权）的 `provider.sent` Global CAS 必须失败；重新授权时则由 Run 状态拒绝。

## 7. Foreground（前台）接线

`LiveAgentLoopRunner::execute_provider_round` 固定为：

```text
ensure Requested
-> Hub register Foreground identity
-> authorize_live and recheck Run cancellation barrier
-> reserve Sent
-> persist provider.sent with Run / Attempt / Global CAS
-> commit process-local Gate
-> execute HTTP with Hub cancellation receiver
-> persist real Attempt terminal
-> unregister
```

RuntimeActor 的 watch signal（观察信号）只负责让高层 AgentLoop 停止继续工作，不构成 Pre-Sent 权威证明。

Pre-Sent RunCancel 必须先持久化 `provider.cancelled_before_sent`，随后 AgentLoop 才能持久化绑定同一 `intent_id` 的 Cancelled checkpoint（取消检查点）。Post-Sent 时必须先收口 Attempt 的真实终态，不能让 AgentLoop 的普通“cancelled by host”掩盖未知 Provider 结果。

## 8. RunCancellationCoordinator（任务取消协调器）

新增：

```rust
RunCancellationCoordinator::drive(
    proof,
    actor_handle,
    hub,
    lease,
) -> RunCancellationOutcome
```

### 8.1 固定流程

1. 验证 Workspace Runtime Lease。
2. 确认 Hub 安装的是同一 sticky Intent（粘性意图）。
3. 等待目标 Run 的 Actor task 和 Hub registration 收口。
4. 枚举 Run 的 Provider Attempts、Operational Recovery Operations、AgentLoop 和 Tool aggregates。
5. 执行 A2 安全边界检查。
6. 结算所有 Provider Attempts。
7. 结算所有 Operational Recovery Operations。
8. 依据是否存在 Unknown 选择安全取消或对账。
9. 生成持久 settlement proof（结算证明）。
10. 在目标 registration 为零后清理 Hub sticky。

### 8.2 A2 阻塞条件

A2 采取严格而不是乐观的边界：

- 存在任何 Tool aggregate：保持 `IntentRecorded`，返回 `RUN_CANCEL_EVIDENCE_INCOMPLETE`。
- Run 为 `Committing`：保持 `IntentRecorded`。
- 发现尚未纳入 Provider-only Manifest 的外部副作用：保持 `IntentRecorded`。
- 证据损坏或同一 Attempt 多 owner：Quarantined（隔离），不得结算。

Hub sticky 在证据不完整时不能清除，因为仍需阻止新的 Provider 副作用。

### 8.3 Requested Attempt

- 有 Recovery Execution：先持久化精确 RunCancel interruption，再调用 ProviderAttemptCancellationService。
- 无活动执行：Coordinator 以 `CancellationCoordinator { intent_id }` 注册目标 Attempt；sticky Intent 使 Gate 立即进入 `CancelledBeforeSent`，取得 Gate proof 后取消 Attempt。
- 已有活动 owner：等待其收口，不能抢占所有权。

### 8.4 Post-Sent

- `Responded / Failed`：已知终态，纳入最终证据。
- `Sent` 且没有终态：零网络写 `OutcomeUnknown`。
- `OutcomeUnknown`：进入对账分支。
- 禁止自动重发。

`Responded` 或确定的 `Failed` 即使发生在用户取消之后，也不能改写成 Pre-Sent；它们可以在所有副作用已知时作为安全终结证据。

### 8.5 Recovery Outcome

- Pre-Sent：`OperationalRecoveryOutcome::CancelledSafe`。
- Responded / Failed：保留其真实 Outcome。
- Unknown：`OperationalRecoveryOutcome::OutcomeUnknown`。

只有 `execution_interrupted { resumable: false }` 仍不足以关闭 Operation。

### 8.6 Unknown 分支

```text
sort + hash unknown effects
-> run.cancellation_reconciliation_required with Global CAS
-> Run = WaitingForReconciliation
-> recover RunCancellationSettlementProof
-> verify target registration count = 0
-> clear Hub sticky
```

该分支不得写 AgentLoop Cancelled，也不得写 `run.cancelled_safe`。

### 8.7 全部已知分支

```text
persist AgentLoop cancelled(intent_id, prior checkpoint)
-> rescan all Provider-only evidence
-> build deterministic Evidence Manifest
-> run.cancelled_safe with Global CAS
-> recover RunCancellationSettlementProof
-> verify target registration count = 0
-> Hub authorize_settled + clear
```

Evidence Manifest（证据清单）至少覆盖：

- Intent event hash。
- 排序后的所有 Provider Attempt 状态、序列、definition hash 和 evidence hash。
- 排序后的所有 Recovery Operation、Execution、Interruption、Outcome hash。
- AgentLoop 最终 checkpoint hash。
- `scope = provider_only_v1`。
- 无 Tool aggregate、Run 非 `Committing` 的扫描结论。

Manifest 的顺序和哈希算法必须固定并有 golden vector。

## 9. Host Barrier（宿主屏障）

删除当前语义分叉：

```text
active_tasks is empty -> direct run.cancelled
active_tasks exists -> legacy cancellation reconciliation
```

新的 `run.cancel` 永远进入同一 Saga：

```text
persist Intent
-> signal Hub
-> RuntimeActor.cancel_run
-> await target drain
-> Coordinator.drive
-> return structured RunSnapshot
```

### 9.1 Operational Recovery Barrier 内

`run.cancel` 是可达的控制面命令，不能作为普通命令等待 Recovery 完成：

1. Pump 继续只负责解析和排序。
2. Barrier 收到 `run.cancel` 后立即持久化 Intent。
3. IntentProof 成功后才 signal Hub 和 Actor。
4. 保存 Host correlation（宿主关联）和 PendingCancel（待处理取消）。
5. 当前 Recovery task 继续收口其 registration、interruption 和真实 Attempt terminal。
6. Recovery task 退出后运行 Coordinator。
7. 返回最终或结构化阻塞 snapshot。

同 Run、同 Intent 的重试复用原 Saga；不同未结算 Intent 返回冲突。不同 Run 的取消互不影响。普通命令继续进入有界队列，Shutdown / EOF / Fatal 仍必须可达。

### 9.2 Controlled Invalidation（受控失效）

Intent 写入会改变 Global Clock 和 source fingerprint（来源指纹）。当前 `SourceChangedDuringScan` 不能把这种已授权变化统一包装成 Fatal。

Operational Recovery pass（运行恢复轮次）应返回类型化结果：

```rust
OperationalRecoveryPassOutcome::Completed(report)
OperationalRecoveryPassOutcome::InvalidatedByRunCancellation {
    run_id,
    intent_id,
}
```

只有精确匹配已持久 Intent 的目标 Run 才能进入受控失效；其他来源变化继续 Fatal。失效后执行新的 zero-network cancellation convergence pass（零网络取消收敛轮次），不能重新发送 Provider 请求。

### 9.3 Target Drain（目标收口）

`RuntimeActor` 增加带确认的：

```rust
cancel_run(run_id)
wait_run_idle(run_id)
```

Hub 增加目标 Run registration drain notification（注册收口通知）。禁止用无界轮询猜测任务已经停止。

## 10. Startup Hydrate（启动水合）

Hub 必须在 `runtime.ready` 和 Operational Recovery 前创建。

启动顺序：

```text
acquire Workspace Runtime Lease
-> open and verify Journals
-> Assignment / Run Structural Recovery
-> scan_active_intents(workspace_id)
-> hydrate_run_cancel(proof)
-> run zero-network cancellation convergence
-> run local Operational Recovery scan
-> publish runtime.ready
```

只 hydrate `IntentRecorded`：

- `ReconciliationRequired` 已完成结算，不再安装 sticky。
- `CancelledSafe / AbandonedAfterUnknown / WithdrawnForRetry` 不 hydrate。
- Legacy cancellation（旧取消）进入兼容阻塞，不生成新式证明。

启动时的 Requested Attempt 必须在没有 Provider bind 的情况下完成 Pre-Sent 取消。Sent Attempt 必须转 Unknown 或消费已持久化终态，不能等待 Provider bind 后重发。

若 Intent 因 Tool / Committing 证据不完整而无法结算，Runtime 可以对其他 Run 发布 ready，但目标 Run 必须保持 sticky 和结构化阻塞状态。

## 11. Exact CAS and Idempotency（精确 CAS 与幂等）

所有 Saga 写步骤统一遵守：

```text
read Global Clock G
-> recover every referenced stream and exact proof
-> derive deterministic payload + idempotency key
-> append with expected Global / Run / Aggregate sequences
-> on conflict: recover and classify
-> never blind retry
```

幂等键：

```text
run:{runId}:cancel-intent:{intentId}
recovery:{operationId}:interrupt:{intentId}:{executionId}:{attemptEvidenceHash}
provider:{attemptId}:cancel-before-sent:{intentId}:{requestedEvidenceHash}
recovery:{operationId}:cancel-safe:{intentId}:{interruptionId}
agent-loop:{invocationId}:cancel-safe:{intentId}:{checkpointHash}
run:{runId}:cancel-safe:{intentId}:{manifestHash}
run:{runId}:cancel-reconciliation:{intentId}:{unknownEffectsHash}
```

内部事件 message ID（消息 ID）应由稳定幂等材料确定性派生，例如 UUID v5（第五版通用唯一标识符）。每个服务在构造新 timestamp（时间戳）前先重放并返回已存在的精确事件，避免“同幂等键但新时间戳”造成冲突。

## 12. Legacy Replacement（旧路径替换）

- `run.cancelled`：继续严格重放和展示。
- `run.cancellation_requested`：只读兼容；新 Host 路径永不写入。
- 未结算 legacy cancellation 必须返回专用兼容阻塞并继续旧对账，不能混入新 Intent。
- 删除 live 路径中的 `handle_run_cancel` 和 `handle_active_inference_cancel`。
- `RunCommandService::cancel` 不再作为 Host live API；如需保留，只能用于明确标注的 legacy replay / migration（旧事件重放或迁移）。
- `RuntimeActor::active_run_tasks` 只用于观察与 drain，不再决定取消语义。
- Actor watch 不是取消授权证明。

## 13. Crash Killpoint Matrix（崩溃强杀点矩阵）

| Killpoint（强杀点） | 重启后的必需结果 | 禁止结果 |
|---|---|---|
| `run_cancel.intent_persisted_before_signal` | hydrate 同一 Intent，0 新 HTTP | 丢失用户取消 |
| `run_cancel.signal_before_actor_cancel` | sticky 拦截所有新 registration | 新 Provider Sent |
| `run_cancel.gate_won_before_interruption` | 重建同一 interruption，Attempt 保持 Requested | 直接恢复发送 |
| `run_cancel.interruption_persisted_before_attempt_terminal` | 写同一 CancelledBeforeSent，0 HTTP | 重复 interruption 或 Sent |
| `provider_attempt.cancelled_before_recovery_outcome` | 只补 Recovery CancelledSafe | 重新执行 Provider |
| `run_cancel.recovery_outcomes_before_loop_cancel` | 只补 AgentLoop cancel | 改写 Attempt |
| `run_cancel.loop_cancelled_before_run_settlement` | 重建相同 Manifest 并结算 | 生成不同 Manifest |
| `run_cancel.run_settled_before_hub_clear` | Run 保持终态，不 hydrate、不重复写 | 再次创建取消周期 |
| `provider_attempt.authorized_sent_before_http` 后收到 cancel | Sent 赢，进入真实终态或 Unknown | CancelledBeforeSent |
| `run_cancel.http_cancelled_before_attempt_terminal` | Sent 重放为 OutcomeUnknown，0 重发 | FailedSafe / CancelledSafe |
| `run_cancel.outcome_unknown_before_reconciliation` | 补 ReconciliationRequired | 自动 retry |
| `run_cancel.reconciliation_before_hub_clear` | 保持等待对账并清理进程 sticky | 新副作用授权 |
| Barrier 处理 cancel 后立即 Shutdown | 先持久化真实取消/未知状态，再 stopped | 仅内存取消 |
| Barrier 处理 cancel 后 Host EOF | 重启能继续同一 Intent | Intent 丢失 |
| Intent 与 Sent 并发 CAS | 恰好一方先提交；Intent 赢则 0 HTTP，Sent 赢则 Post-Sent | 双赢或无证据 HTTP |
| 同 key 改 reason | 明确幂等冲突 | 覆盖原 Intent |
| 两个不同 Intent 并发 | 一个成功，一个冲突 | 两个活动 Intent |
| Run A / Run B 并发取消 | 相互隔离 | 全局误取消 |
| Tool 或 Committing blocker | 保持 IntentRecorded + evidence incomplete | `run.cancelled_safe` |

测试至少分为：

1. Aggregate replay tests（聚合重放测试）。
2. Service failpoint tests（服务故障注入测试）。
3. Windows child-process kill/restart blackbox（Windows 子进程强杀/重启黑盒测试）。

Windows 黑盒测试必须带硬超时、隐藏窗口、`kill + wait`、输出读取线程 join，并在测试后确认无残留 Runtime / Electron 进程。

## 14. Module Modification List（模块修改清单）

### 14.1 新增

- `runtime/crates/novelx-runtime/src/run_cancellation_service.rs`
- `runtime/crates/novelx-runtime/src/run_cancellation_coordinator.rs`
- `runtime/crates/novelx-runtime/src/provider_attempt_cancellation_service.rs`
- `runtime/crates/novelx-runtime/src/agent_loop_cancellation_service.rs`

### 14.2 修改

- `run_aggregate.rs`
  - Intent / settlement Global CAS。
  - 精确事件证明与 settlement proof 恢复。
  - Intent 可记录状态与终态幂等规则。
- `runtime_cancellation_hub.rs`
  - Proof-only API。
  - `ProviderEffectTaskIdentity`。
  - 目标 Run registration drain。
- `runtime_actor.rs`
  - 带确认的 `cancel_run`。
  - `wait_run_idle`。
- `provider_effect_authorization_service.rs`
  - `permits_new_side_effects` 检查与 typed cancellation error（类型化取消错误）。
- `provider_recovery_effect_authorization_service.rs`
  - 同上，并把已持久 Intent 导致的证据变化识别为受控取消。
- `provider_inference_service.rs`
  - Foreground / Recovery 共用 Gate。
  - Pre-Sent / Post-Sent 类型化终态。
- `live_agent_loop_runner.rs`
  - Foreground Hub registration。
  - 绑定 Intent 的 AgentLoop cancel。
- `provider_dispatch_recovery_service.rs`
  - Sealed interruption proof（密封中断证明）。
  - CancelledSafe / known terminal / unknown 收口。
- `provider_dispatch_recovery_supervisor.rs`
  - RunCancel interruption 必须结算。
  - 受控失效不是 Fatal。
- `operational_recovery_recording_service.rs`
  - 禁止以裸 cause + intent 字符串伪造 RunCancel interruption。
- `operational_recovery_scanner.rs`
  - 正确认识 CancelledBeforeSent 与 cancellation state。
  - IntentRecorded 不得重新生成 Provider dispatch action（模型分发动作）。
- `operational_recovery_action.rs`
  - 增加取消本地投影或专用 action。
- `run_command_service.rs`
  - 移除 live legacy cancel。
- `main.rs`
  - Startup hydrate。
  - Barrier 内目标取消。
  - PendingCancel Saga 和 typed recovery invalidation。
- `lib.rs`
  - 导出新模块。
- `runtime/crates/novelx-protocol/src/lib.rs`
  - RunSnapshot cancellation disposition（取消处置）、intent 和 evidence 状态。
- Electron / TypeScript Protocol（Electron / TypeScript 协议）
  - 严格解析 `intent_recorded / cancelled_safe / reconciliation_required / evidence_incomplete`。

### 14.3 测试

- `tests/run_cancellation_service.rs`
- `tests/run_cancellation_coordinator.rs`
- `tests/provider_attempt_cancellation_service.rs`
- `tests/runtime_cancellation_hub.rs`
- `tests/provider_dispatch_recovery_service.rs`
- `tests/provider_dispatch_recovery_supervisor.rs`
- `tests/runtime_process_durable_cancel.rs`
- 对应 TypeScript protocol / Supervisor tests（协议与监督器测试）。

## 15. A2 Acceptance（A2 验收）

只有全部满足以下条件才可称为 Provider-only Durable Cancel 完成：

- Host `run.cancel` 永远先持久化 Intent，后发送任何内存信号。
- Foreground 与 Recovery 使用同一 Hub、Gate、Attempt owner 和竞态矩阵。
- Intent 赢 Sent 时为 0 `provider.sent`、0 HTTP、Attempt `CancelledBeforeSent`。
- Sent 赢 Intent 时至多 1 HTTP，并进入真实终态或 `OutcomeUnknown`。
- 重启能 hydrate 未结算 Intent，且不需要 Provider bind 即可完成零网络收口。
- `OutcomeUnknown` 永不生成 `CancelledSafe`。
- Barrier 内目标 `run.cancel` 可达，Shutdown / EOF 仍可达，普通命令有界排队。
- 同一 Saga 每个强杀点均有真实 Windows 子进程 kill/restart 证据。
- Tool / Committing / 未覆盖副作用存在时保持证据不完整，不伪造安全终态。
- Run snapshot 和错误协议能明确区分 IntentRecorded、CancelledSafe、ReconciliationRequired 和 EvidenceIncomplete。

即使上述全部通过，Tool、Change Set、Artifact、Assignment 和其他副作用仍未进入统一 Evidence Collector。因此 A2 仍不是通用 Durable Run Cancel，也不是完整 NovelX Harness 闭环。
