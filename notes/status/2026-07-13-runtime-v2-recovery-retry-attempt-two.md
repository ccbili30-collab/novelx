# Runtime V2 Recovery Retry Attempt Two（恢复重试第二次尝试）

Date: 2026-07-13

## Implemented

- Fixed Operational Recovery Scanner（运行恢复扫描器）so a legitimate failed Attempt 1 plus Requested Attempt 2 is not automatically classified as conflicting evidence.
- Attempt 2 is executable only when Agent Loop pending origin, Retry aggregate, Schedule（调度）, Binding（绑定）, parent failure definition/evidence, current Attempt and Provider/Context identities all agree.
- Multiple Provider Attempts without authoritative Retry lineage remain quarantined.
- Requested Attempt 2 passes through Supervisor -> Recovery issuer -> authorized Sent v2 -> real loopback HTTP -> terminal persistence -> Recovery outcome.
- Responded or Failed Attempt 2 with a missing Recovery outcome is projected through Supervisor with zero additional HTTP.
- Attempt 3 and above are explicitly rejected until every historical Retry observation can be matched against its real Provider Attempt evidence.

## Verification

- Operational Recovery Scanner: 11/11 passed.
- Provider Dispatch Recovery Service: 19/19 passed.
- Provider Dispatch Recovery Supervisor: 7/7 passed.
- The positive Attempt 2 path performs exactly one HTTP request and persists a valid Retry-bound Provider Effect grant.
- Terminal re-entry and Responded/Failed before-outcome recovery perform zero HTTP requests.
- A real Attempt 3 chain is quarantined, proving the current fail-closed boundary.
- Clippy with `-D warnings`, Rustfmt and `git diff --check` passed.

## Explicitly Unfinished

- Attempt 3+ is unavailable, not implemented. This is a deliberate safety degradation, not a complete Retry V2 implementation.
- Scanner and Recovery issuer repeat part of the Retry evidence validation. They must converge on one shared read-only lineage validator.
- Scanner currently converts several Retry evidence recovery errors into a generic conflict classification; typed diagnostics remain incomplete.
- Retry killpoints, Retry-After and persistent backoff pressure tests remain unfinished.

## Completion Boundary

This batch closes authorized Operational Recovery for Attempt 2 only. It does not complete automatic Provider Retry V2.
