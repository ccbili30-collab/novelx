# NovelX Runtime Protocol V1

Status: proposed foundation contract  
Transport: newline-delimited JSON over child-process stdio  
Encoding: UTF-8 without BOM  
Direction: Electron host commands to Rust runtime; Rust runtime events to Electron host

## 1. Purpose

Protocol V1 separates the NovelX desktop host from the authoritative Agent runtime. It carries commands, durable events, request responses, cancellation, approvals, recovery state and public projections. It does not expose Provider credentials, hidden Prompt content, raw GM resolutions or unrestricted filesystem access to the Renderer.

The protocol is transport-independent. A future Windows named-pipe transport must preserve these message semantics and ordering rules.

## 2. Envelope

Every message uses the same outer envelope:

```json
{
  "protocolVersion": 1,
  "messageId": "uuid",
  "messageType": "command | event | response | control",
  "name": "run.start",
  "sentAt": "2026-07-12T00:00:00.000Z",
  "correlationId": "uuid-or-null",
  "runId": "uuid-or-null",
  "sequence": 42,
  "payload": {}
}
```

Rules:

- `messageId` is globally unique and supports idempotent receipt.
- `correlationId` links a response or terminal event to the initiating command.
- `runId` is required for run-scoped messages.
- Host commands use a monotonic connection sequence. Durable runtime events use a monotonic per-run sequence allocated by the journal.
- Protocol V1 sequence values are limited to `1..=9,007,199,254,740,991` so Rust and TypeScript preserve the same integer exactly.
- Unknown major protocol versions fail the handshake. Unknown message names are rejected with a typed protocol error.
- Invalid UTF-8, oversized frames, missing fields and malformed JSON terminate the connection without executing the payload.

## 3. Handshake

Runtime starts by emitting `runtime.hello`:

```json
{
  "runtimeVersion": "0.1.0",
  "protocolVersions": [1],
  "capabilities": ["runs", "events", "recovery"],
  "build": {
    "commit": "git-sha",
    "target": "x86_64-pc-windows-msvc"
  }
}
```

Electron answers with `runtime.initialize`, selecting one protocol version and providing application identity, workspace database location, public feature flags and host capability versions. Credentials are never included in the handshake.

The V1 payload is strict; unknown fields are rejected:

```json
{
  "selectedProtocolVersion": 1,
  "application": {
    "id": "novelx.desktop",
    "version": "0.2.7",
    "commit": "desktop-development"
  },
  "workspaceDatabasePath": "C:\\NovelX\\project\\.novax\\workspace.db",
  "featureFlags": {
    "runtime_v2": true,
    "recovery": false
  },
  "hostCapabilityVersions": {
    "project_tools": "1.0.0",
    "change_set": "2.0.0"
  }
}
```

`runtime.initialize` must be a `command` message, must use protocol version `1`, and must set both `correlationId` and `runId` to `null`.

The handshake-only foundation responds with `runtime.ready` after validating this payload. Before Runtime V2 is allowed to accept live work, initialization will also include migrations, journal integrity checks and incomplete-run discovery; failure then produces `runtime.initialization_failed`, and Electron must not route live work to Runtime V2.

The current handshake-only binary emits this strict `runtime.ready` payload after validating initialization:

```json
{
  "selectedProtocolVersion": 1,
  "runtime": {
    "version": "0.1.0",
    "build": {
      "commit": "runtime-development",
      "target": "x86_64-pc-windows-msvc"
    }
  },
  "recoveredRunCount": 0
}
```

The `runtime.ready` envelope uses sequence `2` and correlates to the `messageId` of `runtime.initialize`. After readiness, the handshake-only binary performs no run action and waits for stdin EOF. Any additional line is a protocol error and terminates the process with a non-zero exit code.

Initialization failure uses a strict `runtime.initialization_failed` `control` envelope. It must correlate to the initiating `runtime.initialize` message, cannot be run-scoped, and reuses the structured Runtime Error payload:

```json
{
  "protocolVersion": 1,
  "messageId": "uuid",
  "messageType": "control",
  "name": "runtime.initialization_failed",
  "sentAt": "2026-07-12T00:00:02.000Z",
  "correlationId": "runtime-initialize-message-uuid",
  "runId": null,
  "sequence": 3,
  "payload": {
    "code": "RUNTIME_JOURNAL_INTEGRITY_FAILED",
    "class": "storage",
    "retryable": false,
    "publicMessage": "运行记录完整性检查失败，Runtime V2 未启动。",
    "stage": "runtime.initialize",
    "attempt": 1,
    "diagnosticId": "uuid"
  }
}
```

The failure envelope requires a non-null UUID `correlationId` and `runId: null`. Unknown envelope fields, unknown error fields, credentials and raw stack traces are rejected.

## 4. Run Commands

Baseline commands:

- `run.start`
- `run.cancel`
- `run.resume`
- `run.retry`
- `run.get`
- `run.list`
- `approval.resolve`
- `goal.create`
- `goal.update`
- `plan.revise`
- `session.branch`
- `agent.handoff`

`run.start` pins project, session branch, Goal/Plan revision, Provider profile identity, Prompt/runtime policy identities, Free/Assist mode and source checkpoint. A running Run cannot silently change these identities. Changes produce a new Run or an explicit persisted revision event.

## 5. Durable Events

The runtime journal may emit:

```text
run.created
run.preparing
context.compiled
provider.requested
provider.responded
tool.requested
tool.authorized
tool.started
tool.completed
tool.failed
checkpoint.saved
approval.requested
approval.resolved
plan.revised
agent.delegated
agent.returned
change_set.staged
change_set.committed
run.retrying
run.blocked
run.cancelled
run.failed
run.completed
```

Events are appended before acknowledgement or projection. Event payloads are immutable. Corrections are new events; stored events are never edited in place.

Only one terminal Run event is allowed. `run.completed` requires acceptance evidence and cannot coexist with blocked, cancelled or failed terminal state.

## 6. Tool Ledger Contract

Every accepted `tool.requested` event creates one ledger entry:

```json
{
  "toolCallId": "uuid",
  "toolName": "project.read_range",
  "schemaVersion": 1,
  "argumentsHash": "sha256",
  "sideEffect": "none | staged_write | external_effect",
  "idempotencyKey": "uuid",
  "authorization": {
    "mode": "free | assist",
    "decision": "allowed | approval_required | denied",
    "policyVersion": "string"
  },
  "attempt": 1
}
```

Exactly one terminal ledger result is permitted: completed, failed, denied, cancelled or timed out. A Provider continuation cannot be compiled while an earlier tool call lacks a valid terminal result unless the runtime inserts a protocol-defined interruption result. Model-authored claims cannot close ledger entries.

## 7. Context And Source Receipts

`context.compiled` records budget categories and hashes, not private raw context in the public projection:

```json
{
  "contextWindow": 262144,
  "systemTokens": 12000,
  "historyTokens": 24000,
  "retrievalTokens": 32000,
  "outputReserveTokens": 8192,
  "availableInputTokens": 185952,
  "compilerVersion": "1.0.0",
  "sourceReceiptIds": ["uuid"]
}
```

A source receipt identifies the project resource, stable version, byte or logical range, content hash and durable task-memory note that covers it. Source content cannot be compacted until the covering task-memory record and receipt are committed.

## 8. Error Contract

Errors contain a stable code, class, retryability, public summary and internal diagnostic reference:

```json
{
  "code": "TOOL_RESULT_MISSING",
  "class": "protocol",
  "retryable": false,
  "publicMessage": "工具执行记录不完整，任务已停止。",
  "stage": "context.compile",
  "attempt": 1,
  "diagnosticId": "uuid"
}
```

Error classes:

- `protocol`
- `provider_auth`
- `provider_rate_limit`
- `provider_timeout`
- `provider_rejected`
- `context_capacity`
- `tool_arguments`
- `tool_permission`
- `tool_execution`
- `source_conflict`
- `stale_version`
- `storage`
- `runtime_crash`
- `cancelled`
- `validation`

Electron maps codes to user actions but preserves the original code and diagnostic identity internally. It must not relabel all classes as planning failure.

## 9. Cancellation And Recovery

Cancellation is a persisted request, not process termination. The runtime stops scheduling new side effects, asks cancellable work to stop, closes outstanding tool entries with a cancellation result and emits `run.cancelled` after reaching a stable checkpoint.

On restart, the runtime replays the event journal and classifies incomplete Runs:

- safe to resume automatically;
- waiting for user approval;
- retryable after Provider or tool failure;
- blocked because side-effect outcome is uncertain;
- terminal and projection-only.

An external side effect with unknown outcome is never repeated automatically. The Run becomes blocked until reconciliation determines whether it occurred.

## 10. Projection Boundary

Electron Main may receive internal events. Renderer receives allowlisted projections only:

- natural-language activity label;
- current stage and progress;
- Goal and Plan projection;
- child Agent status;
- approval request;
- artifact and source reference;
- typed error and recovery actions;
- model identity without credentials;
- committed history entries.

Player Mode receives a stricter projection that excludes tool details, hidden state, Creator Lens data, Prompt identity and internal Agent traces.

## 11. Limits

Protocol V1 does not yet define binary asset transfer, remote multi-user collaboration, arbitrary plugin execution or Android synchronization. Assets use project-local references and content hashes until a later protocol adds a framed binary channel.
