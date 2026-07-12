# 2026-07-12 Runtime V2 Agent loop orchestration

Implemented an independent deterministic `AgentLoopService`（智能体循环服务）. It is not wired into `main.rs` and does not execute tools itself.

## Implemented

- Accepts a finalized `ProviderInferenceCompleted`（模型推理完成） payload, exact Run identity, expected Context Compilation identity and materialized Provider tool calls.
- Rejects mismatched Run, request number, Context identity, Provider tool-call ID, tool name, arguments hash or duplicated calls before scheduling work.
- Produces one deterministic directive at a time:
  - `AwaitApproval`（等待审批） for Assist mode;
  - `ExecuteTools`（执行工具批次） for Free mode or after Assist decisions;
  - `CompileContext`（编译下一上下文） after all terminal tool results arrive;
  - `StartInference`（开始下一次推理） after the compiled context identity is supplied;
  - `Completed`（完成） when a Provider turn contains final text and no tool calls;
  - `Cancelled`（取消） from any nonterminal phase.
- Multiple tool calls from one Provider inference remain one batch and share the inference ID as `assistantMessageId`（助手消息标识）.
- Assist decisions must exactly cover the pending Provider call IDs. Approved calls enter the execution list; denied calls remain explicit and still require terminal error results before continuation.
- Tool result sets must exactly cover every Provider call. Success and failure results are both converted into hash-verified RuntimeExchange call/result pairs in stable Provider order.
- Tool requests use the persisted original `providerToolCallId`, materialized internal ToolCall UUID, argument artifact receipt, pinned source scope and pinned permission policy. The service never substitutes one identity for another.
- A maximum tool-round policy fails closed before another batch is scheduled.
- Checkpoints serialize the full orchestration state. Restore validates phase/pending-state consistency, limits and Assist-only approval waits before allowing resume.
- The state machine requires an explicit inference-start acknowledgement before accepting another Provider outcome. The model cannot advance or skip Harness phases by returning text.

## Verification

- `cargo test --manifest-path runtime\Cargo.toml -p novelx-runtime --test agent_loop_service`
- 5 tests passed: no-tool terminal completion, Free multi-tool batching, successful and failed tool results, Assist pause/checkpoint/restore/mixed decisions, maximum rounds and cancellation.
- `cargo clippy --manifest-path runtime\Cargo.toml -p novelx-runtime --lib --test agent_loop_service -- -D warnings`
- Clippy passed with warnings denied.
- `cargo test --manifest-path runtime\Cargo.toml -p novelx-runtime`
- Full Runtime crate verification passed: 171 tests, 0 failures.

## Not completed

- Runtime Actor and `main.rs` do not instantiate this service or persist checkpoints into the Event Journal.
- The service outputs `ToolRequest` batches but does not call `ToolCoordinationService` or `ProjectToolExecutionService` directly.
- The host still needs an adapter that turns approval decisions, Tool Coordination terminal artifacts and Context Compilation receipts into these state-machine inputs.
- No automatic Provider request is issued by this module. `StartInference` is an intent that the Runtime Actor must persist and acknowledge.
- Cancellation currently terminates the orchestration state but does not yet signal already running OS-level tool tasks; that remains the execution layer's responsibility.
- This module is not a live Agent loop until the Event Journal and Runtime Actor wiring are complete and restart-tested.
