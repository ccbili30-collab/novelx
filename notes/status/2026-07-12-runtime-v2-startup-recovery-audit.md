# Runtime V2 Startup Recovery（启动恢复）审计状态

日期：2026-07-12

## 本次完成

- 形成正式设计文档：`docs/runtime-v2/startup-recovery-state-machine.md`。
- 逐一覆盖 `AwaitingProvider`、`AwaitingApproval`、`AwaitingToolResults`、`AwaitingContextCompilation`、`AwaitingInferenceStart`。
- 区分自动恢复、等待 Host（宿主）和 `Outcome Unknown（结果未知）`。
- 明确 Provider `Requested/Sent/OutcomeUnknown/Responded/Failed` 的恢复动作。
- 明确 Tool `Authorized/Running/Completed/Failed` 与 lease、completion/failure manifest 的恢复动作。
- 给出 21 项最小测试矩阵，包含 aggregate replay（聚合重放）、故障注入和真实 kill/restart（终止/重启）层级。

## 已确认的关键缺口

1. `main.rs` 初始化只调用 Run/Provider RecoveryCoordinator，没有启动级 AgentLoop phase 调度。
2. LiveAgentLoopRunner 的常规恢复只接受 `AwaitingProvider`，Assist 恢复只接受 `AwaitingApproval`。
3. `AwaitingToolResults`、`AwaitingContextCompilation`、`AwaitingInferenceStart` 没有统一启动恢复入口。
4. 本批开始时，AgentLoop 曾在持久化 `AwaitingInferenceStart -> AwaitingProvider` 后才随机生成 `inference_id` 与 `attempt_id`；该窗口现已关闭。
5. AgentLoop checkpoint 现已保存当前 inference/attempt identity，并严格校验 Provider completion；启动级扫描与调度仍未实现。
6. Run 的 `Resumable（可恢复）` 分类只是报告，不代表后台工作已经被重新调度。

## 要求新增的持久契约

- 不可变 `InferenceDispatchIntent（推理派发意图）`。
- 派发前持久化的 `inference_id`、`attempt_id`、request number、context compilation identity 和 payload hashes。
- Context Compilation 的 intent hash、业务幂等键和结果 compilation identity。
- 写工具未来需要副作用类别、执行前版本、Change Set identity 和可用的外部幂等键。

## 审计后的实现进展

- 新增持久 `InferenceDispatchIdentity`，在下一次 Provider 派发前与 AgentLoop checkpoint 同步提交。
- 新增 `resume_awaiting_provider`，只能复用原 inference/attempt/idempotency/context identity。
- 服务级中断测试通过：第二轮派发前中断后恢复，HTTP 请求总数没有增加。

## 仍未完成

- 未实现启动恢复调度器。
- 未运行真实子进程 kill/restart 验收。
- 未解决 `Committing（提交中）` 的 commit manifest/checkpoint 对账。

因此恢复设计、派发身份持久化和 `AwaitingProvider` 服务级恢复已经完成，但不是 Runtime 启动恢复功能闭环。当前 live 路径仍可能在其他 AgentLoop phase 重启后停住；Provider Sent unknown 与 Tool Running unknown 必须继续 fail-closed（失败关闭），不能为了“自动恢复”而重派。
