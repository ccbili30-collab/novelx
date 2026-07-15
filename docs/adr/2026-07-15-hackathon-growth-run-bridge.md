# Growth Run Bridge: one bound Cycle / one Agent Run

Date: 2026-07-15

## Decision

Growth orchestration remains Main-authoritative. `GrowthRunLifecycle` creates an
internal binding only after `GrowthRepository` validates a planned Cycle, its
pinned input checkpoint, rule revision, and authorized scope. The binding is
sent to the Agent Worker as an internal, versioned capability; it is not a
Renderer input and is not chosen by the model.

For a bound Run, `retrieve_graph_evidence` uses the explicit `growth_v1` input
shape. Model arguments may select a query, aliases, seed resources, and bounded
retrieval budgets only. Main supplies the Goal, Cycle, Run, branch, checkpoint,
Creator Lens, and authorized scope when it calls `GraphRetrievalService`.
Main persists the resulting Receipt and safe Growth event before returning a
sanitized evidence projection to the Worker.

The existing `propose_change_set` contract and gateway are unchanged. The bound
gateway rejects proposal before a recorded `growth_v1` Receipt. It calls the
original proposal executor once; only a committed Free Change Set can be bound
to the Cycle's output checkpoint. Pending review, blocked, and failed proposals
cannot commit a Cycle.

## Consequences

- A single Cycle has one Main-attached Run and one durable Receipt.
- Legacy retrieval remains structurally unchanged for ordinary Agent Runs.
- Worker-visible Growth evidence excludes raw source locators, hashes, database
  paths, credentials, and mutable audit authority.
- Cancellation and known pre-commit failures terminalize the Cycle without a
  Change Set. Interrupted Runs enter `reconciliation_required`, preserving the
  outcome-unknown barrier. The internal recovery entry performs that transition
  after restart; it can also backfill exactly one missing safe terminal event
  for every terminal Cycle (including an already-proven committed Cycle)
  without inventing a new Change Set.
- Terminal failure metadata is allowlisted rather than a raw Provider or Worker
  error echo: configuration, Provider runtime, Provider protocol, tool, and
  Agent runtime categories remain distinct; unknown codes use the generic safe
  category. Event sequence allocation uses the current maximum sequence plus
  one, so recovery preserves monotonicity even if prior event rows have gaps.
- This is an internal bridge only. It does not implement automatic multi-Cycle
  growth, user mid-Run guidance, Renderer IPC, image generation, or real
  Provider acceptance.
