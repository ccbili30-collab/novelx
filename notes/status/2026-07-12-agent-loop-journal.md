# AgentLoop Journal 状态

## 已实现

- `AgentLoopService::checkpoint()` 以完整、带 SHA-256 校验的版本 1 事件写入 `EventJournal`。
- 聚合地址固定为 `run_id + invocation_id`，事件序列和前后阶段在 replay 时严格校验。
- command key 支持同语义幂等重试，不同语义由日志层拒绝。
- 可按 Run 查找唯一 active loop；同 Run 多个 active loop 时 fail closed。
- 可按内部 `tool_call_id` 查找待处理工具请求。
- Assist（协助模式）可在进程重启后恢复 checkpoint、完成审批并继续写入下一阶段。
- checkpoint 恢复拒绝重复的内部 `tool_call_id`。

## 验证

- `cargo test -p novelx-runtime --test agent_loop_journal`：2 tests passed。
- `cargo clippy -p novelx-runtime --lib -- -D warnings`：通过。

## 未完成

- 尚未接入 `main.rs`、Runtime actor（运行时执行器）或 Supervisor（监督器）的 live routing（实时路由）。
- 尚未补齐直接篡改 SQLite 事件的 sequence gap、unknown version、hash tamper、地址错配等黑盒破坏性测试。
- `acknowledge_inference_started()` 返回 `()`，当前仓库 API 尚无对应 directive，因此该阶段变更还没有专用 append 方法。
- 当前成果是持久化仓库闭环，不是完整 Agent 运行闭环，不能标记为可体验 live 能力。
