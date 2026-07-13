# Runtime V2 Durable Run Cancel（持久化任务取消）A1

日期：2026-07-13

状态：A1 aggregate / recovery foundation（A1 聚合与恢复基础）已通过当前 Rust 验证；没有接入生产 Host（宿主）命令路径。

## 本批完成

### 1. Run Aggregate（运行任务聚合）

- 在普通 `RunState`（任务生命周期）之外增加正交的 `RunCancellationState`（任务取消状态）：`None -> IntentRecorded -> CancelledSafe | ReconciliationRequired -> AbandonedAfterUnknown | WithdrawnForRetry`。
- 持久取消意图同时固定 `workspaceId`、`runId`、取消幂等键、原因及其 SHA-256、命令消息和请求时间。`intentId` 由固定 camelCase（小驼峰命名）结构的 Canonical JSON（规范 JSON）UTF-8 字节计算，不使用有歧义的字符串拼接。
- 未结算 Intent（意图）形成副作用屏障并冻结普通生命周期变更；`permits_new_side_effects` 只在没有 Legacy（旧版）屏障且取消状态为 `None` 或 `WithdrawnForRetry` 时放行。
- Intent、Safe / Reconciliation settlement（安全取消 / 对账结算）及 reconciliation（对账）采用历史稳定的语义幂等：同一历史语义在 CAS（比较并交换）竞争、传输重试、重启和后续取消周期后仍返回原结果；同键改义、同 Intent 改证据或同对账改决定均冲突，不追加第二份事件。
- `run.reconciled v2` 固定 `intentId`、`unknownEffectsSha256` 和 `cancellationDisposition`；`CancelRun` 映射为 `abandoned_after_unknown`，确认重复风险后重试映射为 `withdrawn_for_retry`。新式取消路径不能伪装成 v1 对账。
- Legacy `run.cancellation_requested v1` 仍可严格回放，但与新式 Intent 互斥；存在 Legacy 屏障时不能混写新式取消事件，必须先走原有对账路径。
- 单个 Run 最多保留 4,096 个取消周期，避免重放状态无限增长。A1 只接受处于 `Running`（运行中）或 `Retrying`（重试中）的新式取消；其他生命周期状态留给 A2 明确定义。

### 2. RuntimeCancellationHub（运行时取消中心）

- Run sticky cancellation（任务粘性取消）绑定规范的 64 位小写 SHA-256 Intent 身份；同 Run 同 Intent 幂等，不同未结算 Intent 互斥。
- `signal_run_cancel`、`hydrate_run_cancel` 和 `active_run_cancellation` 保留精确 Intent 与 signal sequence（信号序号），晚注册的 Recovery Task（恢复任务）会继承已存在的粘性取消。
- `abandon_before_sent` 在同一 Hub 锁内原子读取 Pre-Send Gate（发送前闸门）、核对 Run sticky Intent 并移除 registration / owner（注册与所有权），因此不会先丢注册再猜测取消身份。
- `clear_run_cancel` 校验 Hub 实例、Intent、signal sequence 且要求该 Run 的活动注册数为零；当前生产代码没有允许调用方凭字符串自行制造 settled capability（已结算能力）的入口。

### 3. Provider Attempt（模型调用尝试）

- 增加真实终态 `Requested -> CancelledBeforeSent` 和 Recovery 分类 `CancelledSafe`。
- `provider.cancelled_before_sent` 使用独立事件版本 v3，取消证据 schema（结构版本）同为 v3；v1 / v2 不能复用该语义，未知版本和 Sent（已发送）后伪造会严格失败。
- 持久收据绑定 `cancellationIntentId`、取消命令观察到的原始 Run sequence（任务序号）、Requested aggregate sequence（请求聚合序号）、definition hash（定义哈希）和 evidence hash（证据哈希）。幂等重入继续使用原始 Run CAS，而不是把当前序号误当成原始授权。
- Provider inference / scanner / recovery service（模型推理 / 扫描器 / 恢复服务）显式识别该终态；它不能再次进入 `SafeToSend`，也不能重新发起 HTTP。

### 4. Operational Recovery（运行恢复）

- 增加 `FinalizeCancelledSafe`（完成安全取消）恢复能力和一等 `OperationalRecoveryOutcome::CancelledSafe` 结果。
- Outcome 严格绑定原活动 operation / action / execution / claim / fencing（操作 / 动作 / 执行 / 认领 / 栅栏）、精确 RunCancel interruption（任务取消中断）、`cancellationIntentId`、Attempt 身份、Attempt sequence、definition hash 与 evidence hash。
- 孤立的 `CancelledBeforeSent` Attempt 仍由通用 Scanner 隔离，不能仅凭一个取消终态推断整个 Run 已安全关闭；只有原活动 Operation、精确 RunCancel interruption 和匹配的取消收据齐全时，Supervisor（监督器）才能结算 `CancelledSafe`。

### 5. Crash-reentry（崩溃重入）证据

- 集成测试先持久化 RunCancel interruption 和 `provider.cancelled_before_sent v3`，故意不写 Recovery outcome，再释放旧 Lease（租约）。
- 使用全新的 `RuntimeCancellationHub`、Supervisor 和 Lease 从同一 SQLite Journal（事件日志）重入，精确完成原活动 Operation 的 `CancelledSafe`，HTTP 请求数为 0，Attempt 没有重新驱动。
- 同一新 Supervisor 再执行一遍仍为 0 HTTP、Attempt 事件不增加、既有 outcome 与 revision（结果与修订）不变化。
- 这证明的是 reopened journal + fresh supervisor（重新打开日志与全新监督器）的恢复语义；A1 没有把它扩大描述为完整 OS 进程 kill-point（进程终止点）矩阵。

## 验收证据

以下命令在当前 A1 代码上退出码为 0：

```powershell
cargo test --workspace --features runtime-test-failpoints --no-fail-fast
cargo clippy --workspace --all-targets --features runtime-test-failpoints -- -D warnings
cargo fmt --all -- --check
git diff --check
```

关键定向结果包括：

- `provider_dispatch_recovery_supervisor`：10/10；包含 fresh supervisor crash-reentry（全新监督器崩溃重入）连续两轮 0 HTTP。
- `provider_attempt_recovery`：15/15；包含 v3 严格回放、版本拒绝、原始 Run CAS 和篡改拒绝。
- `operational_recovery_scanner`：11/11；孤立取消证据保持 Quarantined（隔离）。
- `provider_dispatch_recovery_service`：22/22；取消终态不重新分发。
- Rust workspace（Rust 工作区）全量测试、带 failpoints（故障注入点）的全 target Clippy `-D warnings` 与格式检查全部通过。

## 明确未完成

- 没有生产 `provider_attempt_cancellation_service`（模型尝试取消服务）；当前转换只能由聚合 API 和恢复测试驱动。
- 没有来自 Journal（事件日志）的权威 sealed intent proof（密封取消意图证明）；Hub 的 capability constructor（能力构造器）仍只存在于测试配置。
- 没有 `RunCancellationCoordinator`（任务取消协调器）和完整 Evidence Manifest（证据清单）。
- 没有接入 Host / `main.rs` 的 `run.cancel` 命令、响应和错误协议。
- 没有在启动恢复屏障前从 Journal 自动 hydrate（恢复）未结算 sticky Intent。
- Foreground Provider（前台模型调用）尚未与 Recovery 使用同一取消协调和发送闸门。
- ToolCall、Change Set、Artifact、Assignment、AgentLoop（工具调用、变更集、产物、智能体分配、智能体循环）尚未进入统一 Evidence Collector（证据收集器）。
- A1 对新式取消只覆盖 `Running` / `Retrying`；其他 Run 状态的命令语义、post-Sent（发送后）完整协调和用户对账入口仍未接线。

## 不能宣称

- 不能称为 Slice A（切片 A）已完成；Slice A 还要求生产服务、Coordinator、Host 接线和启动恢复。
- 不能称为通用 `run.cancel` 已完成或已可供桌面端使用。
- 不能称为 Provider-only durable cancel（仅模型路径的持久安全取消）闭环。
- 不能称为 NovelX Harness（NovelX 运行框架）已闭环。
