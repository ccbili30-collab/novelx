# Runtime V2 ToolCall Black-Box Failure Matrix

Status: Contract scaffold only; Rust `main.rs` ToolCall dispatch is not implemented.

The reusable `RuntimeV2LoopbackProvider` scripts multiple real HTTP Provider turns and captures exact request JSON. It can verify that a first response requests a tool and that the second request returns a tool result under the original `tool_call_id`, including Chinese filenames and content. It is a test server, not a live Provider or Runtime implementation.

| Case | Required observable result | Duplicate execution rule |
| --- | --- | --- |
| list/read/search/glob/stat success | Tool events persist through requested, authorized, running and succeeded; second Provider request contains exact `tool_call_id` and result artifact | Restart replays success and sends no second filesystem operation |
| Assist authorization | Run/tool remains waiting; no running event or filesystem access before an approved persisted lease | Replayed approval is idempotent |
| Missing verified root | Typed source/permission rejection; no requested tool aggregate and no Provider continuation | No retry until initialization changes |
| Missing Provider | `REAL_GM_PROVIDER_REQUIRED`; no ToolCall execution | No local fallback |
| Outside-root path | Typed path-scope rejection; no read/stat result artifact | Never retry with widened scope automatically |
| Invalid UTF-8 | Typed invalid-text result for text read/search; no replacement-character fabrication | Binary policy must be explicit |
| Scan budget exhausted | Result declares `incomplete` with exact file/byte/character/timeout/result reason | Partial scan cannot be cached as complete |
| Unknown external effect | `tool.outcome_unknown`, non-retryable, reconciliation required | Zero automatic duplicate execution |

The ignored integration contract becomes runnable only after real Runtime dispatch, ToolCall event mapping, permission lease persistence and project-root binding exist. Enabling it before those capabilities would create a fake-live test.
