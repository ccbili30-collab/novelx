# ADR-0015: Provider Effect Capability and Authorized Sent Boundary（模型副作用能力与授权发送边界）

Status: accepted live path; recovery dispatch integration incomplete
Date: 2026-07-13

## Context

`ProviderAttempt::Requested`（模型请求已持久化但尚未发送）is the last state from which NovelX can prove that no Provider network effect has crossed the durable boundary. A normal function call is not sufficient authority to send: the Runtime must prove that the active Run, Agent Loop（智能体循环）, Context（上下文）, Provider configuration, Attempt and retry lineage still describe one exact effect.

The proof must also survive restarts and concurrent workspace activity. In-memory booleans, caller-supplied hashes and Prompt instructions cannot authorize a billable external request. Conversely, a durable receipt must not become a reusable bearer token that can be copied, serialized or replayed after its lease or deadline expires.

## Decision

1. Agent Loop authorization evidence is produced only by journal replay. `AgentLoopProviderAuthorizationSnapshot`（智能体循环授权快照）has private fields and read-only accessors for Run, invocation, aggregate sequence, persisted checkpoint hash, pending inference, pending inference hash, retry binding and the event time that produced the current pending inference.
2. The snapshot records `PendingInferenceOrigin`（待推理来源）as one of `Created`, `InferenceStarted` or `InferenceRetried`. Origin is derived from the last validated event that produced the current pending inference; it is never inferred from request number or checkpoint contents.
3. Leaving `AwaitingProvider`（等待模型）clears pending-origin, pending-time and retry-lineage evidence. Event times used by the snapshot must parse as RFC 3339; malformed persisted times fail closed.
4. Existing Agent Loop checkpoint and retry-binding hash semantics remain unchanged. The new pending-inference hash uses an independent canonical JSON SHA-256 representation so an authorization can bind the exact pending identity without migrating older event identities.
5. Provider effect authority is represented by a move-only lifecycle:
   - `ProviderEffectCapability`（模型副作用能力）is validated but not consumed;
   - `ConsumedProviderEffect`（已消费能力）is ready for the durable send write;
   - `ArmedProviderEffect`（已武装副作用）proves the exact receipt crossed `provider.sent`;
   - `DispatchedProviderEffect`（已派发副作用）retains the live workspace lease through terminal persistence.
   These values are not cloneable or serializable. The durable receipt is evidence, not Provider-side idempotency.
6. A grant binds workspace/project, canonical database path, non-reusable lease epoch, Run/invocation/inference/Attempt identity, Attempt sequence and hashes, Context and transport hashes, Provider identity, deadlines, retry schedule and the selected authority source.
7. `EventJournal::append_at_global_sequence`（按全局序列追加）returns whether the event was inserted. Authorized `provider.sent` requires one atomic append that checks workspace-global, Run and Attempt aggregate sequences. An idempotent pre-existing send is returned as `inserted = false` and must not cross the network boundary again.
8. `ProviderAttempt` Sent event version 2 persists the exact `ProviderEffectGrantReceipt`（模型副作用授权回执）with the dispatch ID. Replay validates the receipt against the Attempt definition and evidence before reconstructing `Sent`.
9. `LiveAgentLoopRunner::ensure_awaiting_provider`（确保等待模型）is the pre-send Agent Loop gate. It creates or recovers one active loop, validates the Running Run, project, pinned Provider, persisted Context source, invocation, source scope, permission and dispatch identity, and is idempotent across restart.
10. The Live Issuer（实时签发器）reconstructs Context, Provider and transport payload from durable records and returns exact workspace-global, Run and Attempt CAS inputs. Initial, continuation and retry authority must respectively originate from `Created`, `InferenceStarted` and `InferenceRetried`.
11. The issuer revalidates Agent Loop project, source scope and permission against the Run pin. Current and initial Context records must contain a source command matching invocation, request number, Provider and Context policy.
12. Retry authority requires the real terminal parent `ProviderAttempt`: Failed state, retryable failure, Attempt identity, definition/evidence hashes, sequence and failure receipt must match the retry observation, schedule and Agent Loop binding.
13. Gateway Prebuild（网关预构建）uses the authoritative persisted Context and bound Provider to construct the exact POST URL, Authorization header, body and timeouts before the durable Sent boundary. The prebuilt request is move-only and does not expose credentials. Its effective deadline is the minimum of the persisted Attempt deadline, inference deadline and Provider configuration deadline.
14. Every live first request, plain-text result, tool continuation and Assist resume is driven by `LiveAgentLoopRunner`. The Runner establishes `Requested`, obtains live authorization, builds the exact HTTP request, checks cancellation, persists authorized Sent v2, consumes `ArmedProviderEffect`, holds the workspace lease through terminal persistence and then advances the Agent Loop.
15. Conservative workspace-global CAS contention is handled only by bounded re-authorization while the Attempt remains `Requested`. It never retries an Attempt after Sent.
16. Provider dispatch recovery is spawned as an isolated Runtime task before awaiting it. This keeps the deeply nested recovery/HTTP future off the command-loop polling stack while preserving the same exclusive lease and typed result.

## Consequences

- In paths that adopt this boundary, a caller cannot authorize Provider I/O by supplying an Attempt ID and hashes alone.
- A capability expires with its deadline and cannot outlive the workspace lease held by its move-only guard.
- Any evidence change after authorization invalidates the CAS inputs before `provider.sent` can be inserted.
- Continuation and retry authority can be distinguished from an initial Created event even if a checkpoint contains a misleading request number.
- The foundation is deliberately conservative. Workspace-global CAS can reject a legitimate request after unrelated workspace activity; callers will need a bounded re-authorization policy rather than bypassing the check.

## Explicitly Unfinished

- Recovery Service / Gateway sealing（恢复服务与网关封口）so operational recovery also consumes an authorized capability and no legacy send path remains.
- Removal of the compatibility-only `ProviderInferenceService::execute*` and `ProviderGateway::infer*` entries after recovery migration.
- Recovery Issuer（恢复签发器）for restarted Requested attempts and exact recovery authority variants.
- Host multi-round identity（宿主多轮身份）so continuation Run/invocation/Context/dispatch identity is carried without reconstruction gaps.
- Real third-party network tests and process kill tests（真实网络与进程终止测试）for authorize -> Sent v2 -> HTTP -> terminal persistence.
- Provider Retry V2 configuration（第二版重试配置）, including a versioned policy source for algorithm, base delay, delay cap and budget.
- Bounded retry behavior for conservative global-CAS conflicts and typed error projection to Host/UI.

## Rejected Alternatives

- A serializable capability token: it could be copied or replayed after the process loses its lease.
- Marking Sent after the HTTP request: a crash between network I/O and persistence would make an unsafe request look unsent.
- Inferring continuation from `request_number > 1`: a forged Created checkpoint can carry that number without an `InferenceStarted` event.
- Trusting a self-consistent retry ledger without its parent Attempt: it does not prove that the previous Provider call actually failed in the recorded way.
- Removing global CAS to improve throughput: availability work must use bounded re-authorization, not weaken the side-effect boundary.
