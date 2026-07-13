# Host Durable Cancel 与 Startup Hydrate 接线设计

日期：2026-07-13

状态：Proposed（提议中）

审计基线：`032336d`；行号用于定位当前实现，后续修改时以符号名和语义锚点为准。

依赖：Durable Run Cancel A1（持久化任务取消第一批）、ADR-0016、Provider Sent v2（模型发送边界第二版）、Operational Recovery（运行恢复）、Workspace Runtime Lease（工作区运行时租约）

## 1. 结论、范围与非目标

当前 Host（宿主）取消链不能直接接到 A1 后宣称闭环。现有代码仍然依据 RuntimeActor（运行时执行器）里有没有活动任务，在“直接写 `run.cancelled`”和“写旧式 `run.cancellation_requested`”之间二选一；启动时又在 RuntimeCancellationHub（运行时取消中心）创建前执行可能写日志的恢复。这两个事实共同破坏了“先持久化意图、再产生任何进程内信号”的权威顺序。

本提案只定义以下接线：

- Host `run.cancel` 的统一、异步接受语义；
- Operational Recovery Barrier（运行恢复屏障）中的可达取消控制面；
- RuntimeActor 与 RuntimeCancellationHub 的确认、收口和 Admission Seal（准入封印）；
- Shutdown（关闭）/ EOF（输入结束）/ 恢复任务之间的竞态；
- Controlled Invalidation（受控失效）；
- 启动时 Active Intent Hydrate（活动意图水合）和零网络收敛；
- Rust Protocol（Rust 协议）、TypeScript Supervisor（TypeScript 监督器）和 Windows 黑盒验收边界。

本提案不假定以下服务已经完成：

- `ProviderAttemptCancellationService`（模型尝试取消服务）；
- `RunCancellationCoordinator`（任务取消协调器）；
- Foreground Provider Owner（前台模型副作用所有者）与 Recovery Provider Owner（恢复模型副作用所有者）的统一；
- Tool（工具）、Change Set（变更集）、Artifact（产物）和 Assignment（智能体分配）的取消证据收集。

因此，即使本文全部接线完成，也只能在相应 Provider（模型服务）依赖和黑盒测试全部通过后称为 **Provider-only Durable Cancel（仅模型路径的持久化取消）**，不能称为通用 `run.cancel` 或完整 Harness（运行框架）闭环。

## 2. 当前真实调用图

### 2.1 正常 Host 命令

```text
stdin
  -> HostInputPump
       main.rs:395-574
  -> run_command_loop_inner
       main.rs:590-841
  -> operational_recovery_guard
       main.rs:661-664, 844-936
  -> command match
       run.cancel: main.rs:714-725
          -> RuntimeActor.active_run_tasks(run_id)
               runtime_actor.rs:365-375
          -> [无活动任务]
               handle_run_cancel
                 main.rs:2178-2188
               -> RunCommandService::cancel
                    run_command_service.rs:146-191
               -> 直接写 legacy run.cancelled
          -> [有活动任务]
               handle_active_inference_cancel
                 main.rs:2190-2222
               -> legacy run.cancellation_requested
               -> RuntimeActor.cancel_run(run_id)
                    runtime_actor.rs:358-363
```

这里有两个确定错误：

1. `active_run_tasks` 只是进程内观察，不是“没有副作用”的证据。恢复任务、尚未注册的 Attempt（尝试）、ToolCall（工具调用）或正在提交的 Change Set 都可能不在这个集合里。
2. `operational_recovery_guard` 在命令分派前执行。Assignment child Run（智能体分配子任务）只允许少量命令，`run.cancel` 会在到达取消分支前被拒绝；因此它也不是屏障内统一可达的控制面。

### 2.2 Provider bind 后的 Operational Recovery Barrier

```text
provider.bind
  -> run_operational_recovery_barrier_with_host_control
       main.rs:1282-1463
       -> spawn run_operational_recovery_pass
            main.rs:1291
            -> run_operational_recovery_pass_inner
                 main.rs:1806-1844
       -> select Host control / recovery completion
            main.rs:1298-1393
       -> ordinary commands enter bounded queue
       -> shutdown / EOF / fatal terminate barrier
            main.rs:1466-1537
```

当前 `run.cancel` 与普通命令一样排队。它不能立即让正在恢复的目标 Run（任务）停止申请新副作用；队列满时还可能返回 Runtime Busy（运行时忙）。这与取消作为控制面命令的语义相反。

当前恢复报告在 `apply_operational_recovery_report`（`main.rs:1748-1755`）中被直接清空并替换。恢复扫描期间只要写入取消意图导致 Global Event Clock（全局事件时钟）变化，两个 Supervisor（监督器）都只会得到笼统的 `SourceChangedDuringScan`：

- `operational_recovery_supervisor.rs:425-484`；
- `provider_dispatch_recovery_supervisor.rs:539-658`。

这会把合法的取消写入和真正的并发污染混为一谈。

### 2.3 当前启动顺序

```text
initialize_runtime
  main.rs:3366-3420
  -> acquire WorkspaceRuntimeLease
  -> open EventJournal
  -> RecoveryCoordinator::recover_and_reconcile
       main.rs:3375-3376
       recovery.rs:49-97
  -> Assignment structural recovery
  -> local operational recovery without bound providers
  -> scan / record report
  -> return initialized state

runtime.ready
  main.rs:225-248
  -> create ProviderRegistry / ProviderGateway / RuntimeCancellationHub
       main.rs:250-253
```

`recover_and_reconcile` 不是纯读恢复；它可能在 Hub 尚未建立、取消意图尚未 hydrate 时把 Provider OutcomeUnknown（模型结果未知）投影成新的 Run 状态。启动失败文案还声称“项目数据未被修改”（`main.rs:3481`），与可能发生的恢复写入不一致。

## 3. P0 阻断项

以下问题未解决前，禁止把 Host Durable Cancel（宿主持久化取消）接入 live（真实运行）路径：

| P0 | 当前证据 | 必须达到的结果 |
|---|---|---|
| P0-1 权威顺序错误 | `main.rs:714-725` 先查询活动任务再选择写法 | 所有 `run.cancel` 先写唯一 Durable Intent（持久化意图），成功后才 signal（发信号） |
| P0-2 新副作用未被 Journal 阻断 | `provider_effect_authorization_service.rs:168-197` 和 `provider_recovery_effect_authorization_service.rs:90-116` 只检查 Run 生命周期 | 两个 Authorizer（授权器）都在恢复 Run 后立即检查 `permits_new_side_effects()`，返回类型化 `RunCancellationPending` |
| P0-3 屏障内取消不可达 | `main.rs:661-664, 844-936, 1282-1463` | `run.cancel` 走独立控制通道，不受普通队列容量和普通 recovery guard 约束 |
| P0-4 启动顺序反转 | `main.rs:225-253, 3366-3420` | Hub 在任何可能写入或驱动 Provider 的恢复前建立并 hydrate |
| P0-5 收口存在晚注册竞态 | `runtime_cancellation_hub.rs:391-429` 只检查当前 registration 数为零 | 每个 Run 有 generation（世代）和 Admission Seal，封印后禁止新 owner 逃逸 |
| P0-6 Actor 信号没有确认 | `runtime_actor.rs:174-180, 358-363` 只投递 `CancelRun(Uuid)` | 信号绑定 exact intent proof（精确意图证明），有 ack（确认）和 `wait_run_idle` |
| P0-7 扫描失效被粗暴归类 | 两个 `SourceChangedDuringScan` 只有 before/after 序号 | 只把已证明的目标取消事件识别为受控失效，其他变化仍 fail closed（失败关闭） |
| P0-8 Requested Attempt 没有真实取消终态服务 | 当前 Recovery 路径能观察 Hub 取消，但不能据此假定已持久化 `provider.cancelled_before_sent` | Host 只接受意图；最终收敛必须等待真实 `ProviderAttemptCancellationService` 完成 |

特别注意：即便 P0-1 已让取消意图持久化，如果 P0-2 没完成，重新授权仍可能发送新的 Provider 请求。进程内 Hub 信号不能代替 Journal（事件日志）授权屏障。

## 4. 必须删除的旧 live 路径

### 4.1 精确删除点

1. 删除 `main.rs:714-725` 的活动任务二分支。
2. 删除 `main.rs:2178-2188` 的 `handle_run_cancel` live 调用入口。
3. 删除 `main.rs:2190-2222` 的 `handle_active_inference_cancel` live 调用入口。
4. 移除 `RunCommandService::cancel`（`run_command_service.rs:146-191`）作为 Host live API（宿主真实接口）的资格。
5. 禁止任何新命令继续写：
   - `run.cancelled v1` 的直接旧式终态；
   - `run.cancellation_requested v1` 的旧式待对账事件。

### 4.2 必须保留的部分

- 旧事件严格 replay（重放）和 migration（迁移）读取；
- 旧数据库的兼容阻塞状态；
- `active_run_tasks` 作为 UI/诊断观察值，但不得再参与取消安全判断；
- 旧错误的可审计映射，不能悄悄把 legacy（旧版）事件升级成新式 Intent Proof（意图证明）。

## 5. 新 Host 流程与 Async Accepted 语义

### 5.1 唯一写入顺序

```text
validate run.cancel
-> RunCancellationService.record_intent
-> recover sealed RunCancellationIntentProof
-> failpoint: intent_persisted_before_signal
-> RuntimeCancellationHub.signal_run_cancel(proof)
-> RuntimeActor.cancel_run(proof.actor_signal()) + ack
-> return accepted RunSnapshot
-> background RunCancellationCoordinator.drive(proof)
-> emit cancellation progress
-> settle or remain structurally blocked
```

关键不变量：

- Intent 写入失败：不得发送 Hub 或 Actor 信号。
- Intent 已写入后任何内存信号失败：不得回滚，也不得把命令报告成“取消不存在”；返回已持久化状态，后续由同进程重试或重启 hydrate 继续。
- 同一 `cancelIdempotencyKey` 和同一语义：恢复原 Proof（证明），并把新的 Host correlation（宿主关联）附加到同一 Saga（长事务）。
- 同一 key 改 reason（原因）或同一未结算 Run 出现第二 Intent：类型化冲突，不写第二条活动 Intent。

### 5.2 Accepted 不等于 Cancelled

TypeScript Supervisor 当前命令超时默认为 5 秒（`runtimeV2ProcessSupervisor.ts:206-212`）。等待 HTTP、owner drain（所有者收口）、证据扫描和最终结算后才回复，不但会超时，也把可恢复长事务错误地做成同步 RPC（远程过程调用）。

因此 `run.cancel` 的固定语义是：

- `run.snapshot` 在 Intent 已持久化，且 Host 已尝试安装 Hub/Actor 信号后立即返回；
- 返回时 `cancellation.state = intent_recorded` 是正常成功，不是临时错误；
- `accepted = true` 只表示“系统已持久接受并会恢复执行”，不表示 Run 已终止；
- 最终状态通过 `run.cancellation.updated` 事件和 `run.get` 获取；
- 若 Host 在持久化后、回复前崩溃，客户端以原 idempotency key（幂等键）重试，拿回同一个 `intentId`。

不新增一个长时间等待最终结算的默认接口。未来若需要等待，另设可取消的 subscription（订阅）或显式 `awaitCancellation`，不得占用普通 5 秒命令窗口。

## 6. Barrier 中的 PendingCancel 状态机

Operational Recovery Barrier 内不能把 `run.cancel` 放进普通命令队列。Pump 仍只负责解析和 Host sequence（宿主序号），但 Dispatcher（分派器）必须先把它分类为独立 `ValidatedHostCommand::RunCancel` 控制消息，再进入 recovery guard。

建议的进程内状态：

```text
Received
  -> IntentPersisted
  -> Signalled
  -> AwaitingOwnerDrain
  -> Converging
       -> Settled
       -> ReconciliationRequired
       -> EvidenceIncomplete
```

`PendingCancel` 至少保存：

```text
workspace_id
project_id
run_id
intent_id
sealed_intent_proof
intent_event_global_sequence
intent_event_sha256
host_message_ids[]
cancel_idempotency_key
hub_signal_receipt
actor_ack
phase
last_structured_error
```

屏障规则：

1. `run.cancel` 不占普通 backlog（积压队列）容量，也不能返回 Runtime Busy。
2. 同 Run 同 Intent 的所有 correlation 共用一个 `PendingCancel`；每个请求都必须得到自己的 accepted snapshot。
3. 不同 Run 的取消相互隔离，可并行持久化；最终项目写入仍由 Global CAS（全局比较并交换）串行化。
4. Recovery task 完成与 cancel 同 tick（同一调度时刻）时，先 drain control channel（清空控制通道），再决定是否应用报告。当前 biased select（偏置选择）可能先消费 recovery completion，必须修正。
5. 失效报告不能进入 `apply_operational_recovery_report` 的盲替换路径。
6. `EvidenceIncomplete` 不是 Run 生命周期终态；它表示 Intent 继续生效、Hub sticky（粘性取消）继续保留、目标 Run 禁止新副作用。

## 7. RuntimeActor 与 Hub 的收口契约

### 7.1 RuntimeActor

当前 `RuntimeActorCommand::CancelRun(Uuid)` 只有布尔 watch sender（观察发送器），没有意图身份、确认或目标空闲通知。目标接口应为：

```rust
cancel_run(RunCancellationActorSignal) -> ActorCancellationAck
wait_run_idle(workspace_id, run_id, intent_id) -> ActorRunDrainReceipt
cancel_all_for_shutdown(ShutdownSignal) -> ActorDrainReceipt
```

`ActorCancellationAck` 只证明 Actor mailbox（执行器邮箱）已经处理 exact intent（精确意图），不证明 Provider 已安全终结。`wait_run_idle` 只证明 Actor 管理的任务为空，也不单独构成安全结算证据。

### 7.2 Hub Proof-only API

生产接口只能接受 A2 Service（服务）恢复出的密封证明：

```rust
signal_run_cancel(&RunCancellationIntentProof)
hydrate_run_cancel(&RunCancellationIntentProof)
seal_run_admission(&RunCancellationIntentProof)
wait_run_registrations_drained(&RunCancellationAdmissionSeal)
authorize_settled(&RunCancellationSettlementProof)
clear_run_cancel(RunCancellationSettledCapability)
```

删除生产环境接收裸 `workspace_id / run_id / intent_id` 的信号和 hydrate 入口。测试构造器只能存在于 `#[cfg(test)]`。

### 7.3 Admission Seal

“当前 registration count（注册数）为零”不足以证明安全：读取零之后，旧授权 owner 仍可能晚注册。每个 Run 必须有单调 generation，并采用：

```text
Open(generation)
  -> Cancelling(generation, intent_id)
  -> Sealed(generation, intent_id)
  -> Settled(generation, settlement_hash)
```

规则：

- `Cancelling` 时，已注册 owner 收到 sticky cancel；晚注册 owner 继承相同取消并被计数，不能进入 Sent。
- Coordinator 准备最终证据扫描前原子进入 `Sealed`。
- `Sealed` 后的新注册返回类型化 `RunAdmissionSealed`，不得获得发送资格；调用方转入精确取消或只读恢复。
- 等待该 generation 的已有 registration 清零。
- 在 Journal 上重新扫描全部 A2 证据，并以 exact Global CAS 写最终 settlement（结算）。
- 只有匹配 generation、intent、settlement hash 且无 registration 的 capability（能力凭证）才能 clear sticky。
- 旧 generation 的 unregister、clear 或 ack 不得影响新 generation。

Hub seal、Actor idle 和 Journal final rescan 三者缺一不可。任何一个单独成立都不能证明所有 Provider effect owner 已静止。

## 8. Shutdown / EOF / Fatal 竞态

Runtime shutdown 和 Host EOF 不是业务取消，不能生成 `run.cancelled_safe`。但它们必须尊重已经持久化的业务 Intent。

| 到达顺序 | 固定行为 | 重启后行为 |
|---|---|---|
| cancel -> shutdown | 先持久化 Intent 并回复 accepted；再开始全局 drain | hydrate 同一 Intent，不重复创建 |
| shutdown -> cancel | Pump 已停止接受新命令，后到 cancel 不得伪装成功 | 客户端重连后用同 key 重发 |
| cancel -> EOF | Intent 必须保留；因 stdout 已断可不回复 | hydrate 同一 Intent 并零网络收敛 |
| EOF -> cancel bytes | EOF 后字节不存在，不接受命令 | 无新 Intent |
| cancel 与 recovery completion 同 tick | 先读取控制通道；若 Intent 已持久化，旧 report 失效 | 按取消证据恢复 |
| cancel 与 provider.sent CAS 竞争 | Global CAS 只允许一个胜者 | Intent 胜：0 HTTP；Sent 胜：真实终态或 OutcomeUnknown |
| cancel 已持久化，Hub signal 失败 | 返回 durable accepted + signal pending，不回滚 | hydrate 补装 sticky |
| shutdown drain 中仍有 Actor task | 全局 shutdown signal 让任务可中断，但只写可恢复 interruption | 下次恢复，不冒充业务取消 |

当前 `stop_runtime`（`main.rs:1727-1745`）只验证全局 recovery registration 数；RuntimeActor `BeginDrain`（`runtime_actor.rs:189-196, 377-393`）停止接收新任务但不取消既有任务。两者必须接入统一 shutdown drain，且 `runtime.stopped` 前满足：

- 所有已接受 Host correlation 已回复或持久化为可恢复操作；
- 已接受取消 Intent 不丢失；
- Actor、Hub 和 recovery owner 都有明确 drain 结果；
- 不能因为进程关闭而写业务 `CancelledSafe`。

## 9. Controlled Invalidation

### 9.1 当前问题

扫描只比较 before/after Global Event Clock，`EventJournal` 目前有 `append_at_global_sequence`（`event_journal.rs:145-158`）、`read_run`（`:270-282`）和 `read_aggregate`（`:284-303`），但缺少按全局序号范围读取事件的公开接口。因此代码无法证明变化究竟是不是目标 Run 的取消 Intent。

### 9.2 类型化结果

```rust
enum OperationalRecoveryPassOutcome {
    Completed {
        report: OperationalRecoveryReport,
        observed_global_sequence: u64,
    },
    InvalidatedByRunCancellation {
        workspace_id: String,
        run_id: String,
        intent_id: String,
        intent_event_global_sequence: u64,
        intent_event_sha256: String,
    },
}
```

识别过程：

1. 从 Journal 读取 `(before, after]` 的完整全局事件范围。
2. 恢复目标 Run 的 exact Intent Proof。
3. 只有变化集合完全属于已授权的同一取消 Saga，且至少包含匹配 hash 的 `run.cancellation_intent_recorded`，才返回 `InvalidatedByRunCancellation`。
4. 任意无关 Run 写入、未知事件、哈希不匹配或范围缺失，继续作为 Fatal/Quarantined（致命/隔离）或有界重新扫描；禁止按字符串猜测。
5. 丢弃旧 report，不能调用当前盲替换的 `apply_operational_recovery_report`。
6. 调用独立 `ZeroNetworkCancellationConvergence`（零网络取消收敛）；其类型构造函数不得接收 ProviderGateway 或可发送 Provider 请求的 capability。
7. 收敛完成后重新执行 cancellation-aware scan（取消感知扫描）。

`OperationalRecoveryGate`（`operational_recovery_scanner.rs:35-44, 291-349`）还必须新增 `PendingCancellation`。source fingerprint（来源指纹，`:703-786`）应显式覆盖 cancellation state、intent id 和事件 hash，避免同一 Run sequence 表象下遗漏取消语义。

## 10. Startup Hydrate 的固定顺序

启动必须先重建安全屏障，再做任何可能写状态或申请 Provider 副作用的恢复：

```text
1. acquire WorkspaceRuntimeLease
2. open and cryptographically verify all Journals
3. RecoveryCoordinator::recover (pure structural replay, zero writes)
4. Assignment structural recovery
5. RunCancellationService::scan_active_intents
6. create/hydrate RuntimeCancellationHub in deterministic run_id order
7. ZeroNetworkCancellationConvergence
8. cancellation-aware general recovery
9. cancellation-aware local Operational Recovery
10. final scan + persist truthful recovery report
11. construct all remaining fallible runtime dependencies
12. publish runtime.ready
```

细则：

- 只能 hydrate `IntentRecorded`。
- `ReconciliationRequired`、`CancelledSafe`、`AbandonedAfterUnknown` 和 `WithdrawnForRetry` 不安装 sticky。
- Legacy pending cancellation 进入兼容阻塞，不伪造新式 Proof。
- `IntentRecorded + Requested` 在没有 Provider bind 时也必须能完成零网络 Pre-Sent（发送前）收敛；在 Provider cancellation service 未实现前保持结构化 blocked，不得绕过。
- `IntentRecorded + Sent` 不得重发，只能采用已有真实 terminal（终态）或写 `OutcomeUnknown` 后进入对账。
- Tool/Committing 证据不完整时保持 sticky 与 `EvidenceIncomplete`；其他安全 Run 可以 ready。
- ProviderRegistry / Gateway 可以在 ready 前构造以暴露初始化错误，但启动零网络收敛不得获得发送能力，也不得要求 Provider bind。
- Provider bind 后、进入任何 dispatch recovery 前，再次 scan active intents 并确认 Hub 已 hydrate。

当前 TypeScript 握手只接受 hello 后立刻 ready（`runtimeV2ProcessSupervisor.ts:526-575`），startup timeout 仅 5 秒（`:206-212`）。新启动顺序可能合法超过 5 秒，因此应支持 `runtime.initializing` 进度消息和 inactivity timeout（无进度超时）+ hard cap（硬上限），而不是用无限等待。初始化失败文案必须说明“可能已写入可恢复的恢复事件”，不能继续声称数据未修改。

## 11. Protocol 与 TypeScript Supervisor 字段

### 11.1 RunSnapshot

Rust `RunSnapshot`（`novelx-protocol/src/lib.rs:1542-1552`）和 TypeScript schema（`runtimeV2Protocol.ts:400-447`）增加：

```text
cancellation:
  state:
    none | intent_recorded | cancelled_safe |
    reconciliation_required | abandoned_after_unknown |
    withdrawn_for_retry | legacy_pending
  intentId: string | null
  requestedAt: string | null
  accepted: boolean
  phase:
    none | intent_persisted | signalled | awaiting_owner_drain |
    converging | settled | reconciliation_required | evidence_incomplete
  hubSignalState: not_applicable | installed | pending_retry
  actorSignalState: not_applicable | acknowledged | pending_retry
  evidenceStatus: not_applicable | collecting | complete | unknown | incomplete
  evidenceScope: provider_only_v1 | null
  evidenceSha256: string | null
  blockers: CancellationBlocker[]
```

`EvidenceIncomplete` 是 `phase/evidenceStatus`，不是新的 Run lifecycle（生命周期）或 cancellation state（取消状态）。

### 11.2 Host 命令和事件

- Rust `RunCancel`（`novelx-protocol/src/lib.rs:1441-1444`）增加严格 `validate()`；字符串上限在 Rust 与 TypeScript 间统一为 UTF-8 字节，而不是一端按字符、一端按字节。
- `run.cancel` 仍以相关的 `run.snapshot` 作为同步 accepted 响应，保持现有 `cancelRun()` 调用形状（`runtimeV2ProcessSupervisor.ts:396-398`）。
- 新增异步 `run.cancellation.updated`，字段至少为 `runId / intentId / phase / snapshot / updatedAt / structuredError`。
- Supervisor 解析事件并更新 UI，不把 `intent_recorded` 当成失败，也不等待最终 terminal 才解除命令 timeout。
- 同 key 的多个 Host message id 各自收到 accepted response；异步事件按 `runId + intentId + monotonic revision` 去重。

### 11.3 Runtime lifecycle

`RuntimeReady`（Rust `novelx-protocol/src/lib.rs:144-148`）增加：

```text
recoveredRunCount
pendingCancellationCount
reconciliationRequiredCount
evidenceIncompleteCount
startupRecoveryRevision
```

`RuntimeStopped`（Rust `:162-164`）增加：

```text
reason
durablePendingCancellationCount
drainedActorTaskCount
drainedProviderOwnerCount
```

新增 `runtime.initializing`：

```text
phase
completedUnits
totalUnits | null
lastProgressAt
```

Supervisor 当前 post-ready parser（`runtimeV2ProcessSupervisor.ts:610-663`）没有 cancellation event，`runtime.stopped` 还要求零 active inference 和仅一个 pending command（`:723-730`）。接线时必须同步更新事件 union、active inference 清理和 shutdown invariant，不能只改 Rust。

## 12. Windows Killpoint 黑盒矩阵

优先扩展现有 `runtime/crates/novelx-runtime/tests/provider_recovery_killpoints.rs` 的 Windows child-process harness（Windows 子进程框架）；若职责过重，再建立 `runtime_process_durable_cancel.rs`。每项必须运行真实 Runtime 子进程和真实 SQLite Journal，不得用 fixture（样例数据）冒充黑盒。

| # | Killpoint / 场景 | 重启后必须证明 | 网络断言 | 依赖 |
|---|---|---|---|---|
| 1 | `run_cancel.intent_persisted_before_signal` | hydrate 同一 intent；不重复写 Intent | 0 HTTP | Intent Service + startup hydrate |
| 2 | `run_cancel.hub_signalled_before_actor_ack` | 晚注册 owner 继承取消 | 0 HTTP | proof-only Hub |
| 3 | Barrier 中 cancel 先于 recovery registration | 不返回 Busy；只产生一次 interruption | 0 HTTP | Barrier control path |
| 4 | cancel accepted 后 shutdown | accepted 响应先于 stopped；重启仍是同一 Intent | 0 HTTP（Pre-Sent） | async Host semantics |
| 5 | cancel 持久化后 EOF | 无响应也不丢意图 | 0 HTTP（Pre-Sent） | startup hydrate |
| 6 | recovery completion 与 cancel 同 tick | 旧 report 不被应用 | 0 或既有 1 次 | controlled invalidation |
| 7A | Intent CAS 赢 Sent CAS | Attempt = CancelledBeforeSent | 0 HTTP | Provider cancellation service |
| 7B | Sent CAS 赢 Intent CAS | 真实 terminal 或 OutcomeUnknown；绝不写 Pre-Sent cancel | <= 1 HTTP | Provider finalizer |
| 8 | Attempt cancel 已写、Recovery outcome 前 kill | 只补 outcome，不重复 Attempt terminal | 0 HTTP | Provider cancellation service |
| 9 | Run settlement 已写、Hub clear 前 kill | 不 hydrate 新周期，不重复 settlement | 0 HTTP | settlement proof |
| 10 | 同 key/reason 多次请求 | 一条 Intent；所有 correlation 均收到同 intent | 0 HTTP（Pre-Sent） | idempotency |
| 11 | 同 key 改 reason / 两个 Intent 并发 | 一个成功，一个明确 conflict | 0 HTTP（Pre-Sent） | exact Global CAS |
| 12 | Run A cancel / Run B dispatch | A 被阻断，B 正常且不继承 A sticky | B <= 1 HTTP | Hub isolation |
| 13 | 64 条普通 backlog + cancel + shutdown | cancel 不 Busy；shutdown 可达；顺序可审计 | 依状态 | Host control channels |
| 14 | startup: Intent + Requested | ready 前零网络收敛或结构化 evidence blocked | 0 HTTP | zero-network convergence |
| 15 | startup: Intent + Sent | 不重发；terminal/Unknown/对账 | 0 新 HTTP | post-Sent recovery |
| 16 | Tool 或 Committing blocker | 保持 IntentRecorded + EvidenceIncomplete | 0 新 Provider HTTP | evidence boundary |
| 17 | scan 中只写目标取消 / 同时写无关事件 | 前者受控失效；后者 fatal/quarantine | 0 重放 HTTP | global range reader |
| 18 | seal 前后 late registration | seal 前被计数并取消；seal 后被拒绝 | 0 HTTP | admission seal |
| 19 | Actor idle 但 Hub owner 活跃 | 不得结算 | 依 owner 真实状态 | combined drain |
| 20 | Hub count 零但旧授权 late owner | generation seal + final CAS 阻止逃逸 | 0 HTTP | admission seal + Authorizer |

所有 Windows 测试必须具备：

- `CREATE_NO_WINDOW` / 隐藏窗口；
- 每阶段 hard timeout；
- `kill + wait`，不是只 kill 不回收；
- stdout / stderr reader thread join；
- HTTP 计数器和请求 identity 断言；
- 测试结束确认无残留 Runtime 或 Electron 进程；
- 事件数量、顺序、hash、Run/Attempt/Recovery 状态的逐项断言。

## 13. 实现依赖顺序

不得并行假定下游能力存在。固定顺序如下：

1. **A2 Intent Service（意图服务）**：完成密封 Proof、exact event recovery、Global CAS、幂等和冲突；这是所有 Host 接线的唯一权威输入。
2. **Provider Authorization Barrier（模型授权屏障）**：两个 Authorizer 读取 Journal cancellation state 并 fail closed。没有这一步，Host 不得发送“取消已接受”到 live 客户端。
3. **Hub / Actor control contract（中心/执行器控制契约）**：proof-only signal、Actor ack、per-run drain、generation 和 Admission Seal。
4. **Host async accepted path（宿主异步接受路径）**：删除旧二分支；取消走独立 control path；持久化后回复 accepted，后台 Saga 可恢复。
5. **Controlled Invalidation（受控失效）**：增加全局事件范围读取、类型化 pass outcome 和 cancellation-aware gate；禁止盲应用旧报告。
6. **Provider Attempt Cancellation + owner unification（模型尝试取消与所有者统一）**：真正实现 Requested -> CancelledBeforeSent、Foreground/Recovery 统一 Gate 和 post-Sent finalizer。本文不假定它已经完成。
7. **Cancellation Coordinator + Evidence Manifest（取消协调器与证据清单）**：seal、drain、收敛、final rescan、settlement；Tool/Committing blocker 必须保守阻塞。
8. **Zero-network startup convergence（启动零网络收敛）**：独立无 Gateway capability 的服务；先 hydrate，再恢复。
9. **Rust / TypeScript Protocol（双端协议）**：snapshot、progress event、initializing、ready/stopped 计数和结构化错误同步上线。
10. **Windows killpoint matrix（Windows 强杀矩阵）**：从 intent 到 settlement 每个持久化边界逐点强杀、重启、验证零重复副作用。

如果第 6 或第 7 步未完成，前 1-5 步最多形成“Durable Cancel Accepted（持久接受取消）+ 新副作用关闭”的中间能力；它不能声称 Provider 已取消安全，更不能把 Run 写成 `CancelledSafe`。

## 14. 验收与禁止宣称

Host / Startup 接线只有在以下事实同时成立时才通过：

- 所有 live `run.cancel` 都先持久化 exact Intent，再 signal；
- 没有活动 Actor 任务时也不直接写 `run.cancelled`；
- Barrier 中取消不排普通队列、不返回 Busy；
- Journal cancellation state 能独立阻止 Foreground 和 Recovery 新授权；
- Hub generation + Admission Seal 消除“观察到零后晚注册”的窗口；
- shutdown / EOF 不冒充业务取消，已接受 Intent 可重启恢复；
- 只有被精确证明的目标取消写入可触发 Controlled Invalidation；
- runtime.ready 前完成 active intent scan、hydrate 和 zero-network convergence；
- Rust 和 TypeScript 都能表达 IntentRecorded、EvidenceIncomplete、CancelledSafe 和 ReconciliationRequired；
- Windows killpoint 矩阵全部通过且没有残留进程。

以下说法在相应后续工作完成前仍然禁止：

- “Provider cancellation service 已完成”；
- “所有副作用都能安全取消”；
- “通用 `run.cancel` 已闭环”；
- “启动恢复绝不会写事件”；
- “Actor idle 或 Hub count = 0 就证明可以安全结算”；
- “完整 NovelX Harness 已完成”。

## 15. 当前最大不确定性

最没有把握、也最容易被遗漏的是：**如何证明所有可能获得 Provider 发送资格的 owner 已经静止**。现有 Actor task 数和 Hub registration 数都只是局部观察。最终实现必须同时依赖 Journal Authorization Barrier、Hub Admission Seal、Actor/Hub drain、Attempt terminal、final Evidence Manifest 和 exact Global CAS；少任何一层，都可能在“已经安全取消”的表象下漏出一次真实模型请求。

第二个风险是把 startup hydrate 误做成“把字符串重新塞进 Hub”。真正的 hydrate 必须来自严格回放并验证的 Intent Proof，而且要发生在任何会写恢复事件或构造 Provider dispatch action 的逻辑之前。
