# Runtime V2 Provider Lease Epoch and Kill-point Matrix

Date: 2026-07-13

## Completed

- `WorkspaceRuntimeLease` now separates the caller-visible diagnostic label from authority. Every successful operating-system lock acquisition creates a fresh UUID lease epoch, and that epoch is the persisted recovery owner ID.
- Lock metadata schema version 2 stores the owner epoch, diagnostic label, process ID and acquisition time. Dropping and reacquiring the lock with the same label produces a different authority.
- `OperationalRecoveryRepository::claim`, `renew_lease`, `start_execution` and `finish_execution` require the live lease object.
- Claim, renewal and start require the exact current Claim owner epoch.
- Execution finish requires either the exact original execution owner, the exact latest local Resume owner for persisted Provider-result projection, or the exact latest Provider-dispatch authorization owner. The two recovery protocols cannot authorize each other.
- Added same-label regressions for old Claim reuse, local Resume reuse and Provider authorization reuse.
- Added feature-gated Runtime failpoints at:
  1. Provider dispatch execution persisted while Attempt remains Requested.
  2. `provider.sent` persisted before HTTP begins.
  3. A real HTTP response received before terminal Attempt evidence is persisted.
  4. Provider recovery and local projection persisted before `provider.bound` reaches the Host.
- Tests spawn the real Runtime binary, wait for a durable one-time marker, kill that exact child process, restart on the same SQLite workspace, bind a real local HTTP Provider and verify request counts plus persisted terminal state.
- `runtime-test-failpoints` is disabled by default and rejected by a compile-time error in release builds.

## Verified behavior

- Requested/ExecutionStarted crash: restart performs exactly one HTTP request and completes the Attempt, recovery operation and Agent Loop.
- Sent-before-HTTP crash: restart performs zero HTTP requests and closes recovery as `OutcomeUnknown`; it never guesses that re-sending is safe.
- Response-before-terminal crash: the original request count remains one and restart does not send again; missing durable response evidence remains unknown.
- Recovery-before-Host-response crash: Attempt, recovery outcome and Agent Loop are already terminal; restart and rebind make no second request.
- Full Rust workspace tests passed.
- Full Rust workspace Clippy with `-D warnings` passed.
- Kill-point suite passed 4/4 once and 40/40 over ten consecutive runs.
- TypeScript typecheck passed.
- Vitest passed 85 files with 1 skipped; 406 tests passed with 10 skipped.
- The release failpoint guard failed compilation for the expected explicit reason.

## Failure found during verification

The initial stress run intermittently exited with Windows status `0xc0000409`. This was not a Runtime recovery-state failure. The test's nonblocking listener produced an accepted socket that could return `WSAEWOULDBLOCK`; the provider thread panicked, and a second panic during cleanup aborted the test process. The accepted socket is now explicitly blocking, its read has a timeout, and cleanup does not panic again while another panic is already unwinding.

## Not completed

- NovelX has no verified external Provider idempotency or result-lookup capability, so `Sent / OutcomeUnknown` is still never automatically retried.
- `Failed(retryable=true)` still lacks a durable retry scheduler, new Attempt lineage, deadline/backoff accounting and `Retry-After` capture.
- Provider recovery remains synchronous during bind; concurrency budgets and background scheduling are not complete.
- Tool dispatch recovery, oh-my-pi audit, context compaction, long-term memory, graph retrieval, domain Agents and Electron projections are still unfinished.

## Completion boundary

This batch closes the workspace-owner ABA gap and the four selected Provider crash boundaries. It does not close the full Provider retry/reconciliation problem or the NovelX Harness goal.
