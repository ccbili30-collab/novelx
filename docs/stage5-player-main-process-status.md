# Stage 5 Player Main Process Status

Date: 2026-07-11

## Completed

- PlayerProcessSupervisor（玩家进程监督器）owns the Player Worker subprocess, Provider credential injection, cancellation, audit acknowledgements, interruption handling, and public event projection.
- Renderer requests contain only Playthrough id and player action. Evidence, current state, recent memory, luck, and writing constraints are built in the trusted main-process workspace boundary.
- PlayerTurnContextService（玩家回合上下文服务）uses the Playthrough baseline commit for world, story, bound OC, stable documents, assertions, and constraint profiles.
- A `continue_pinned` reconciliation decision is remembered for the exact current canon commit, so the conflict is not repeatedly presented on every turn.
- Player evidence and style constraints carry content hashes and stable source identities.
- PlayerRunCommitService（玩家运行提交服务）atomically verifies completed GM / Writer / Checker audit, appends the immutable turn, advances the Playthrough head, and writes the run terminal.
- A forged Worker completion without the three role audits writes no turn.
- Typed Electron IPC and isolated preload APIs exist for starting, cancelling, and subscribing to Player turns. Public completion exposes prose and public state, not GM resolution internals.

## Not Completed

- The renderer has no player card interface yet, so this IPC is not user-operable from the visible application.
- The GM Prompt remains candidate-only and the default real path is blocked until Provider eval publication.
- Large pinned projects currently fail closed when the deterministic packet is incomplete; relevance-ranked memory admission is not yet connected to PlayerTurnContextService.
- Import candidate review and Start Profile selection UI remain absent.
- No installer or release was produced from this batch.

## Functional Reduction Risks

- Luck defaults to neutral `0.5` only when no validated `luck` value exists in the persisted state. A later state-model UI must make this rule visible where numerical state is enabled.
- Recent memory currently includes the latest twelve immutable turns. Long-play retrieval must later supplement it with projection-backed memory rather than silently increasing prompt size.
- The supervisor is covered by protocol and transaction tests, but a visible Electron player E2E cannot exist until the renderer UI is implemented.
