# Agent Loop Host Lifecycle v1（智能体循环宿主生命周期第一版）

Status: accepted design; not implemented

## Problem

The current Host protocol treats a complete Agent Loop as one Provider Attempt. That identity model
is valid only for a single request. Tool continuation, retry and Assist resume create new inference
and Attempt identities, so their terminal events cannot legitimately match the first Accepted
payload or the first command correlation ID.

The current design also uses an Attempt ID as the long-running Runtime task key and creates a random
placeholder Attempt ID for Assist resume. Neither value is the durable Agent Loop identity.

## Stable Identities

```text
AgentLoopRef = runId + invocationId
ProviderAttemptRef = runId + inferenceId + attemptId
ToolCallRef = runId + invocationId + internal toolCallId
```

`correlationId` is reserved for a command and its immediate response. Asynchronous lifecycle events
use `correlationId: null` and carry their explicit durable identity.

## Protocol Shape

The existing `provider.inference.start` command may remain during migration, but its response becomes
an Agent Loop acceptance:

```text
provider.inference.accepted
  lifecycleVersion
  agentLoop { runId, invocationId }
  initialAttempt
  aggregateSequence
  checkpointSha256
```

Every Provider round has its own lifecycle:

```text
provider.inference.started
provider.inference.completed
provider.inference.failed
provider.inference.reconciliation_required
```

Each event includes the Agent Loop reference, complete Provider Attempt identity, pinned Provider,
idempotency/evidence hashes, origin (`initial`, `continuation`, `retry`, or
`operational_recovery`) and the exact Agent Loop sequence/checkpoint that authorized it.

The Agent Loop has separate state events:

```text
agent.loop.snapshot
agent.loop.awaiting_approval
agent.loop.completed
agent.loop.failed
agent.loop.cancelled
```

Provider terminal events close only one Attempt. They do not close the Agent Loop.

## Runtime Task Identity

`RuntimeTaskKey` must become the Agent Loop reference rather than an Attempt ID. Duplicate active
keys are rejected instead of overwriting an existing cancellation sender. Run cancellation obtains
the current Attempt from durable Agent Loop / Provider Attempt state, never from the task key.

Assist resume reuses the same Agent Loop key and does not fabricate an Attempt ID.

## Host State

The TypeScript Supervisor maintains two maps:

```text
AgentLoopRef -> AgentLoop lifecycle state
AttemptId    -> Provider Attempt lifecycle state
```

An unknown Attempt terminal, duplicate terminal, mismatched identity or mixed legacy/new lifecycle
on one connection is a protocol error. A continuation Attempt is valid without matching the first
Attempt, but must match its own `provider.inference.started` identity.

## Startup Recovery

After `runtime.ready`, the Runtime projects read-only `agent.loop.snapshot` and
`provider.inference.snapshot` events from journal replay before operational recovery emits new
lifecycle events. Snapshot projection performs no Provider or Tool side effect.

## Capability Negotiation

The Host advertises:

```text
hostCapabilityVersions.agentLoopLifecycle = "1"
```

New Runtime + new Host use only lifecycle v1. A legacy Host may receive the old flat single-round
protocol for one release, but must fail before starting a multi-round Tool Agent. One connection
cannot mix both protocols.

## Required Precondition

`AgentLoopService` needs a durable, journal-safe Failed transition before `agent.loop.failed` can be
emitted. An in-memory error or task error string is not a legitimate Agent Loop terminal event.

## Acceptance

- Two Provider rounds emit two independent started/terminal pairs and one loop terminal.
- Assist approval resumes without an active command correlation or fake Attempt ID.
- Retry keeps inference identity, uses a new Attempt, increments attempt number and cites persisted lineage.
- Duplicate active Agent Loop task keys fail closed.
- Runtime and Host restart rebuild both state maps from snapshots without Provider or Tool execution.
- Run cancellation uses the persisted current Attempt and never a stale first-round identity.

## Explicitly Unfinished

No Rust DTO, Zod schema, Supervisor state table, Runtime event emission, task-key migration or startup
snapshot described here has been implemented yet.
