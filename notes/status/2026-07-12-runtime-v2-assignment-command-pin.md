# Runtime V2 Assignment Command and Child Run Pin（第二版运行时分配命令与子运行固定引用）

## Implemented

- Added strict protocol DTOs for `agent.assignment.create/get/start/request_cancel/confirm_cancelled/complete/fail`.
- Routed all seven commands through the real Rust Runtime process and TypeScript Supervisor（进程监督器）.
- Added `agent.assignment.snapshot` and typed `agent.assignment.rejected` responses.
- Added the advertised `agent_assignments_v1` Runtime capability.
- Assignment creation verifies exact Goal（目标）and Plan（计划）revision/hash, usable Plan step, assigned child profile, capabilities, expected artifact, resource scope, source checkpoint, active parent Run and real parent AgentLoop invocation before writing.
- Completed/blocked Plan steps and terminal/non-delegatable parent Runs are rejected before Assignment persistence.
- Completion, cancellation confirmation and failure require matching terminal child Run state; an allocated Assignment may be cancelled before a child Run exists.
- Terminal Assignment commands also re-check the child Run's exact Assignment revision/hash, Goal, Plan, parent Run, scope, profile and source checkpoint, preventing an unrelated Run with a reused ID from supplying fake completion.
- Extended new Run pinned identity with optional Assignment revision/hash, parent Run ID and delegation depth.
- Child Runs require exact Goal, Plan and Assignment pins, exact child Run binding, parent Run, scope, profile and source checkpoint. Delegation depth is fixed to `1`; recursive child allocation is rejected.
- Legacy Run events without the new delegation fields remain readable through Serde defaults. New `run.start` commands must provide the complete delegation contract.

## Verification

- Assignment aggregate: 11/11.
- Assignment command service: 4/4.
- Run pin validator: 4/4.
- Run recovery: 9/9.
- Rust protocol: 14/14.
- TypeScript full suite: 404 passed, 10 skipped.
- TypeScript protocol, Supervisor and real-process targeted suite: 88/88.
- Real cross-process ToolCall matrix: 10/10.
- Clippy strict checks passed.
- Real Rust child-process test proves `agent_assignments_v1`, typed rejection for a missing parent Run, zero Assignment write and continued Runtime availability.

## Not Complete

- The Runtime does not automatically preallocate and start a child Run from an Assignment.
- No durable concurrency, token, cost or time reservation ledger exists.
- Startup recovery does not yet reconcile `allocated/running/cancel_requested` Assignment state with child Run and AgentLoop state.
- A real Provider two-child black-box test has not passed.
- Assignment result acceptance, Validator review, Plan step evidence advancement and serialized Change Set commit are not connected.
- No desktop Assignment activity projection exists.
- Missing Provider dispatch behavior has not yet been tested through an automatic Assignment coordinator; fake child output remains prohibited.

This batch completes the strict command and identity boundary. It does not complete automatic Agent allocation.
