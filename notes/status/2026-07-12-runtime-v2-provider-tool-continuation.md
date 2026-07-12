# 2026-07-12 Runtime V2 Provider tool continuation

Implemented the authoritative OpenAI-compatible（OpenAI 兼容）message representation required for Provider continuation after tool results.

## Implemented

- `ProviderInferenceMessage` can represent an assistant message containing `tool_calls`, and a tool-result message containing `role: "tool"` plus `tool_call_id`.
- Outbound field names are the Provider protocol names `tool_calls` and `tool_call_id`, not the Rust/TypeScript camel-case forms.
- Tool-result messages do not send an unsupported `name` field. Tool-name equality is validated in the Context Compiler before Provider normalization.
- Provider request validation rejects orphan tool results, unfinished tool calls, duplicate Provider call IDs, malformed function arguments and conversational messages interleaved before all tool results arrive. Rejection occurs before HTTP IO.
- RuntimeExchange tool content must carry `providerToolCallId`. An internal ToolCall Aggregate UUID cannot substitute for the original Provider ID.
- RuntimeExchange tool calls also carry `assistantMessageId`. Consecutive calls from the same original assistant response are grouped into one `role: "assistant"` message with a `tool_calls` array, followed by one correlated tool message per result.
- The Context Compiler now accepts one-or-more calls followed by the same number of strictly matched results. Pairing remains strict by Provider call ID, tool name and argument/result hashes.
- Tool-call and tool-result RuntimeExchange items are treated as required context. Context compaction may omit unrelated optional history, but cannot keep only one half of a call/result exchange. If the pair cannot fit, compilation fails closed instead of emitting an invalid transcript.
- Existing persisted normalized messages containing only `role` and `content` still deserialize through default empty tool fields. Existing version-1 Context Compiled events therefore remain recoverable.

## Verification

- `context_compiler`: 8 tests passed.
- `context_compile_service`: 9 tests passed, including rejection when only an internal ToolCall UUID is supplied.
- `provider_inference`: 13 tests passed, including a real loopback HTTP request proving the exact DeepSeek/OpenAI message body and pre-network rejection of invalid pairing.
- `provider_inference_service`: 12 tests passed.
- `provider_inference_protocol`: 5 tests passed.
- `cargo clippy --manifest-path runtime\Cargo.toml -p novelx-runtime --lib -- -D warnings` passed.
- The final full Runtime crate rerun is temporarily blocked by a concurrent coordination-service test that still calls the expanded `fail` API without its new failure-artifact argument. This is outside the continuation files; all continuation-directed suites are green.

## Not completed

- This change does not execute tools.
- Runtime Actor does not yet build RuntimeExchange context items from completed ToolCall Aggregates and persisted result artifacts.
- The continuation scheduler does not yet issue the next Provider inference automatically.
- `assistantMessageId` must be persisted from the original Provider response alongside each materialized call. The current Provider response receipt exposes calls but the end-to-end materializer/continuation handoff still needs to adopt this field.
- No UI or live feature flag is enabled by this work.
