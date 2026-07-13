# Runtime V2 Owned Operational Recovery Pass（自持有运行恢复任务）

日期：2026-07-13

## 本批完成

- 将 `refresh_operational_recovery`（刷新运行恢复）中借用整个 `RuntimeCommandContext`
  （运行时命令上下文）的长异步流程拆为：
  - `prepare_operational_recovery_pass`：在主调度线程上生成只含 owned / `Arc`（自持有 / 原子引用计数）数据的任务规格。
  - `run_operational_recovery_pass`：在独立 Tokio task（异步任务）中执行本地投影、Provider dispatch（模型派发）、再次投影、扫描和记录。
  - 主线程等待结果后才替换 `operational_recovery_runs`（运行恢复任务表）。
- 任务规格固定数据库路径、Workspace / Project（工作区 / 项目）、Assignment recovery report
  （智能体分配恢复报告）、Provider registry / gateway（模型注册表 / 网关）、同一个
  `RuntimeCancellationHub`（运行时取消中心）以及 `Arc<WorkspaceRuntimeLease>`（工作区租约）。
- 保留原有 Provider bind（模型绑定）语义：恢复屏障完成后才返回 `provider.bound`，普通命令
  尚未并发穿透屏障。
- 独立 task 同时避免 Windows 测试进程在大型恢复 Future（异步状态机）上的栈溢出。

## 验证

- `handshake`（握手）：14/14 通过。
- `provider_dispatch_recovery_handshake`（模型派发恢复握手）：1/1 通过。
- `cargo clippy -p novelx-runtime --bin novelx-runtime -- -D warnings`：通过。

## 明确未完成

- 当前仍会立即等待 recovery task；主循环尚未在等待期间读取 shutdown / EOF（关闭 / 输入结束）。
- 尚未实现有界 Host command queue（宿主命令队列）、屏障期间命令分类或 queued command
  （排队命令）顺序执行。
- 本批只是下一步 `tokio::select!` 控制面的所有权地基，不是 Host cancellation（宿主取消）闭环。
