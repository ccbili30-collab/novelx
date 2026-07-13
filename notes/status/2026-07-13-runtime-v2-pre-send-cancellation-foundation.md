# Runtime V2 Pre-Send Cancellation Foundation（发送前取消地基）

日期：2026-07-13

## 本批完成

- 新增 `PreSendLinearizationGate`（发送前线性化闸门），唯一合法状态流为：
  - `Open -> CancelledBeforeSent`
  - `Open -> SentReserved -> SentCommitted`
- cancel（取消）与 Sent reservation（已发送预留）由同一个 `Mutex` 临界区裁决。
- Sent reservation 使用不可复制的 move-only token（移动语义令牌）；外部不能直接构造 Gate、Reservation 或状态回执。
- 未 commit/release 的 reservation 在 Drop（析构）时会 best-effort（尽力）安全释放，避免早退或 panic 把闸门永久卡在 `SentReserved`。
- Sent 获胜后，后续取消只触发 HTTP `watch::Receiver<bool>`，不会倒退为 pre-Sent（发送前）取消。
- 新增仅 crate 内可调用的 arm-failure release（装配失败释放）API：
  - 没有取消时回到 `Open`。
  - reservation 后已收到取消时转为 `CancelledBeforeSent`。
- 新增 `RuntimeCancellationHub`（运行时取消中心）：
  - 精确绑定 `workspaceId + runId + operationId + executionId + attemptId`。
  - Runtime shutdown（运行时关闭）和 Host disconnected / EOF（宿主断开）为全局 sticky signal（粘性信号），后注册任务立即取消。
  - Run cancel（任务取消）只命中精确 workspace + Run，并对该 Run 的后注册任务保持粘性。
  - 同一 Attempt 或同一 Recovery Execution（恢复执行）映射到不同完整身份时 fail-closed（失败关闭）。
  - 精确重复注册与重复注销幂等。
  - 注销只允许发生在 `CancelledBeforeSent` 或 `SentCommitted`，并保留身份墓碑和同一个 Gate，防止旧 Registration handle（注册句柄）与重新注册产生两个可发送闸门。

## 验证证据

- `runtime_cancellation_hub` 集成测试：7/7。
- `provider_pre_send_gate` 单元测试：3/3。
- 覆盖：
  - cancel-first（取消先赢）。
  - reservation-first（预留先赢）以及 post-Sent HTTP 信号。
  - 256 轮真实多线程 cancel-vs-reserve 竞态。
  - 并行 Run / workspace 隔离。
  - shutdown 与 EOF 后注册继承。
  - 注册、注销、Attempt alias（尝试别名）和 Execution alias（执行别名）冲突。
  - arm failure 有无并发取消的两种释放结果。
- `cargo clippy -p novelx-runtime --all-targets -- -D warnings` 通过。
- `cargo fmt --all -- --check` 通过。

## 明确未完成

- 本批没有接入 `main`、Host command pump（宿主命令泵）、Recovery Service（恢复服务）、Supervisor（监督器）或 Provider Gateway（模型网关）。
- 现有恢复路径仍使用本地永不触发的 cancellation channel（取消通道）；在 Migration step 2（迁移第二步）接线前，实机 shutdown / EOF / Run cancel 仍不能中断正在恢复的 Provider HTTP。
- 尚未持久化 `operational_recovery.execution_interrupted`，也没有 drain-before-stopped（停止前排空）语义。
- 这只是独立、经过竞态测试的地基，不能宣称 ADR-0016 已经闭环。
