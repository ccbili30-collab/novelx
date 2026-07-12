# ADR-0009: Runtime Tool Call Protocol And Permission Leases

Status: Accepted for protocol implementation; execution not wired

## Context

Runtime V2 already has an event-backed ToolCall Aggregate with requested, authorization, running and terminal states. It records tool name, schema version, argument hash, attempt, side-effect class and parallel policy. The public protocol still needs artifact identities, source scope and auditable Free / Assist permission decisions without allowing the model or UI to self-authorize execution.

## Decision

The host submits `tool.request` with a Run-scoped UUID, invocation identity, immutable argument artifact receipt, sorted source resource scope and pinned permission policy. Assist mode projects `approval_required`; Free mode may project `allowed` only under the pinned policy. Assist approval or denial uses `tool.authorization.resolve`. The Runtime creates the permission lease; callers cannot submit their own lease.

Public lifecycle events are `tool.requested`, `tool.authorized`, `tool.running`, `tool.succeeded`, `tool.failed` and `tool.outcome_unknown`. Internal aggregate `tool.started` maps to public `tool.running`; internal `tool.completed` maps to `tool.succeeded`. This changes projection vocabulary, not aggregate state semantics.

Every event repeats immutable ToolCall identity plus argument and source-scope SHA-256 hashes. Authorized/running events carry the full lease. Success carries a result artifact receipt. Known failure carries a structured Runtime error. Unknown outcome requires an allowed lease, is non-retryable and cannot carry a success artifact.

## Invariants

- Argument and result bodies are stored outside the envelope; the protocol carries stable artifact ID, media type, byte length and lowercase SHA-256.
- Source resource IDs are sorted and unique and are bound to a checkpoint and scope hash.
- A lease binds tool call, mode, policy version/hash and source scope. It cannot authorize a different call or broader scope.
- Assist mode cannot enter running without an approved lease. Free mode is policy-authorized, not model-authorized.
- External-effect unknown outcomes cannot auto-retry.
- Exactly one terminal public event is allowed.

## Consequences

The schemas and event vocabulary can be consumed by future Runtime dispatch, Supervisor and UI projections. This ADR does not add a tool executor, filesystem access, approval UI, lease persistence service or public event mapper. Those remain required before the feature is live.
