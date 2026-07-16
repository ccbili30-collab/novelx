# Story Volume Relation Semantics

Status: accepted for `codex/hackathon-10day` on 2026-07-16.

## Context

OC personal longform is stored as a `story` resource whose `objectKind` is `volume`, beneath the one main `story`. It must remain independently retrievable and Closure-verifiable. Indirectly borrowing the main story's relations would make the personal story's world and OC authority ambiguous.

## Decision

- Both `story` and `volume` are narrative containers.
- A narrative container may be the source of `uses_world` and `uses_oc`.
- `chapter` and other story descendants do not inherit that authority.
- `volume` remains a child of the main `story`; this decision does not flatten the resource hierarchy.
- `creativeRelationPolicy.ts` is the executable authority. Repositories, Gateways, compilers, and tests must not redefine endpoint rules independently.

## Consequences

- A personal-story volume can directly bind its unique world and focus OC for graph retrieval and OC Closure.
- Existing main-story relations remain valid.
- No schema migration, public protocol change, or historical data rewrite is introduced.
- Adding another narrative container kind requires an explicit product decision and a policy test; it must not be enabled by a local compiler workaround.

## Focused verification

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/creative-relation-policy.test.ts tests/unit/creative-relation-repository.test.ts tests/unit/growth-longform-progress.test.ts
npm run typecheck
git diff --check
```
