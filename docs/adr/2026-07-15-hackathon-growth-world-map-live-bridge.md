# Growth World Map Live Bridge

## Status

Accepted on the hackathon branch. Dual-Provider Live evidence is
`notes/evidence/novax-desktop-growth/growth-live-2026-07-15T11-01-14-808Z.json`
(SHA-256 `28574F302D4040E85312E2C07C050F35D2DEC5ACCC1A97C68297A1B8C3E2125F`):
`openai-compatible / gpt-5.4` completed all three text Cycles and the later research-only retrieval;
`openai-compatible-image / gpt-image-2` produced the one source-bound `world_map` Job and ready Asset.
Renderer visual acceptance, the full suite, and packaging remain outside this ADR's accepted boundary.

## Decision

Only the trusted Growth world phase may append `generate_image` after its committed Change Set. The model supplies a strict visual brief containing only `title` and `prompt`. The Agent Worker derives the formal world, its committed resource revision, and exactly one committed world-setting document version from that same Change Set. It compiles these trusted values into the existing `world_map` image request with a deterministic cycle-scoped idempotency key.

No model-visible map input can choose source IDs, versions, Provider settings, paths, hashes, purpose, or idempotency. Missing, duplicate, or mismatched committed outputs fail before any image Provider request.

## Consequences

The existing image service remains the sole authority for durable jobs, assets, managed files, recovery, and source validation. Its optional internal observer emits only durable transition facts; observer failures are isolated. The Main supervisor projects fixed safe run activities for queued, generating, ready, failed, and reconciliation states without exposing arguments, content, credentials, paths, hashes, or Provider errors.

Definitive image failure never rolls back the already committed world Change Set and does not trigger an image retry. The Growth coordinator can continue later text cycles from the committed checkpoint. Outcome-unknown remains reconciliation-required.

Story, OC, ordinary Steward, public IPC, Prompt activation, and image policy semantics are unchanged.
