# Runtime V2 Recovery Cancellation Step 2（恢复取消第二步）

日期：2026-07-13

## 本批完成

- `ProviderDispatchRecoveryService`（模型分发恢复服务）与 `ProviderDispatchRecoverySupervisor`（模型分发恢复监督器）显式接入同一个 runtime-scoped `RuntimeCancellationHub`（运行时取消中心）。恢复路径不再创建本地 `watch(false)` 后备通道。
- `main` 只创建一个运行时范围 Hub 并传给 Supervisor；本批没有把 shutdown、Host EOF / disconnect 或 `run.cancel` 信号接入 Hub。
- 每个 `Requested` 恢复任务以 workspace、Run、operation、execution、Provider Attempt 五元身份注册。Registration（注册句柄）带私有 generation ID（代次标识），旧句柄不能注销同身份的新一代注册。
- terminal unregister（终态注销）会同时删除 registration、Attempt owner index 和 Execution owner index，不保留 registration / owner tombstone（注册 / 所有者墓碑）。清理前的 exact re-register（完全相同身份重注册）返回 `RegistrationAlreadyActive`，不会向第二个调用者泄露当前 generation；清理后再次注册才会获得全新 generation。
- Provider 未绑定等 pre-dispatch error（发送前错误）通过 token-owned `abandon_before_sent`（令牌持有者发送前放弃）在线性化临界区内同时读取 `Open` / `CancelledBeforeSent` 和删除注册。若取消先发生，Service 返回真实 `InterruptedBeforeSent`；若放弃先发生，后到的全局取消只形成 sticky signal（粘性信号）。修复配置后可用同一持久 Attempt 重新注册并重试。
- sticky global / Run cancellation（粘性全局 / Run 取消）带进程内单调 sequence（序号）。晚注册同时命中两类信号时采用更早信号，统一 first-wins（最先发生者生效）。
- `RunCancel`（Run 取消）的 pre-Sent interruption（发送前中断）明确 `resumable = false`；Runtime shutdown 与 Host disconnect 仍为可恢复中断。

## durable Sent（持久已发送）边界

发送顺序固定为：

1. 获取恢复 Provider effect authorization（模型副作用授权）。
2. 获取 `SentReservation`（已发送预留）。
3. 由 `ProviderInferenceService::arm_authorized_recovery_dispatch` 独占执行 arm + reservation commit；其他模块不能直接 commit / release reservation。
4. 只有确认 `provider.sent v2` 已持久化后才 commit gate，并把同一个 Registration 的取消 receiver 交给 HTTP。

arm 返回错误时不能直接假设“未写入 Sent”。Helper（辅助器）在 exact Attempt execution guard（精确尝试执行守卫）仍存活时重新读取权威 Attempt，并核对授权时的完整 `ProviderAttemptDefinition`：

- 权威状态仍为 `Requested` 且 definition 未变化：确认未越过 Sent，可 release reservation；若并发取消已发生则转为 `InterruptedBeforeSent`，否则返回真实 pre-dispatch error。
- 权威状态为 `Sent` / `Responded` / `Failed` / `OutcomeUnknown` 且 definition 未变化：commit gate，禁止 HTTP，直接按权威证据完成 Recovery outcome（恢复结果）。`Sent` 会 fail-closed（故障关闭）为 `OutcomeUnknown`。
- 权威证据不可读、execution guard 不匹配或 definition 变化：gate 固化为 `DispatchBoundaryUnknown`（分发边界未知），不得 release / reopen，也不得伪装成发送前中断；随后用 token-owned cleanup 清理 Hub 注册并保留原始 fatal error（致命错误）。

## 当前验证证据

- `cargo check -p novelx-runtime --tests` 通过。
- `cargo clippy -p novelx-runtime --all-targets -- -D warnings`、`cargo fmt --all -- --check` 与 `cargo test --workspace --no-fail-fast` 全部通过。
- Runtime Cancellation Hub 定向测试：10/10 通过；另有库内 `DispatchBoundaryUnknown` 清理测试。
- 额外执行 256 轮 `abandon_before_sent` 与 global cancellation（全局取消）真实线程竞态：取消命中任务时 receipt 必须携带原因；放弃先发生时 signal 的命中数必须为 0。
- Recovery arm evidence（恢复装配证据）类型化决策测试：2/2 通过，证明只有 definition 匹配的 `Requested` 可以 release；Sent / terminal 必须按持久边界收口，definition 变化或证据不可读必须 fail-closed。
- Recovery Service 定向测试覆盖：
  - sticky shutdown：0 Sent、0 HTTP、无 Recovery outcome。
  - Run cancel 与并行 Run 隔离：目标 Run 发送前中断且不可恢复，另一个 Run 完成，合计 1 HTTP。
  - cancellation after Sent（Sent 后取消）：1 Sent、1 HTTP、`OutcomeUnknown`，不会伪装为 `FailedSafe`。
  - Provider 未绑定：0 HTTP、Attempt 保持 `Requested`、Hub 注册清零；绑定后重试成功且只发 1 次。
  - OriginalOwner（原所有者）、ResumeAuthorized（恢复授权）、Retry Attempt 2（第二次尝试）和终态零网络重入继续通过。
- Recovery Supervisor 定向测试：8/8 通过。

## 明确未完成

- shutdown、Host EOF / disconnect、`run.cancel` 尚未向 Hub 发信号，因此实机 Host 控制事件还不会触发本批取消能力。
- 尚未实现 `HostCommandPump`（宿主命令泵）、`OrderedDispatcher`（顺序调度器）、`operational_recovery.execution_interrupted` 审计事件和 shutdown signal -> drain -> `runtime.stopped` 完整顺序。
- 已实现对“arm 返回错误后权威读取发现 Sent”的处理，但尚无专门故障注入测试模拟 SQLite commit 已成功、调用者只收到 append error 的 commit-ack unknown（提交确认未知）窗口。现有 killpoint（故障点）覆盖“Sent 已持久化、HTTP 前崩溃”，不能等价证明 arm error 分类分支。
- 尚无故障注入测试覆盖：arm error 与取消同时发生时，权威状态分别为 Requested / Sent / evidence unreadable 的全部组合。代码已 fail-closed，但仍需可控注入证据。
- `run_cancellations`（Run 粘性取消表）尚未接入持久化业务取消生命周期，也尚无安全清除时机；本批 `main` 不会调用它，所以当前 live 路径不会增长该表。接入 `run.cancel` 前必须由 durable `CancelledSafe` / reconciliation（持久安全取消 / 对账）定义何时清除，不能把当前进程内 sticky map 宣称为完整业务取消实现。
- 本批只是 ADR-0016 的 Service / Supervisor 接线与提交前 P0/P1 收口，不能宣称完整取消控制面或整个 Harness 已闭环。
