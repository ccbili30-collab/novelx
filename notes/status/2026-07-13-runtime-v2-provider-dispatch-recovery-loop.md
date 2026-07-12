# Runtime V2 Provider Dispatch Recovery Loop

Date: 2026-07-13

## Completed

- Added a dedicated `ProviderDispatchResumeAuthorization` ledger instead of expanding the local-projection resume permission.
- Authorization binds operation, Execution, Claim, fence, action, Attempt state/sequence/definition/evidence, derived capability, previous generation and current exclusive Runtime owner.
- Authorization generations are monotonic: sequence/time rollback, same-sequence evidence mutation and terminal-to-Requested rollback are rejected.
- Added an evidence-stable authorization service using the workspace global event clock and CAS.
- Recovery supports the exact state matrix:
  - `Requested`: one authorized Provider dispatch;
  - `Sent / OutcomeUnknown`: zero-network unknown reconciliation;
  - `Responded`: zero-network success completion;
  - `Failed`: zero-network safe-failure completion.
- Added a Provider Dispatch Supervisor that scans, records, claims, starts, transfers expired unstarted claims, resumes old-owner Executions and consumes typed recovery receipts.
- Temporary missing Provider binding keeps `Requested` waiting. It neither writes `FailedSafe` nor marks the reusable deterministic operation stale.
- The local projection Supervisor now refuses Provider/Tool execution classes and leaves them to their effect-specific supervisors.
- Unified every in-process Provider Attempt entry behind one process-wide single-flight guard keyed by canonical database path, Run and Attempt. Normal inference, split dispatch, Live Agent Loop and recovery cannot concurrently own one Attempt.
- `provider.bind` now runs local recovery, Provider dispatch recovery and then local persisted-result projection before publishing the refreshed operational state.
- Added a real runtime-subprocess handshake test: old-owner Started Requested -> new Runtime initialization -> Provider bind -> one local TCP request -> Responded -> dispatch Succeeded -> Agent Loop projection Completed. Rebinding and a full second restart make zero additional requests.

## Verification

- Rust workspace tests: passed.
- Rust workspace Clippy with `-D warnings`: passed.
- Provider dispatch recovery tests: 14/14.
- Provider dispatch Supervisor tests: 7/7.
- Provider inference tests: 14/14.
- Provider resume aggregate tests: included in 21/21 operational recovery aggregate tests.
- Runtime subprocess recovery handshake: 1/1, additionally repeated eight times after fixing the Windows nonblocking-socket test race.
- TypeScript typecheck: passed.
- Vitest: 85 files passed, 1 skipped; 406 tests passed, 10 skipped.

## Failures found and fixed during end-to-end verification

1. Startup local recovery attempted to resume a Started Provider dispatch with the local-only permission and failed before `runtime.ready`. The local Supervisor now checks the exact effect class first.
2. Recovery and the normal Provider path had separate in-memory locks. A recovery caller could observe another request's in-flight `Sent` and prematurely write `OutcomeUnknown`. All Provider paths now share the same Attempt guard.
3. The Windows loopback test listener used a nonblocking accepted socket and intermittently failed with `WSAEWOULDBLOCK`. The accepted socket is explicitly returned to blocking mode before reading; the test passed eight consecutive runs and the full suite.
4. An unstarted Provider Claim was marked stale when credentials were temporarily absent. The Supervisor now keeps it waiting so the same deterministic operation remains usable after binding returns.

## Explicitly unfinished

- No real process kill-point matrix yet at: after Requested, after ExecutionStarted, after `provider.sent`, after HTTP response but before `provider.responded`, and after recovery outcome but before Host response.
- `Sent / OutcomeUnknown` cannot be auto-retried without a verified Provider-side idempotency or result-lookup capability.
- `Failed(retryable=true)` has no durable backoff, parent Attempt link or new Attempt scheduler.
- Workspace lease identity still relies on a caller-visible instance ID; a persisted non-reusable lease epoch is not yet included in Claim/Execution/authorization identities.
- Provider dispatch passes run synchronously during recovery refresh; concurrency budgets and nonblocking background scheduling are not implemented.
- Typed blocked diagnostics are not yet stored as Artifact records.
- Tool dispatch recovery, oh-my-pi audit, context compaction, long-term memory, graph retrieval, NovelX domain Agents and desktop Artifact projections remain incomplete.

## Completion boundary

This checkpoint closes the Requested-only Provider dispatch and cross-process authorization path under the current workspace-lease contract. It does not close Provider uncertainty, retry scheduling, Tool effects or the full NovelX Harness goal.
