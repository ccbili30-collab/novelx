# Runtime V2 Authorized Live Provider Chain（授权实时模型链）

Date: 2026-07-13

## Implemented

- `LiveAgentLoopRunner` now owns the workspace identity and an `Arc<WorkspaceRuntimeLease>`（共享工作区运行租约）that protects the exact database.
- First inference, plain-text completion, tool continuation, awaiting-Provider resume and Assist resume now share one Agent Loop path.
- `ProviderInferenceService::ensure_requested` creates or recovers only `provider.requested`; it does not mark Sent or perform HTTP.
- The live authorizer reconstructs Agent Loop, Attempt, Context, Provider and retry evidence from durable state.
- The complete HTTP request is built and validated before capability consumption.
- Pre-Sent cancellation performs no HTTP and does not cross Sent.
- Authorized Sent event version 2 persists the exact Grant Receipt（授权凭证）using workspace-global, Run and Attempt CAS.
- The Gateway requires `ArmedProviderEffect`（已武装模型副作用）for the new authorized HTTP kernel and returns a result that retains `DispatchedProviderEffect` through terminal persistence.
- Persisted Attempt, inference and Provider deadlines are intersected; authorization cannot silently extend a request deadline.
- Successful live plain-text execution now also persists an Agent Loop `Completed` transition.
- Unrelated workspace-global CAS contention is retried through at most three complete re-authorization passes while the Attempt remains Requested.
- Operational Provider recovery is awaited through a spawned Runtime task. This closed a real Windows main-thread stack overflow exposed by the full subprocess recovery test; it did not relax the recovery lease or audit evidence.

## Verification

- `cargo test --workspace --no-fail-fast`: passed.
- `cargo clippy -p novelx-runtime --all-targets -- -D warnings`: passed.
- Authorized Gateway unit tests: 5/5 passed, including zero-HTTP mismatch/cancellation/expiry and exactly one loopback HTTP request.
- Live Agent Loop tests: 9/9 passed, including two Provider rounds and Assist resume.
- Provider inference subprocess handshake: 4/4 passed.
- Provider dispatch recovery subprocess handshake: 1/1 passed after stack isolation.
- `npm run typecheck`: passed.
- Vitest: 85 files passed, 1 skipped; 406 tests passed, 10 skipped.
- `cargo fmt --all -- --check` and `git diff --check`: passed.

## Explicitly Unfinished

- Operational Recovery（运行恢复）still dispatches a Requested Attempt through the legacy v1 Sent and unarmed Gateway path. It must receive a dedicated `OperationalRecovery` capability issuer before the Gateway can be called sealed.
- Compatibility-only `ProviderInferenceService::execute*` and `ProviderGateway::infer*` entries still exist for recovery and old transport tests.
- Provider connection testing is a separate explicit network effect and does not yet have its own durable authorization/audit boundary.
- Host（宿主）protocol still treats the first Attempt identity as the whole multi-round Agent Loop identity; continuation and Assist terminal events need a dedicated Agent Loop protocol.
- Provider Retry V2（模型重试第二版）, automatic live retry scheduling, process-kill windows and real third-party Provider acceptance are not complete.
- The oh-my-pi audit, context compaction migration, long-term memory, graph retrieval, novel-domain mapping and Electron workbench remain later Goal stages.

## Completion Boundary

This batch closes the authorized live inference path. It does not close operational recovery, remove every legacy network entry, or complete the NovelX Harness.
