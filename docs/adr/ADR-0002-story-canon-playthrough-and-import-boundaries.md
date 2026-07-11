# ADR-0002: Story Canon, Playthrough, and Import Boundaries

## Status

Accepted on 2026-07-11.

## Context

NovelX must support three different activities without merging their truth:

- creators revise a World Base（世界基底）, OC（原创角色）, and Story Project（故事项目）;
- players continue an existing first-person playthrough after the creator canon changes;
- users import local novels or notes and ask a Decomposer（拆解器）to propose reusable worlds, characters, facts, and start profiles.

The current workspace already has immutable checkpoints, versioned resources, sourced canonical assertions, Change Sets（变更集）, and rebuildable projections. It does not yet have a durable playthrough boundary or a source-import candidate review boundary.

## Decision

1. Canonical creative data remains in existing versioned workspace tables. No second `.story-system` truth store is introduced.
2. A Story Project references a World Base and OC/OC Variant through versioned relations. Each playable Story Profile pins a Creative Commit（创作提交）as its canon baseline.
3. A Playthrough（游玩存档）is append-only and pins its original Story Profile and baseline commit. Later creator changes never rewrite its prior turns or state.
4. Returning from Tamper Mode（篡改模式）offers two explicit actions:
   - continue the old playthrough against its pinned canon;
   - fork a new playthrough from a newly accepted Story Profile.
   NovelX never fabricates an intermediate story to reconcile them automatically.
5. GM（游戏主持人）must resolve a turn through a real Provider（模型服务商）using retrieved canonical evidence, current play state, memory, luck, and player action. Writer（写手）may only render the immutable GM Resolution（GM 裁决）. Validator（校验器）may only reject leakage, unsupported facts, or authority violations.
6. Imported files enter a Source Library（来源库）as immutable, hashed source records. Parsing and decomposition create derived candidates only. Candidates become canon solely through Free Mode（自由模式）or Assist Mode（协助模式）Change Set policy.
7. Import is local-file initiated. NovelX does not crawl or download copyrighted novels. The source record stores an explicit rights attestation and origin metadata.

## Consequences

### Positive

- old saves remain reproducible after world retcons;
- creator canon and player history cannot silently overwrite each other;
- imported model output is auditable and cannot become canon without the existing policy gates;
- every generated claim can retain source and locator provenance.

### Negative

- a changed world can require parallel Story Profiles and Playthroughs;
- storage grows because turns and imported source chunks are append-only;
- projection rebuild and source parsing require background jobs and visible failure states.

### Neutral

- SQLite remains the desktop canonical store; large original files remain on disk and are referenced by hash and path.

## Alternatives Considered

### Rewrite old playthroughs after canon changes

Rejected because it destroys reproducibility and can change player choices retroactively.

### Automatically generate bridging fiction

Rejected as a default because it invents canon. A future explicit Agent task may propose a bridge through a reviewed Change Set.

### Store imports directly as canonical assertions

Rejected because parser and model errors would become authoritative facts without review or provenance boundaries.

