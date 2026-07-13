# Runtime V2 Host Control Plane（宿主控制面）Step 3

日期：2026-07-13

## 本批完成

- `main` 引入 `HostInputPump`（宿主输入泵）。输入读取、JSON 解析和 Host sequence（宿主序号）验证不再被 Operational Recovery Barrier（运行恢复屏障）同步阻塞。
- 所有已验证的普通命令、shutdown、EOF 和 Fatal（致命错误）进入同一个容量为 64 的有界 FIFO（先进先出）队列。输入 Pump 满载时采用背压，不会让后到 Fatal 越过更早命令。
- Operational Recovery backlog（运行恢复积压）最多保留 64 条。第 65 条及后续普通命令逐条返回关联的 `RUNTIME_BUSY`、`retryable=true`，不会发出全局取消；Pump 继续读取，因此后续 shutdown 仍然可达。
- `runtime.shutdown` 和 Host EOF / disconnect（宿主输入关闭 / 断连）在屏障期间可达；`run.cancel` 仍是普通有序命令，本批没有把它接入 `RuntimeCancellationHub`（运行时取消中心）。
- 所有可能执行 Provider Dispatch Recovery（模型分发恢复）的入口统一使用同一 control-aware barrier（可接收控制事件的屏障）：
  - `provider.bind`
  - `run.reconcile`
  - `tool.authorization.resolve`
- shutdown / EOF 只分别发送 `RuntimeShutdown` / `HostDisconnected`，不修改业务 Run（运行任务）状态。
- 屏障终止顺序固定为：
  1. 向 Hub 发出全局中断信号；
  2. 停止并 join（等待结束）输入 Pump；
  3. 始终 await（等待）Recovery JoinHandle，禁止 drop / abort 后让网络或写库任务脱离监管；
  4. 持久化 `execution_interrupted`、Provider Attempt（模型调用尝试）终态或 `OutcomeUnknown`（结果未知）；
  5. 验证 Hub registration count（注册数）为 0；
  6. 对已成功绑定的 Provider 先输出 `provider.bound`；
  7. 明确拒绝未执行的队列命令；
  8. Runtime Actor（运行时执行器）执行 BeginDrain / Drained / FinishStop，最后输出 `runtime.stopped`。
- Recovery fatal（恢复致命错误）、证据损坏、Hub 发信错误或 Pump join 错误不会输出 `provider.bound`，也不会伪造 `runtime.stopped`。
- Fatal 带明确来源：Host Protocol、Host Input Internal、Operational Recovery Internal、Routed Command（宿主协议、宿主输入内部、运行恢复内部、路由命令）。只有 Recovery 已安全收口的 Host Protocol Fatal 才允许提交更早的在途响应；内部 Recovery / Hub / Pump Fatal 会抑制 `provider.bound`。
- Host 协议 Fatal 会先等待在途 Recovery 收口，再按序拒绝已接收命令并输出 Protocol Error；Fatal 专用 Actor 终止路径会取消并回收永久任务，最终非零退出且不输出 `runtime.stopped`。
- Windows 下 Tokio 全局 stdin 的后台阻塞读可能阻碍 Runtime 析构。Fatal 只有在 Hub 信号、Pump 收口、队列拒绝、Actor terminate/join 都完成后才显式 `process::exit(1)`；Fatal 不承诺正常 stopped，OS 负责释放剩余进程句柄和 Workspace Lease。
- Recovery 完成与 shutdown / EOF 同时发生时，Dispatcher（调度器）在发布 Completed 前再次扫描已接受的 control 和 command FIFO，防止生命周期命令被普通命令穿透。
- RuntimeActor 拒绝重复活动 `RuntimeTaskKey`，不会再用新 cancellation sender（取消发送器）覆盖旧任务；任务终结后同一 Key 才能复用。
- TypeScript Protocol Schema（协议结构）可严格解析 disconnected stopped（断连停止）帧，但当前 Supervisor 没有“本端已关闭 stdin 后仍继续消费 stdout”的合法路径，因此任何未关联的 `host_disconnected` 帧都失败关闭。只有 Host 主动发送 shutdown 后收到严格关联的 `reason=requested`，且随后 `code=0`、无 signal，才算正常停止。

## 真实验收证据

- `cargo fmt --all` 通过。
- `cargo clippy -p novelx-runtime --all-targets -- -D warnings` 通过。
- `handshake`：15/15 通过，其中包含 pipelined（流水线式）`runtime.status.get -> runtime.shutdown` 的严格输出顺序。
- `provider_dispatch_recovery_handshake`：3/3 通过，其中两条真实 Runtime 子进程黑盒分别覆盖：
  - held HTTP（服务端接收请求后不返回）期间发送 shutdown；
  - held HTTP 期间关闭 stdin 形成 EOF。
- 两条 held HTTP 黑盒均证明：
  - 恰好 1 次真实 HTTP；
  - Attempt 最终为 `OutcomeUnknown`；
  - Operational Recovery outcome（运行恢复结果）为 `OutcomeUnknown`；
  - `provider.bound` 先于队列拒绝，队列拒绝先于 `runtime.stopped`；
  - 在途时第二个 Workspace Lease（工作区租约）无法取得；进程停止后租约可以重新取得；
  - Windows 子进程使用隐藏窗口、10 秒硬超时、kill + wait（终止并回收）和 stdout / stderr reader join（输出读取线程回收）。
- `provider_dispatch_recovery_service`：22/22 通过。
- `provider_dispatch_recovery_supervisor`：9/9 通过。
- `runtime_actor`：14/14 通过。
- `runtime_cancellation_hub`：10/10 通过。
- `provider_recovery_killpoints`：10/10 通过，其中新增两条确定性真实子进程黑盒：
  - Recovery registration（恢复注册）前收到 shutdown；
  - Recovery registration 前收到 EOF。
- 两条 pre-Sent 黑盒均证明：
  - `provider.sent = 0`；
  - HTTP 请求数为 0；
  - Attempt 保持 `Requested`；
  - `execution_interrupted` 已在 `provider.bound` / `runtime.stopped` 之前持久化；
  - `transportBoundaryCrossed=false`、`resumable=true`。
- backlog 黑盒证明 70 条状态命令中 64 条排队、6 条返回 `RUNTIME_BUSY`，随后 shutdown 仍可到达。
- Fatal 黑盒证明输出顺序为：`provider.bound` -> 更早命令拒绝 -> Protocol Error；进程非零退出且没有 `runtime.stopped`。
- Internal Recovery Fatal 黑盒证明：0 HTTP、无 `provider.bound`、无 `runtime.stopped`，并输出结构化 `RUNTIME_OPERATIONAL_RECOVERY_FAILED`。
- `provider_inference_handshake`：5/5 通过；held real Provider（真实保持连接的模型请求）与 routed Fatal 并存时，先输出 `run.rejected`，随后中止活动请求并非零退出，无 `runtime.stopped`。
- Rust workspace（Rust 工作区）全量测试、带 `runtime-test-failpoints` 的 Clippy `-D warnings` 与格式检查全部通过。
- TypeScript / Electron 全量 Vitest：411 passed、10 skipped；TypeScript 类型检查和生产构建通过。

## 明确未完成

- `RuntimeStopped` 协议仍只有 `reason`；ADR-0016 要求的 Host lifecycle v2（宿主生命周期第二版）`drainedCount`、`outcomeUnknownCount` 和 interruption cause（中断原因）尚未加入协议与桌面端。
- `run.cancel` 尚未实现 durable CancelledSafe（持久化安全取消）或 post-Sent reconciliation（发送后对账），因此本批明确不把它接到 Recovery Hub。
- 本批只保证 Operational Recovery 的 shutdown / EOF 排空。普通前台 Provider inference（模型调用）仍服从现有 Runtime Actor 任务生命周期，尚未统一为新的 Host control cancellation（宿主控制取消）协议。
- 全量测试已通过，但 SQLite commit-ack unknown（提交确认未知）、前台 Provider 长时间挂起、多个并发 Run 和完整崩溃窗口组合仍未形成独立压力矩阵；全量单元/集成测试不等于完整故障注入验收。
- `main.rs` 的 Host Pump / Dispatcher 代码仍然偏大；在协议稳定后应拆成独立模块，降低后续维护成本。

## 不能宣称

- 不能宣称 ADR-0016 已完整关闭。
- 不能宣称 Host lifecycle v2 已完成。
- 不能宣称 `run.cancel` 已安全接入运行恢复。
- 不能宣称整个 NovelX Harness 已完成。
