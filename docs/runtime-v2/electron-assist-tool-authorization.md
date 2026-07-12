# Electron Assist Tool Authorization Route

Status: Host protocol implemented; Rust `main.rs` dispatch and UI are not implemented.

`RuntimeV2ProcessSupervisor.resolveToolAuthorization(runId, payload)` is the only Electron host API for an Assist decision. It sends `tool.authorization.resolve` and waits for the strictly correlated `tool.authorization.resolved` response. The response must repeat the pending Run, ToolCall and approve/deny decision. Approve requires `authorized` plus an allowed lease for the same ToolCall; deny requires `denied` and no lease. A mismatch is a protocol failure and tears down the Runtime connection.

Tool lifecycle messages are subscriptions, not pending-command responses. `tool.requested`, `tool.authorized`, `tool.running`, `tool.succeeded`, `tool.failed` and `tool.outcome_unknown` are emitted through `subscribeRuntimeEvents` even when they carry the originating command correlation ID. This prevents a valid lifecycle event from being mistaken for an orphan response.

The future UI route must render only structured ToolCall identity, requested scope and public arguments summary. Approve/deny must invoke the Supervisor API once with a durable business idempotency key. The UI cannot manufacture a lease, call a dispatcher directly, widen source scope, or mark a tool running/succeeded. Closing the dialog is not approval.

The black-box contract file uses `NOVELX_TOOLCALL_BLACKBOX_CASES` with comma-separated case IDs. Cases are skipped by default. `core_tools`, `unicode` and `assist` use the real process/Provider driver and therefore fail at the first missing Runtime capability; the remaining cases retain deliberate readiness failures until their scenario setup is implemented. No empty fixture can be mistaken for live acceptance.
