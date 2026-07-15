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
Each stage instruction repeats the Goal's locked initial rule text. Main also
derives trusted resource seed IDs from the persisted Goal (including the owner
of a source-document seed) and unions them into Graph Retrieval; model tool
arguments cannot remove or replace that pinning.

## Consequences

- Replaying the same request UUID cannot create another Goal, Cycle, Run, or
  Change Set. Planned Cycles start once; running Cycles are conservatively
  recovered to `reconciliation_required`; failed, blocked, cancelled, and
  reconciliation states stop automatic progress.
- Public snapshots carry a Main-computed coordinator status. Three committed
  Cycles are `completed` while the underlying Goal remains `active`; replay
  lists are bounded to the latest 100 cycles and events.
- Coordinator advancement invoked from an Agent terminal callback is contained:
  a failed next `cycle_planned` event terminalizes that next Cycle without
  preventing the prior Supervisor Run from releasing its lease. A terminal
  repair event is best-effort only; it never rewrites the authoritative state.
- The Coordinator supplies phase intent and structural limits only. It does
  not create fictional facts, prose, titles, characters, or Change Set items.
- This slice does not prove a real Provider run, automatic continuation beyond
  three Cycles, user mid-Run rule insertion, Renderer UI, images, or any
  change to Canon, Lens, permissions, migrations, or Agent tool schemas.
