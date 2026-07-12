# ADR-0010: Workspace-Scoped Goal and Plan Event Journal

Status: accepted
Date: 2026-07-12

## Context

Runtime V2 currently persists execution events in a Run-scoped EventJournal（运行范围事件日志）. Every event address and uniqueness rule is partitioned by `run_id`. This is correct for Provider attempts, ToolCalls（工具调用）, approvals, checkpoints and terminal Run state because those facts belong to one bounded execution.

Goal（目标） and Plan（计划） have a different lifetime. A Goal may span multiple Runs, sessions and process restarts. A Plan has immutable revisions under that Goal, and older Runs must continue to prove which revision they used. Storing these objects under one Run would make the creating Run an accidental owner, split later revisions across unrelated streams, and make cross-Run concurrency depend on whichever Run happened to write last.

The existing `RunPinnedIdentity.goal` and `.plan` values are only revision references. Persisting a reference inside `run.created` proves what the Run claimed to use; it does not prove that the referenced Goal or Plan existed, contained valid data or remained recoverable.

## Decision

NovelX will add an independent Workspace-scoped append-only journal（工作区范围仅追加日志） for durable Goal and Plan aggregates. The existing Run EventJournal remains unchanged and authoritative for Run-local execution.

### Stream address

Each workspace event is addressed by:

```text
workspace_id
stream_type       goal | plan | session_goal_projection_source
stream_id         goal_id | plan_id | session_id
stream_sequence   positive integer, contiguous within the stream
```

Every event also receives a monotonic `workspace_sequence` within one workspace for deterministic projection catch-up. Neither sequence is a wall-clock ordering guarantee across workspaces.

Goal identity is `(workspace_id, goal_id)`. Plan identity is `(workspace_id, plan_id)` and every Plan permanently references exactly one `goal_id`. Project and session scope are payload fields validated by the aggregate; they do not replace workspace ownership.

### Append-only storage

Stored events are immutable. Corrections and status changes append new events. Update and delete triggers reject mutation. Event versions are explicit, and an unknown required version fails replay instead of guessing.

The initial event vocabulary is:

- `goal.created`, `goal.revised`, `goal.status_changed`, `goal.completion_proposed`, `goal.completed`, `goal.blocked`, `goal.cancelled`;
- `plan.created`, `plan.revised`, `plan.step_assigned`, `plan.step_started`, `plan.step_completed`, `plan.step_blocked`, `plan.superseded`;
- `session.goal_attached`, `session.goal_detached`.

Run-local tool and artifact events remain in the Run journal. Goal and Plan events refer to their evidence by immutable causal references; they do not copy mutable UI state or hidden chain-of-thought.

### Ordering and concurrency

Each command supplies `expectedStreamSequence`. Append occurs in an immediate SQLite transaction and succeeds only when the current stream sequence matches. Concurrent revisions from two sessions therefore produce one success and one typed revision conflict; no last-write-wins merge is allowed.

Multi-stream operations do not pretend to be atomic unless implemented in one workspace-journal transaction. Creating a Plan requires an existing Goal revision. Attaching a Plan to a session records explicit references after both source aggregates have been validated.

### Idempotency

Every command carries a stable business `idempotencyKey`, separate from transport `messageId`. Idempotency is unique within the workspace. Repeating the same key with the same canonical command intent returns the prior receipt. Reusing it with different intent fails without writing.

Canonical intent includes command type, workspace, aggregate identity, expected sequence, referenced revisions and payload hashes. Timestamps and transport IDs are excluded.

### Causal references

Cross-stream references use strict values rather than loose IDs:

```text
{ streamType, streamId, revision, eventId, payloadSha256 }
```

A Plan revision references the exact Goal revision it implements. Step completion evidence references durable Run events or immutable Artifacts（产物） by Run ID, event sequence, artifact ID and content hash. A completion proposal references the Plan revision and mandatory evidence set evaluated by the Steward（大管家）.

Deleting or rebuilding a projection cannot invalidate these references. Missing, mismatched or future references fail closed.

### Run pin validation

Before accepting `run.start` with non-null Goal or Plan references, Runtime must read the workspace journal and verify:

- the Goal and Plan exist in the initialized workspace;
- the requested revisions exist and pass replay validation;
- the Plan belongs to the referenced Goal;
- the Goal/Plan project scope permits the pinned project and resources;
- terminal or superseded state is compatible with the requested Run;
- the canonical revision hashes match the pin contract.

Validation happens before `run.created` is appended. A missing or incompatible reference returns a typed rejection and writes no Run event. A Run never follows a later Plan revision silently; a changed revision requires a new Run identity.

### Projection rebuild

Goal lists, Plan progress, session current-goal state and desktop UI summaries are disposable Projections（投影）, not authorities. Each projection stores the last applied `workspace_sequence`. It must be rebuildable from sequence zero and must produce the same canonical state and hashes as incremental replay.

Projection rows may be deleted and regenerated without changing aggregate history. Startup verifies projection schema/version compatibility. Unknown events, sequence gaps or hash mismatches stop the affected projection and surface a typed repair state; the UI must not fabricate progress from chat text or activity labels.

### Migration

The workspace journal is introduced by a new migration and does not rewrite existing `runtime_events`. Existing Runs with null Goal/Plan pins remain valid. Existing non-null pins are historical references only and are not upgraded into invented Goal/Plan content.

If legacy application data contains enough authoritative Goal/Plan material, a separate importer may create provenance-labelled imported streams. Ambiguous legacy data is quarantined for review. Migration must be restart-safe, checksummed and idempotent.

### Security boundary

The journal stores structured intent, constraints, statuses and hashes, but not Provider credentials, hidden chain-of-thought, raw system prompts or unrestricted filesystem paths. User-visible rationale and acceptance evidence are allowed; private model reasoning is not.

All commands are checked against workspace, project, session, Agent role and Free/Assist（自由/协助） permissions. Child Agents may report step evidence but cannot complete the parent Goal. Goal/Plan persistence does not grant filesystem or project-write authority; those capabilities remain governed by Tool Policy（工具策略）, permission leases, Change Sets（变更集） and Validator（校验器） boundaries.

## Consequences

- Goal and Plan state can survive process restart and span multiple Runs without weakening Run isolation.
- Revision conflicts become explicit and auditable.
- Run provenance can prove both its pinned references and the existence of the referenced revisions.
- Desktop progress UI can be rebuilt from authoritative events.
- A second journal, command service, aggregate replay layer and projection pipeline must be implemented and tested before Goal/Plan can be labelled live.
- Cross-journal evidence references add validation work; they are preferred to merging lifecycles into one ambiguous stream.

## Alternatives Rejected

### Store Goal and Plan events in the creating Run stream

Rejected because Goal lifetime exceeds one Run, later Runs would not share one concurrency boundary, and recovery would require searching and merging unrelated Run streams.

### Extend the existing journal with nullable `run_id`

Rejected because it weakens current Run invariants, complicates primary keys and idempotency rules, and risks regressions in an already tested execution journal.

### Store only current Goal and Plan rows

Rejected because overwritable rows lose revision history, causal evidence and deterministic replay. They may exist only as rebuildable projections.

### Store Goal and Plan in session messages or Markdown files

Rejected because conversation text and files do not provide atomic revision checks, typed status transitions, stable causal references or authoritative completion rules.

### Use one global journal for every workspace

Rejected for the first implementation because it enlarges corruption and contention scope and complicates workspace export, deletion and recovery. Workspace-local journals preserve isolation while retaining deterministic ordering inside the ownership boundary.
