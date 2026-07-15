# Growth Coordinator v1: three bound Cycles from one user start

Date: 2026-07-15

## Decision

`GrowthCoordinator` is a Main-authoritative orchestration layer for exactly
three serial Free Growth Cycles under `grow_world_story_oc_v1`. A single
strict `growth.start` request creates or replays one Goal by request UUID. The
Coordinator derives the active branch, pinned checkpoint, and Creator-visible
scope from the opened Workspace; the Renderer cannot supply these authorities.

Each Cycle is persisted as `planned` and emits a durable `cycle_planned` event
before its new Agent Run starts. The existing `GrowthRunLifecycle` then owns
the run binding, `growth_v1` Receipt, one existing Change Set attempt, and its
terminal reconciliation rules. Only a committed Free Change Set advances to
the next Cycle, whose input checkpoint is exactly the preceding committed
output checkpoint. The Goal remains active after the third committed Cycle so
later rule additions or continuation can be explicitly scheduled.

`growth.get` and `growth.event` expose only a strict safe projection of durable
Goal/Cycle/Event identity and state. Each Event retains its repository-validated
target version and optional allowlisted ContentRef, so a later UI can open the
actual versioned object. Source locators, hashes, workspace paths, Prompt text,
tool arguments, and credentials are not projected. Live growth events are
published only after `GrowthRepository` successfully persists the authoritative
event.

The existing `novax:agent-event` remains the separate live activity stream for
the Growth-bound Runs. The Coordinator adds the verified session route before
delivery, validates the projected Agent event, and treats every renderer
delivery failure as non-authoritative after durable state has been written.
When several verified sessions replay one Goal, each route receives its own
sessionId rather than the initiating session's label.
`growth.guide` is a strict versioned IPC（进程间通信） write. Renderer（渲染层）
supplies only the Goal ID, expected rule revision, new rule text, and exactly
one replay identity (`sourceMessageId` or `requestId`). Main（主进程） rebuilds
the active project, Workspace Session（工作区会话）, branch, and authorized
scope, then uses the repository CAS（比较并交换） append. It accepts guidance
only when the bounded strategy still has an unplanned next Cycle. The response
states `persisted_pending_boundary` and `next_cycle_boundary`; it never claims
that the running Cycle changed or that the rule was already applied.

Each planned Cycle pins `ruleRevision` before its Run starts. Main reads that
exact historical revision and uses its rule text for the Cycle instruction;
it never reuses `growth.start.initialRuleText` for later Cycles. Main also
derives trusted resource seed IDs from the persisted Goal (including the owner
of a source-document seed) and unions them into Graph Retrieval; model tool
arguments cannot remove or replace that pinning.

`growth.get` adds optional, backward-compatible `currentRuleRevision`,
`activeCycleRuleRevision`, and guidance status fields because the existing
capability version is unchanged. Main always emits them. The projection does
not expose rule text, Prompt（提示词）, credentials, branch, checkpoint, scope,
Lens（视角）, Cycle authority, or Run authority.

## Consequences

- Replaying the same request UUID cannot create another Goal, Cycle, Run, or
  Change Set. Planned Cycles start once; running Cycles are conservatively
  recovered to `reconciliation_required`; failed, blocked, cancelled, and
  reconciliation states stop automatic progress.
- Exact guidance replay returns the persisted revision; a competing stale CAS
  fails closed. C3 running and three committed Cycles both reject guidance
  because this decision does not introduce Cycle 4 semantics.
- Public snapshots carry a Main-computed coordinator status. Three committed
  Cycles are `completed` while the underlying Goal remains `active`; replay
  lists are bounded to the latest 100 cycles and events.
- Coordinator advancement invoked from an Agent terminal callback is contained:
  a failed next `cycle_planned` event terminalizes that next Cycle without
  preventing the prior Supervisor Run from releasing its lease. A terminal
  repair event is best-effort only; it never rewrites the authoritative state.
- The Coordinator supplies phase intent and structural limits only. It does
  not create fictional facts, prose, titles, characters, or Change Set items.
- This slice does not prove a real Provider（模型服务） run, automatic continuation beyond
  three Cycles, Renderer UI, images, or any
  change to Canon, Lens, permissions, migrations, or Agent tool schemas.
