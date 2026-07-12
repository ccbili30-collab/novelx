# Runtime V2：类型化恢复动作与本地 Provider 结果投影

日期：2026-07-13

## 本批完成

- Operational Recovery（运行恢复）扫描结果新增类型化 `OperationalRecoveryAction`，不再把“Provider 已绑定”误判为可自动恢复。
- 只有严格匹配当前 Agent Loop（智能体循环）待处理推理的已持久化 Provider 响应，才进入 `RecoveryReady`。
- 需要新 Provider 请求、工具执行、上下文编译或推理启动的动作进入 `WaitingForExplicitExecution`，当前恢复执行器不会偷偷触发外部副作用。
- 多份或不匹配的持久化 Provider 证据进入 `Quarantined`（隔离），禁止猜测采用哪一份结果。
- Recovery Claim（恢复声明）的 executor version（执行器版本）、action hash（动作哈希）和 effect class（副作用等级）改由 Runtime 根据新鲜扫描结果派生，调用方不能自行填写。
- 新增 local-only projection executor（纯本地投影执行器）：
  - 再次核对 Run、Agent Loop、Provider Attempt（模型尝试）、Provider/Model、序号和响应哈希。
  - 只消费已落盘的 Provider 结果。
  - 可持久化工具参数 Artifact（产物）并推进 Agent Loop，但不会执行工具，也不会发起 Provider 网络请求。
  - 使用稳定命令键；若进程在 Agent Loop 转换后、恢复终态写入前崩溃，可对同一执行请求幂等重放并返回相同 manifest（清单）。

## 验证证据

- 聚焦恢复扫描、记录、声明测试通过。
- local-only Provider 结果投影覆盖首次执行与重复执行结果一致。
- Rust 全量测试与 Clippy 将在本批提交前再次执行，最终结果以提交记录为准。

## 明确未完成

- Supervisor（监督器）尚未把扫描、声明、开始、投影和完成串成自动闭环。
- Agent Loop 已推进但 Recovery Execution（恢复执行）尚未写入 `Succeeded` 终态，崩溃后的自动收口仍需 Supervisor 协调。
- Provider 外部请求恢复、Tool（工具）执行恢复、Outcome Unknown（结果未知）调和均未完成。
- 尚未开始 oh-my-pi 专项源码审计。
- 因此不能宣称完整运行恢复、完整 Harness（运行框架）或自动多 Agent 已完成。

## 当前最大风险

恢复操作与 Agent Loop 属于两个聚合。目前依靠稳定命令键解决本地投影的重复写入，但跨聚合的最终成功记录仍不是单一数据库事务。下一批必须让独占 Supervisor 识别“投影已提交但恢复终态未写”的状态，并以同一 fencing token（围栏令牌）安全收口。
