# ADR-0005: Run Pinned Identity and Start Idempotency

Status: accepted  
Date: 2026-07-12

## Context

Runtime V2 previously persisted only Run state transitions. A recovered Run could not prove which project, workspace, session branch, project branch, user message, source checkpoint, Provider, model, Prompt bundle or policy produced it. The creation event also reused the transport `messageId` as the business idempotency key, so a retry after a lost response could conflict or create ambiguous state.

## Decision

`run.created` event version 2 stores one strict `RunPinnedIdentity`. It contains:

- project and workspace identity;
- session, session branch and user message identity;
- project branch and source checkpoint;
- optional versioned Goal and Plan references;
- sorted, unique effective resource scope plus its canonical SHA-256;
- user input SHA-256 without raw user text;
- Provider profile, Provider, model and secret-free configuration SHA-256;
- Prompt bundle, Agent profile, tool policy, context policy and runtime policy version identities;
- runtime contract version and Free/Assist mode.

API keys, raw Prompt text, raw user input and filesystem paths are not part of this identity.

The creation command supplies a stable business idempotency key separately from the envelope `messageId`. Repeating the same Run ID and stable key with the same canonical identity returns the journal-recovered current Run. Changing any pinned field under that key fails without writing. A new transport message ID and timestamp are allowed for a legitimate retry.

Unknown creation or transition event versions fail recovery. `WaitingForApproval` remains a nonterminal runtime state; UI may project it as `awaiting_confirmation`, but that projection must not make the Run terminal. Missing Provider credentials will eventually produce a durable failed/blocked transition with `REAL_GM_PROVIDER_REQUIRED`; it will never produce a local fallback result.

## Consequences

- `run.get` can be implemented from the journal without relying on an Electron window or in-memory map.
- Session edits, model changes and source-head changes cannot silently alter an already accepted Run.
- Start retries survive response loss and process restart.
- Existing experimental version-1 `run.created` events are not accepted as complete live Runs because they cannot prove identity. A future explicit importer/upcaster may quarantine or migrate them, but the runtime will not invent missing provenance.
- Runtime command handling must retain the opened journal and validate project/workspace binding before accepting live execution.
