# Workspace Goal and Plan journal decision

Date: 2026-07-12
Status: architecture decision recorded; implementation not started

## Completed

- Added `docs/adr/ADR-0010-workspace-goal-plan-event-journal.md`.
- Recorded why durable Goal（目标） and Plan（计划） cannot use the Run-scoped EventJournal（运行范围事件日志）.
- Selected an independent Workspace-scoped append-only journal（工作区范围仅追加日志）.
- Defined stream addresses, workspace and stream ordering, business idempotency, optimistic concurrency, causal evidence references, migration behavior, Run pin validation, Projection rebuild（投影重建） and security boundaries.
- Rejected Run-owned Goal streams, nullable-Run retrofits, mutable current-state rows, chat/Markdown authority and one global cross-workspace journal.

## Not completed

- No SQLite migration or schema was added.
- No GoalAggregate（目标聚合） or PlanAggregate（计划聚合） code was added.
- No Runtime command, Electron Supervisor（桌面宿主监督器）, IPC（进程间通信） or UI projection was added.
- `run.start` still validates only the shape of Goal/Plan references; it does not yet prove that referenced revisions exist.
- Existing in-memory `submit_steward_plan` remains a Run-local execution guard and is not the durable Plan described by the ADR.

Goal/Plan therefore remain non-live product contracts. The next implementation must begin with journal migration and replay tests, then add aggregates and commands before wiring Run pin validation or desktop UI.
