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
- Host and runtime each allocate their own monotonic connection sequence for handshake, control, command and response messages. Durable runtime events use a separate monotonic per-run sequence allocated by the journal.
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

After `runtime.ready`, the host may use a continuous control loop:

- `runtime.status.get` is a `command` with `{}` payload, `correlationId: null` and `runId: null`.
- `runtime.status` is a `response` correlated to the status command and has `runId: null`.
- `runtime.shutdown` is a `command` with `{}` payload, `correlationId: null` and `runId: null`.
- `runtime.stopped` is a `response` correlated to the shutdown command and has `runId: null`.

The strict status response payload is:

```json
{
  "initialized": true,
  "workspaceDatabaseConfigured": true,
  "recoveredRunCount": 0,
  "protocolVersion": 1,
  "runtimeVersion": "0.1.0"
}
```

The strict stopped response payload is:

```json
{
  "reason": "requested"
}
```

Command and response payloads reject unknown fields. Host command sequence and runtime response sequence are independently monotonic for the lifetime of the connection; matching numeric values across directions do not imply shared ownership.

Provider credentials do not use the ordinary `command` envelope. `provider.bind` uses the dedicated `sensitive_command` message type with the same Host connection sequence. Its strict payload is `{ config, configSha256, credential }`. The Runtime validates and consumes it in memory, never appends it to the Event Journal and responds only with secret-free `provider.bound` or typed `provider.rejected`. Generic Runtime envelope parsers reject `sensitive_command` so it cannot accidentally enter ordinary command logging or projections.

The migration implementation sends the sensitive frame from Electron Main as a UTF-8 Buffer and overwrites that Buffer after the stdin write callback. JavaScript strings and operating-system pipe buffers cannot be proven zeroized; ADR-0006 records this limitation and the future Windows Credential Manager route.

When `workspaceDatabasePath` is configured, `runtime.initialize` also requires non-empty `projectId` and `workspaceId`. When no workspace database is configured, all three fields are null. A Run whose pinned project/workspace identity does not match initialization is rejected without a journal write.

## 4. Run Commands

Baseline commands:

- `run.start`
- `run.prepare`
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

The durable `run.created` version-2 payload carries the complete secret-free pinned identity defined by ADR-0005. The stable start idempotency key is distinct from the envelope `messageId`. A retry with the same Run/key/identity returns the current recovered snapshot; a changed identity conflicts and writes nothing. Experimental version-1 creation events do not qualify as live Runs because they lack sufficient provenance.

The current foundation implements:

- `run.start`: command with required envelope `runId` and strict `{ startIdempotencyKey, pinnedIdentity }` payload. It durably accepts the Run and returns `run.snapshot`; it does not claim that Provider execution has started.
- `run.get`: command with required envelope `runId` and strict empty payload. It replays the journal and returns `run.snapshot` without changing state.
- `run.prepare`: command with required envelope `runId` and strict `{ prepareIdempotencyKey }` payload. It resolves the exact Provider profile pinned by the Run before scheduling any inference. An exact in-memory binding persists `run.preparing`; a missing credential persists terminal `REAL_GM_PROVIDER_REQUIRED`; a changed profile persists terminal `PROVIDER_PROFILE_MISMATCH`. A retry with the same business key returns the recovered snapshot without another transition event.
- `run.cancel`: command with required envelope `runId` and strict `{ cancelIdempotencyKey, reason }` payload. It persists `run.cancelled`, returns the terminal snapshot and is idempotent across transport retries.
- `run.snapshot`: correlated response whose envelope and payload `runId` match. It includes pinned identity, lifecycle state, recovery classification, Run/aggregate sequences, creation/update timestamps and nullable structured `terminalError`. A terminal prerequisite failure must remain recoverable after process restart; it cannot be replaced by a generic planning error.
- `run.rejected`: correlated, Run-scoped response carrying a typed Runtime error. Domain rejection does not terminate an otherwise valid protocol connection.

`WaitingForApproval` projects as `waiting_for_approval` and remains nonterminal. `Committing` recovers as `commit_uncertain`; queries never auto-repeat a commit or external side effect.

Cancellation is a journaled state transition, not process termination. Cancelling a Run does not stop the Runtime sidecar or discard unrelated Runs.

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

Rust Runtime V2 is authoritative for the final normalized Provider input. Electron and domain modules may submit typed source candidates, but they do not independently trim, reorder or serialize the final request.

The initial Context Compiler protocol has three messages:

- `context.compile`: Run-scoped `command` with a strict payload containing the business idempotency key, invocation/request identity, pinned Provider and context-policy identities, compiler version, context window, output/safety policy and typed items.
- `context.compilation`: correlated, Run-scoped `response` carrying the immutable compilation receipt.
- `context.rejected`: correlated, Run-scoped `response` carrying a structured Runtime Error. A nonfatal capacity, identity or policy rejection does not become a generic planning error.

Typed context items distinguish system Prompt, tool protocol, session message, retrieval source, runtime exchange and output reserve. Each model-visible content item carries a SHA-256 identity and disclosure class. Tool calls and results remain typed runtime exchanges rather than unclassified strings.

Successful compilation persists a `context.compiled` event before `context.compilation` is returned and before any future Provider inference request may be issued. An identical business idempotency retry returns the persisted receipt; a changed request under the same key is rejected.

The receipt records budget categories and hashes, not private raw context in the public projection:

```json
{
  "compilationId": "uuid",
  "requestNumber": 1,
  "tokenizer": {
    "kind": "fallback_estimate",
    "id": "novelx.unicode-mixed-v1",
    "version": "1.0.0",
    "providerId": "provider-id",
    "modelId": "model-id"
  },
  "contextWindow": 262144,
  "estimatedInputTokens": 68000,
  "exactInputTokens": null,
  "safetyReserveTokens": 4096,
  "outputReserveTokens": 8192,
  "availableInputTokens": 249856,
  "compilerVersion": "1.0.0",
  "canonicalContextSha256": "sha256",
  "includedItemIds": ["system", "tools", "current-user"],
  "omittedItemIds": [],
  "incomplete": false,
  "accepted": true
}
```

The current implementation uses the versioned conservative `novelx.unicode-mixed-v1` fallback estimator and records `exactInputTokens: null`. `provider_exact` and `known_model` are reserved tokenizer identities, not completed tokenizer integrations. `incomplete` is true whenever an item is omitted or an included retrieval source declares partial coverage.

A future source receipt must identify the project resource, stable version, character or logical locator, content hash and durable task-memory note that covers it. Source content cannot be compacted until the covering task-memory record and receipt are committed. The initial compiler records item inclusion/omission and source identities, but full compaction, source locator/range coverage and durable-note replacement are not implemented yet.

### Provider inference attempt ledger

The Rust Provider Gateway now supports one strict OpenAI-compatible inference request bound to an accepted persisted Context Compilation Receipt. The request is serialized once into exact UTF-8 transport bytes; its SHA-256 identity is persisted in a separate `provider_attempt` aggregate before those bytes are sent.

Provider attempt events are:

- `provider.requested`: durable secret-free intent, Context receipt identity and exact transport-payload hash;
- `provider.sent`: conservative dispatch boundary persisted before the HTTP client may touch the socket;
- `provider.responded`: validated model/finish reason/usage, response hashes and recoverable assistant text;
- `provider.failed`: a definitive known failure with `not_sent` or `response_received` delivery certainty;
- `provider.outcome_unknown`: the request may have reached the Provider, so automatic replay is forbidden.

On restart, `requested` is safe to send, `responded` is returned from the journal without another HTTP request, and `sent` without a terminal event is classified as `outcome_unknown`. Provider credentials and Authorization headers are not stored in these events. The accepted normalized Provider input is stored once in the authoritative `context.compiled` record, while attempt events retain only its receipt and transport hashes.

The public protocol reserves an asynchronous Provider inference exchange. It does not keep a command request open until the external model finishes:

- `provider.inference.start`: Run-scoped `command`. Its strict payload identifies the inference, attempt, invocation, accepted Context Compilation, request/attempt numbers and inference idempotency key.
- `provider.inference.accepted`: correlated Run-scoped `response`. It means the Runtime has accepted queue ownership for that attempt; it does **not** mean inference completed successfully.
- `provider.inference.completed`: correlated Run-scoped terminal `event` containing actual Provider/model identities, response hashes, stop reason, token usage and the bounded output receipt.
- `provider.inference.failed`: correlated Run-scoped terminal `event` containing a structured definitive failure.
- `provider.inference.reconciliation_required`: correlated Run-scoped terminal `event` with reason `outcome_unknown`. It forbids misleading automatic retry claims and corresponds to the nonterminal Run state `waiting_for_reconciliation`.

Every accepted or terminal payload repeats `runId`, `inferenceId`, `attemptId`, `contextCompilationId`, `requestNumber` and `attemptNumber`. The payload `runId` must equal the envelope `runId`. Accepted and all terminal messages correlate to the original `provider.inference.start` command message ID. For one accepted inference attempt, exactly one terminal inference event is allowed.

The completed output is nonempty, limited to 1 MiB of UTF-8, and identified by a lowercase SHA-256 hash. Its recorded UTF-8 byte length must match the text. Input plus output tokens must equal total tokens.

Rust consumers must call the payload's public `validate()` after strict deserialization. Structural Serde validation alone does not enforce positive counters, nonempty identities, hash content, usage arithmetic, output bounds or reconciliation retry policy; failures use the stable public `ProviderInferenceValidationError` type.

The Rust Runtime provides an independent `ProviderInferenceProtocolMapper` that converts a `ProviderInferenceExecution` plus an accepted outcome or service error into the corresponding payload and `RuntimeOutputDraft`. It preserves the original command correlation and inference identity, recomputes output text hash and UTF-8 byte length, rejects mismatched Context/model identities, and maps service error variants explicitly. Known 429 and 5xx responses carry the same retryable failure declaration as the attempt ledger; this declaration does not bypass retry budget, deadline, cancellation or reconciliation policy.

The Rust Runtime now accepts this exchange after `runtime.ready`. It validates and persists preparation before `provider.inference.accepted`, dispatches through the single Runtime Actor writer, reopens the workspace journal for finalization and emits exactly one mapped terminal event. Electron/UI orchestration remains separate work.

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
