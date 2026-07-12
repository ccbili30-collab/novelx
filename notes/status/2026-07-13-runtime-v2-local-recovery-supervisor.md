# Runtime V2：Local-only Recovery Supervisor 接线

日期：2026-07-13

## 本批完成

- 新增 `OperationalRecoverySupervisor`（运行恢复监督器），按以下顺序驱动每个 Run（运行）：
  1. 一致性扫描并记录。
  2. 优先处理旧的未完成 Execution（执行）。
  3. 再处理已领取但未启动的 Claim（声明）。
  4. 没有活动操作时，才领取当前 `RecoveryReady` 操作。
  5. 串联 claim → start → local projection → finish。
- 已开始的本地投影在重启后使用原 execution ID、原 fencing token（围栏令牌）和持久化 action spec（动作规格）续接；不会重新 Claim，也不会标记 stale（过期）。
- 未启动的旧 Claim 在 owner 不同且租约未过期时等待；过期后只能通过正式 transfer（转移）使 token 加一。
- 同一 Run 只允许一个未终结恢复操作拥有 Claim/Execution，Repository（仓库）和事件回放同时执行该硬约束。
- Supervisor 只执行 `PersistedProviderResultProjection`（已持久化模型结果投影）。`ProviderDispatchRequired` 等动作进入等待状态，不发模型请求；工具调用只落盘参数产物，不执行工具。
- Supervisor 已接入真实 Rust Runtime（Rust 运行时）：
  - `runtime.initialize` 在 `runtime.ready` 前执行 local-only 恢复。
  - `provider.bind` 和其他恢复刷新点执行 local-only 恢复后重新扫描 UI guard（界面守卫）。
- Supervisor 全程依赖当前数据库的独占 WorkspaceRuntimeLease（工作区运行租约）。

## 验证

- 新鲜 persisted Provider 结果可由 Supervisor 自动完成。
- 重复运行 Supervisor 不增加 Provider Attempt（模型尝试）事件。
- `ProviderDispatchRequired` 被明确等待，Provider Attempt 数保持为 0。
- ExecutionStarted 后、投影前崩溃：新 Runtime 显式授权续接并完成。
- 投影已提交、finish 前崩溃：新 Runtime 重建相同 manifest（清单）并完成。
- 同一 Run 的第二个并发恢复 Claim 被 Repository 拒绝。
- 真实 handshake（握手）测试通过。
- Rust workspace 全量测试通过；Clippy `-D warnings` 通过。

## 明确未完成

- Provider Dispatch（模型请求分发）的发送中断、响应未知和收费去重尚未实现。
- Tool Dispatch（工具分发）的外部副作用、部分完成和结果清单恢复尚未实现。
- Supervisor 目前作为同步 local-only pass（纯本地恢复轮次）运行，尚无后台租约续期与长任务调度循环。
- 尚未完成真实进程 kill（强制结束）、断电和并发压力矩阵的全部案例。
- Assignment child Run（子运行）的真实 Provider 执行和 Artifact（产物）验收仍未接回。
- oh-my-pi 专项审计尚未开始。

因此可以宣称“已完成并接入纯本地 Provider 结果恢复监督链”，不能宣称完整 Operational Recovery、完整多 Agent 或完整 Harness 已完成。
