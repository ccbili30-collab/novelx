# LiveAgentLoopRunner 状态

## 已实现

- 独立 `LiveAgentLoopRunner` 已接入 `main.rs` 的真实 Provider ToolCall 路径。
- 支持真实 Provider 推理、AgentLoop checkpoint journal、Free 工具执行、Continuation Context 和下一轮 Provider 推理。
- Assist 会先持久化工具 request / approval-required，再返回 awaiting approval。
- ProviderRegistry 与 ProviderGateway 可 Clone。
- progress callback 为逐事件 await 的异步回调，携带 Provider completion、ToolRequest、工具 outcome、Context receipt 和下一轮 inference intent。
- 终态携带完整 `ProviderInferenceCompleted`，供 Runtime task 返回正式终态 payload。
- Host cancellation 会持久化 AgentLoop cancelled checkpoint。
- `resume_after_assist` 从 journal 恢复 AwaitingApproval loop，并逐项恢复 ToolCoordination snapshot。
- 未全部批准或拒绝时保持 AwaitingApproval，不提前推进上下文。
- 全部决议后执行 `resolve_assist -> accept_tool_results -> ContinuationContext -> inference started`，随后复用同一 `run` 驱动循环继续真实 Provider 推理。

## 验证

- 真实本地 HTTP loopback 两轮通过。
- 第一轮真实执行 `read_project_file` 与 `stat_project_file`，读取中文 `世界.md`。
- 第二次 Provider 请求包含原 Provider tool call ID、中文文件内容和工具结果。
- progress 顺序与 Provider request number `[1, 2]` 已断言。
- Assist 测试覆盖先批准一项仍等待、再批准第二项后真实完成第二轮文本。
- 跨进程 Assist 批准与拒绝均通过；拒绝会向 Provider 返回严格配对的 `TOOL_DENIED`，不会执行工具或产生成功事件。

## 未完成

- 尚未实现进程启动时对所有 active AgentLoop 阶段的统一自动恢复扫描。
- 尚未接入写工具和 Change Set。
- Goal、Plan、多 Agent、长期记忆和桌面 UI 仍未接回 Runtime V2。
