# ADR-0008: Provider Attempt Ledger And Uncertain Outcome Handling

## Status

Accepted

## Context

Runtime V2 can now pin a Provider identity, bind a short-lived credential, prepare a Run and persist a Context Compilation Receipt. The next boundary is a real inference request.

A Provider call is an external side effect. The Runtime may crash after request transmission begins but before a response or terminal failure is persisted. Replaying that request automatically can create duplicate model work, duplicate billing, inconsistent tool calls or two competing continuations. Conversely, persisting only after the response loses the evidence needed to determine what might have happened.

Provider errors also differ materially. Authentication failure, rate limiting, timeout before dispatch, timeout after dispatch, malformed response and local storage failure cannot all use one retry rule. The runtime needs an append-only attempt ledger that separates known terminal outcomes from uncertain external outcomes and binds every request to the exact compiled context that authorized it.

## Decision

### One Ledger Entry Per Attempt

Every network attempt receives a stable `providerAttemptId`. Retries create new attempts linked to the prior attempt; they do not overwrite or reuse its terminal record.

The ledger records at least:

- Run, invocation and request number;
- attempt number and parent attempt identity;
- pinned Provider/profile/model/config identities;
- Context Compilation Receipt identity and canonical context hash;
- request schema/API/auth versions;
- output policy, timeout and retry policy identities;
- request body hash after canonical secret-free serialization;
- lifecycle state, timestamps and terminal classification;
- response identity, usage, finish reason and response hash when known;
- structured Runtime Error and diagnostic identity when failed.

Provider attempt events are immutable. Corrections and retries are new events.

### Persist Before Send

Before any request bytes may be handed to the HTTP client, Runtime V2 must transactionally persist the attempt identity and a `provider.requested` event containing the secret-free request receipt.

The persisted pre-send state is the external-effect boundary. Once the runtime enters the network-send call, recovery must conservatively assume that the Provider may have received the request unless a terminal local failure proves transmission never began.

If attempt persistence fails, the request is not sent. If Context Compilation Receipt persistence is missing, rejected or does not match the Run's pinned identity, the request is not created.

### Uncertain Outcome Is Terminal For Automatic Scheduling

If the process, machine or transport disappears after transmission may have begun and before a valid terminal Provider result is committed, recovery classifies the attempt as `outcome_unknown`.

`outcome_unknown` is not automatically replayed, including when the configured retry budget is nonzero. The Run enters a new nonterminal `waiting_for_reconciliation` state with a typed public recovery action. It must not reuse the existing terminal `blocked` state, because a terminal state cannot truthfully resume after reconciliation. A later user or policy-authorized reconciliation may:

- accept a subsequently discovered Provider response if its identity and request correlation can be verified;
- explicitly start a new attempt, acknowledging possible duplicate cost/output;
- cancel or abandon the Run.

The runtime must not convert `outcome_unknown` into timeout, cancellation or retryable failure merely to keep the workflow moving.

### Retryability Classification

Retryability is a property of a known terminal attempt result, not a general permission to repeat any incomplete request.

Automatic retry is allowed only when all of the following hold:

1. the attempt has a committed terminal failure;
2. the failure class is allowlisted by the pinned retry policy;
3. the outcome is known not to contain an accepted Provider completion;
4. the deadline and retry budget remain available;
5. cancellation has not been requested;
6. the next attempt reuses the same pinned Run and Context receipt, or a new compiled receipt is explicitly persisted and linked.

Baseline classification:

| Failure | Default retryability | Notes |
| --- | --- | --- |
| Provider authentication/rejection | No | Requires configuration or policy change. |
| Rate limit with valid retry guidance | Yes | Bounded by deadline and retry budget. |
| Connection failure proven before request dispatch | Yes | No external outcome occurred. |
| Timeout or disconnect after dispatch may have begun | No automatic replay | Classified `outcome_unknown`. |
| Malformed/oversized Provider response | Policy-dependent | The request outcome exists; retry creates a new attempt and must be explicit in policy. |
| Context, validation or storage failure before send | No Provider retry | Repair the local prerequisite first. |
| Cancellation | No | Cancellation is a separate terminal classification. |

Retries use bounded backoff and a new attempt identity. Model-authored text cannot declare an attempt retryable.

### Response Identity And Usage

A successful terminal attempt persists a `provider.responded` event and receipt containing:

- actual Provider and model identifiers returned or observed;
- response identity hash, and raw response ID only when policy permits durable storage;
- canonical response hash and validated response schema version;
- stop/finish reason;
- input, output, cached and total token usage as nullable Provider-reported values;
- local estimated usage and estimator identity when Provider usage is absent;
- latency and attempt timestamps;
- Context Compilation Receipt identity;
- tool-call identities or structured assistant output references extracted from the response.

Provider-reported usage and local estimates are separate fields. The runtime does not present an estimate as billed usage. Missing usage remains `null`, not zero.

A response whose actual model or Provider conflicts with the pinned policy is persisted as evidence and then rejected or blocked according to policy; it is not silently relabelled as the requested model.

### Secret Boundary

Credentials never enter the ordinary Runtime Protocol envelope, Context receipt, attempt ledger, event payload, request hash input, stderr or Renderer projection.

The Provider Gateway obtains a short-lived credential from the zeroizing in-memory binding associated with the exact pinned Provider profile. Authorization headers and sensitive query/body fields are added only at the HTTP boundary. Diagnostic records may identify the credential binding receipt, never the credential value.

Request and response sanitization must occur before hashing or persistence when a Provider protocol can contain sensitive fields. A redacted hash is explicitly labelled as such and cannot be confused with the raw wire-body hash.

### Context Receipt Binding

Every attempt references exactly one accepted Context Compilation Receipt. The request body is generated from the canonical compiled input associated with that receipt.

The Provider Gateway verifies before send:

- receipt Run and request number match the attempt;
- Provider/model/profile and context policy match the pinned Run;
- receipt is accepted and persisted;
- canonical context hash matches the serialized Provider input;
- output reserve and request max-output setting agree;
- no required tool call lacks a terminal tool result.

Changing session history, retrieval, tool protocol, model profile or output reservation requires a new Context Compilation Receipt and therefore a new attempt relationship.

### Run State Relationship

Provider attempts are subordinate aggregates under a Run. They do not replace the Run state machine.

- A prepared Run may enter active inference only after an accepted persisted Context receipt and pre-send attempt event exist.
- A sent attempt keeps the Run nonterminal.
- A known retryable failure may transition the Run through `retrying` before a new attempt is appended.
- A known non-retryable failure transitions the Run to the appropriate blocked or failed state with the same structured error identity.
- `outcome_unknown` transitions the Run to `waiting_for_reconciliation`; it never becomes `run.completed` or automatic `run.retrying`. This new Run state and its UI recovery action are required follow-up work and are not implemented by the initial attempt-ledger batch.
- A valid Provider response permits the next governed step, such as tool authorization/execution or structured final validation. It does not by itself imply that the Run is complete.
- `run.completed` remains legal only after all tool, validation, Change Set and acceptance requirements are satisfied.

Cancellation stops scheduling new attempts. If cancellation races with a request whose dispatch may already have begun, the attempt is reconciled using the same known/unknown outcome rules; the runtime does not claim the Provider call was cancelled without evidence.

## Alternatives Considered

### Persist Only Successful Responses

Rejected because a crash after send would leave no durable record that an external request may have occurred.

### Automatically Retry Every Timeout

Rejected because timeout does not prove the Provider failed to accept or complete the request. Automatic replay can duplicate cost and continuation state.

### Reuse One Mutable Attempt Row

Rejected because mutation erases retry history and makes recovery dependent on the last partial write. Append-only attempts preserve causality.

### Let The HTTP Client Library Decide Retries

Rejected for inference requests. Transparent client retries hide send boundaries and attempt identities. Transport connection setup may use tightly scoped safe retries only when the library can prove no request was dispatched; otherwise Runtime V2 owns each attempt.

### Store Credentials With The Attempt For Recovery

Rejected because durable credentials increase breach impact and violate the Provider credential boundary. Recovery requires a new valid in-memory binding, not secret replay from the journal.

### Treat Provider Response As Run Completion

Rejected because a response may request tools, violate validation, await approval or produce a Change Set requiring review.

## Consequences

### Positive

- Crash recovery can distinguish known failure, known success and uncertain external outcome.
- Automatic retries remain bounded and auditable.
- Billing/usage reports identify Provider-reported versus estimated values.
- Every Provider output can be traced to one persisted compiled context.
- Secrets remain outside durable runtime events and desktop projections.

### Negative

- More states and events are required before visible inference works.
- `outcome_unknown` may require user intervention even when replay would often succeed.
- Provider-specific response identity and usage normalization require maintained adapters.
- Strict persistence-before-send adds a storage round trip to every attempt.

### Neutral

- This ADR defines the attempt ledger and recovery policy; it does not claim the real inference loop is implemented.
- SQLite remains the initial authoritative ledger store.
- Provider-side idempotency keys may reduce duplicate risk when available, but they do not replace local attempt and uncertainty rules.

## Migration Boundary

- Existing ping/capability tests remain connection diagnostics, not inference-attempt evidence.
- Legacy Pi Agent Provider calls remain a separate compatibility path until Runtime V2 attempts pass conformance and crash-recovery tests.
- Electron may bind credentials but cannot create, retry or close Provider attempts.
- The first production migration must prove process death before send, during send, after response and before terminal persistence.
- Runtime V2 cannot become the default until real Provider attempts, usage receipts, secret-leak checks, timeout classification and `outcome_unknown` reconciliation have durable test evidence.

## References

- `docs/adr/ADR-0006-rust-provider-gateway-and-credential-boundary.md`
- `docs/adr/ADR-0007-authoritative-context-compiler.md`
- `docs/runtime-v2/protocol-v1.md`
- `docs/runtime-v2/current-runtime-audit.md`
- `docs/runtime-v2/codex-reference-audit.md`
