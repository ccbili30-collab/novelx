# Durable Run Cancel（持久化任务取消）设计基线

日期：2026-07-13

状态：Accepted for implementation（已接受，待实现）

依赖：ADR-0016、Provider Sent v2（模型发送边界第二版）、Operational Recovery（运行恢复）

## 1. 问题

当前 `run.cancel` 在 RuntimeActor（运行时执行器）没有发现活动任务时，会直接写入 `run.cancelled`。这个判断不完整：Operational Recovery（运行恢复）、尚未注册的 Provider Attempt（模型调用尝试）、ToolCall（工具调用）或正在提交的 Change Set（变更集）可能仍有外部副作用。

现有 `run.cancellation_requested` 也不能直接承担新语义：

- 强制要求非空 `attemptIds`，无法表达 Attempt 注册前的取消；
- 只覆盖 RuntimeActor 已知的 Attempt，遗漏 Recovery、Tool、Change Set 和 AgentLoop（智能体循环）；
- 写入后立即进入 `WaitingForReconciliation`（等待对账），无法表达发送前的安全取消；
- 同一个幂等键绑定当时发现的 Attempt 列表，稍后发现新 Attempt 会冲突；
- 没有 Operation、Execution、Fence、Checkpoint 或 Evidence Hash（操作、执行、栅栏、检查点、证据哈希）。

因此，旧事件只保留 Legacy Compatibility（历史兼容）读取；新的 Host（宿主）取消路径不得继续写它。

## 2. 正交取消状态

Run 生命周期之外增加 `RunCancellationState（任务取消状态）`：

```text
None
  -> IntentRecorded
       -> CancelledSafe
       -> ReconciliationRequired
            -> AbandonedAfterUnknown
            -> WithdrawnForRetry
```

- `IntentRecorded（意图已记录）`：不立即改变 Run 生命周期，但所有新的副作用授权必须拒绝该 Run。
- `CancelledSafe（安全取消）`：已证明没有未决外部副作用，Run 才能进入 `Cancelled`。
- `ReconciliationRequired（需要对账）`：取消输给了 Sent 边界，Run 进入 `WaitingForReconciliation`。
- `AbandonedAfterUnknown（结果未知后放弃）`：用户接受未知结果并结束 Run；UI 可以显示“已取消”，审计层不得称为安全取消。
- `WithdrawnForRetry（撤销取消并重试）`：用户明确接受潜在重复风险后，才允许新的 Attempt。

新事件：

```text
run.cancellation_intent_recorded v1
run.cancelled_safe v1
run.cancellation_reconciliation_required v1
```

## 3. Durable Intent（持久取消意图）

```rust
RunCancellationIntent {
    intent_id,
    run_id,
    cancel_idempotency_key,
    reason,
    requested_at,
    command_message_id,
}
```

`intent_id` 使用 Canonical SHA-256（规范化 SHA-256）：

```text
SHA-256(
  "run-cancel-intent/v1"
  + workspaceId
  + runId
  + cancelIdempotencyKey
  + SHA-256(reason)
)
```

权威顺序固定为：

```text
persist cancellation intent
-> signal RuntimeCancellationHub / RuntimeActor
-> drain and classify every side effect
-> persist CancelledSafe or ReconciliationRequired
```

禁止先发送内存取消再补事件；否则在两者之间崩溃会永久丢失用户意图。

## 4. Pre-Sent（发送前）安全取消

Provider Attempt 增加终态：

```text
Requested -> CancelledBeforeSent
```

事件：

```text
provider.cancelled_before_sent v1
```

写入必须同时验证：

- Attempt 仍为 `Requested`；
- 聚合内不存在 `provider.sent`；
- Run 有完全匹配的持久取消意图；
- Pre-Send Gate（发送前闸门）由该意图赢得；
- Attempt definition、Evidence、AgentLoop checkpoint 未变化；
- Workspace / Run / Attempt 三层 CAS（比较并交换）都成功。

Recovery 路径的固定顺序：

```text
run.cancellation_intent_recorded
-> Hub RunCancel wins
-> operational_recovery.execution_interrupted
-> provider.cancelled_before_sent
-> OperationalRecoveryOutcome::CancelledSafe
-> AgentLoop cancelled
-> run.cancelled_safe
```

`OperationalRecoveryOutcome` 增加 `CancelledSafe`，至少固定：

- cancellation intent id；
- interruption id；
- attempt id、aggregate sequence、definition hash、evidence hash；
- execution / claim / fencing identity。

只有 `execution_interrupted { resumable: false }` 不足以关闭操作；没有一等 Outcome 时，重启后的 Supervisor（监督器）仍可能重新驱动同一个 Requested Attempt。

Runtime shutdown（运行时关闭）和 Host EOF（宿主输入结束）不是业务取消：它们继续保留 Requested Attempt 和可恢复 interruption，不得写 `CancelledSafe`。

## 5. Post-Sent（发送后）取消

取消输给 Sent 后，Attempt 只能进入真实终态：

```text
Sent -> Responded | Failed | OutcomeUnknown
```

若 HTTP 被取消且无法证明确定结果，必须持久化 `OutcomeUnknown`，随后写 `run.cancellation_reconciliation_required`。禁止：

- 写 `provider.cancelled_before_sent`；
- 写 `run.cancelled_safe`；
- 自动重发；
- 使用 `FailedSafe` 冒充用户取消。

用户后来选择结束时，`run.reconciled` 必须包含：

```text
cancellationDisposition = abandoned_after_unknown
```

## 6. Host Barrier（宿主屏障）接线

Operational Recovery Barrier 期间，目标 `run.cancel` 是控制面命令：

1. Pump 只负责解析和排序。
2. Dispatcher 收到 `run.cancel` 后先写取消意图。
3. 调用 intent-aware（带意图身份）的：

   ```rust
   RuntimeCancellationHub::signal_run_cancel(workspace_id, run_id, intent_id)
   RuntimeActorHandle::cancel_run(run_id)
   ```

4. 等待 Recovery Task 收口 interruption / outcome。
5. `RunCancellationCoordinator` 汇总权威证据并决定 Safe 或 Reconciliation。
6. 按 Host sequence 返回对应 `run.snapshot`；不同 Run 的取消不得互相影响。

## 7. Sticky Run Cancellation（粘性任务取消）

Hub 的 Run sticky 必须带 Intent 身份：

```rust
StickyRunCancellation {
    intent_id,
    signal_sequence,
    cause: RunCancel,
}
```

需要的接口：

```rust
signal_run_cancel(workspace_id, run_id, intent_id)
hydrate_run_cancel(...)
clear_run_cancel(settled_capability)
```

规则：

- 同一 Run、同一 Intent 幂等；未结算时不同 Intent 冲突。
- 新注册的 Foreground（前台）或 Recovery Attempt 自动继承 sticky。
- 重启后在 Operational Recovery 之前从 Journal（事件日志）恢复未结算 Intent。
- 只有 Journal 重建的 move-only `RunCancellationSettledCapability（任务取消结算能力）` 可以清理；调用方传入布尔值或字符串不构成证据。
- 清理前必须证明 Hub registration 为零、Run 已安全终结或进入对账、相关 Recovery Operation 全部终结。

## 8. Foreground / Recovery（前台 / 恢复）统一

`RecoveryTaskIdentity` 最终泛化为：

```rust
ProviderEffectTaskIdentity {
    workspace_id,
    run_id,
    attempt_id,
    owner:
      Foreground { invocation_id, inference_id }
      Recovery { operation_id, execution_id }
}
```

两条路径共用：

- RuntimeCancellationHub；
- PreSendLinearizationGate（发送前线性化闸门）；
- `provider.sent v2`；
- Gateway cancellation receiver（网关取消接收器）；
- Provider Attempt terminal finalizer（模型尝试终态收口器）。

所有 Provider Effect Issuer（模型副作用签发器）在最终授权时必须重放 Run，并拒绝存在未结算取消意图的 Run。

## 9. 实现切片

### Slice A：Provider-only safety（仅模型路径安全）

- `run_cancellation_service.rs`：Intent Service、Coordinator、Evidence Manifest。
- `provider_attempt_cancellation_service.rs`：Requested -> CancelledBeforeSent。
- `run_aggregate.rs`：持久化和重放正交取消状态。
- `operational_recovery_aggregate.rs`：`CancelledSafe` Outcome。
- `runtime_cancellation_hub.rs`：intent-aware sticky / hydrate / clear。
- `provider_dispatch_recovery_supervisor.rs`：RunCancel interruption 必须结算，禁止重新驱动。
- `main.rs`：Barrier 内目标取消。
- Rust / TypeScript Protocol（协议）输出 cancellation disposition。

### Slice B：Foreground convergence（前台路径收敛）

- `live_agent_loop_runner.rs`
- `provider_inference_service.rs`
- Provider / Recovery Effect Authorization Service（副作用授权服务）
- RuntimeActor task identity 与统一 Gate。

### Slice C：All-side-effect evidence（全部副作用证据）

- ToolCall、Change Set、Artifact、Assignment、AgentLoop 都进入 Evidence Collector（证据收集器）。
- 在 Slice C 完成前，若存在 Running Tool 或 Committing Change Set，必须阻塞 `CancelledSafe`。

## 10. 幂等键

```text
run:{runId}:cancel-intent:{intentId}
provider:{attemptId}:cancel-before-sent:{intentId}:{requestedEvidenceHash}
recovery:{operationId}:cancel-safe:{intentId}:{interruptionId}
agent-loop:{invocationId}:cancel-safe:{intentId}:{checkpointHash}
run:{runId}:cancel-safe:{intentId}:{manifestHash}
run:{runId}:cancel-reconciliation:{intentId}:{unknownEffectsHash}
```

最终 manifest hash 必须覆盖排序后的 Provider Attempt、ToolCall、AgentLoop、Recovery Operation 与 Change Set 证据。

## 11. Required Tests（必需测试）

- Intent 首次、重复、同 key 改 reason、不同 key 并发。
- Cancel 在 registration 前到达，新注册立即取消。
- Cancel 赢 Sent：0 Sent、0 HTTP、Attempt `CancelledBeforeSent`。
- Sent 赢 Cancel：恰好 1 Sent、至多 1 HTTP、最终真实终态或 OutcomeUnknown。
- RunCancel interruption 后重启不再驱动原 Requested Attempt。
- shutdown / EOF interruption 后重启仍可 ResumeAuthorized。
- 在 intent、interruption、Attempt terminal、Recovery outcome、Run terminal 之间逐点崩溃，均不得重发。
- Barrier 中目标 `run.cancel` 可达，普通命令仍有序排队。
- Run A cancel 不影响 Run B。
- Foreground 与 Recovery 使用同一竞态矩阵。
- 错 Intent 清理、有活动 registration 时清理均失败。
- 重启 hydrate 后 Requested Attempt 仍为 0 HTTP。
- Post-Sent unknown 不能生成 `CancelledSafe`。
- `run.reconcile CancelRun` 明确输出 `AbandonedAfterUnknown`。
- Workspace Lease 在 Attempt、Recovery、Run 终态完成前不可重新取得。
- Windows 子进程测试均有硬超时、隐藏窗口、kill + wait 和输出线程 join。

## 12. 验收边界

Slice A 完成后只能宣称“Provider-only durable cancel（仅模型路径的持久安全取消）”。Tool、Change Set、Artifact 或其他副作用尚未纳入统一 Evidence Collector 时，不能宣称通用 `run.cancel` 或整个 Harness 已安全闭环。
