# ADR-0006: Rust Provider Gateway and Credential Boundary

Status: accepted  
Date: 2026-07-12

## Context

The Legacy Runtime decrypts the Provider credential in Electron Main, copies the full profile into a Node Worker and lets the Pi adapter perform HTTP, retry, context admission and receipt projection. Runtime V2 must make Provider execution recoverable and auditable without putting credentials into the Event Journal or allowing Electron/Renderer state to decide whether a Run succeeded.

## Decision

Rust Runtime V2 owns the Provider Gateway:

- request construction and OpenAI-compatible transport;
- model/profile identity validation against the Run pinned identity;
- context and output admission;
- bounded timeout and retry policy;
- cancellation propagation;
- response protocol validation;
- usage, model, response identity and context-budget receipts;
- typed error classification and durable Provider events.

Electron retains the existing Windows `safeStorage` credential file during migration. It may decrypt a credential only in Main and inject it into the owned Runtime process through a dedicated sensitive command. That command is never journaled, projected to Renderer, included in diagnostics or replayed as a normal Runtime event. Rust stores the credential only in zeroizing memory and exposes only a secret-free binding receipt.

Provider configuration is split into:

1. `ProviderConfig`: profile/provider/model, display name, base URL, context window, optional output ceiling, reasoning and input capabilities.
2. `ProviderCredential`: the secret token, never serializable into durable Runtime objects.
3. `ProviderConfigIdentity`: canonical SHA-256 of the secret-free configuration. It must match the Run pinned identity before any request.

The Runtime moves to Tokio + Reqwest for asynchronous HTTP, cancellation and bounded concurrency. The synchronous stdin/stdout command loop will be migrated behind an actor boundary; Provider work must not block command intake or cancellation.

## Error Rules

- Missing credential: durable Run failure `REAL_GM_PROVIDER_REQUIRED`; no fallback text.
- Profile/config hash mismatch: `PROVIDER_PROFILE_MISMATCH`; no request sent.
- Authentication rejection: `provider_auth`, not generic runtime failure.
- Rate limit: `provider_rate_limit`, retry only when policy and server timing permit.
- Timeout/network failure: `provider_timeout` or `provider_rejected` with bounded attempts.
- Invalid JSON, missing assistant message, invalid tool pairing or mismatched model receipt: `provider_protocol_failed` and no success artifact.
- Output length stop: `PROVIDER_OUTPUT_INCOMPLETE`; partial text is not accepted as completion.

## Consequences

- Pi Agent may remain a temporary orchestration reference, but it no longer owns the authoritative Provider lifecycle.
- Provider credentials cross one local process boundary during migration. This is accepted only with explicit sensitive-message handling and leak tests; it is not equivalent to putting credentials in normal Protocol V1 logs.
- A future Windows Credential Manager implementation may let Rust load credentials directly and remove this injection step without changing Run or Provider receipt contracts.
- Runtime V2 cannot claim Provider execution complete until a real Provider request, durable request/response receipts and failure recovery are verified end to end.
