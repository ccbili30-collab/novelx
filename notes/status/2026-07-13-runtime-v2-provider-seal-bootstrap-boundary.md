# Runtime V2 Provider 封口与数据库 Bootstrap 边界

日期：2026-07-13

## 本批完成

- 删除 `ProviderInferenceService` 的 legacy unsealed compatibility（旧版未封口兼容）执行、准备、发送和终态写入链。
- 删除 `ProviderGateway::infer`、`infer_prepared`、`infer_prepared_cancellable`；真实推理 HTTP 只能经过持久化 `provider.sent`、move-only Provider Effect Capability（一次性模型副作用能力）和授权执行内核。
- `execute_http_dispatch` 已收窄为 `ProviderGateway` 私有内核，只能由授权入口调用。
- Runtime 初始化先取得 sidecar lease（旁路租约）。数据库不存在时只以 `create_new(true)` 排他创建空文件并同步；随后立即 consuming bind（消耗式绑定）。已有数据库则先绑定文件身份。只有绑定成功后才允许 `EventJournal::open`、迁移、WAL 和恢复。
- 数据库检查、创建、同步和绑定失败均有类型化初始化错误，失败路径不会发送 `runtime.ready`。

## 测试迁移清单

以下 integration fixture（集成测试夹具）仍调用已删除的旧入口，必须改为完整 capability 授权链，不能通过重新公开 legacy API 修复：

- `runtime/crates/novelx-runtime/tests/provider_inference.rs`
- `runtime/crates/novelx-runtime/tests/provider_inference_service.rs`
- `runtime/crates/novelx-runtime/tests/provider_dispatch_recovery_service.rs`
- `runtime/crates/novelx-runtime/tests/provider_dispatch_recovery_supervisor.rs`

## 明确未完成的 P1

`EventJournal`（事件日志）和 `ArtifactStore`（产物存储）的公开写方法仍是 Trusted Internal Storage Boundary（受信任内部存储边界）：权限在上层 Runtime Service（运行服务）进入存储前检查，而不是由低层存储方法强制接收 capability。

因此当前只能宣称已封住生产 Provider HTTP/terminal 旁路并修正启动顺序，不能宣称 crate-wide capability enforcement（整个 crate 范围的能力强制）。后续 P1 必须把 Bound Workspace Capability（绑定工作区能力）下沉到所有低层 append/put/transaction 写入口，并迁移全部调用方。

## 本批验收证据

- `cargo check -p novelx-runtime --lib`
- `cargo check -p novelx-runtime --bin novelx-runtime`
- `cargo test -p novelx-runtime --test handshake initializes_an_empty_database_with_zero_recovered_runs -- --exact --nocapture`
- `cargo test -p novelx-runtime --test handshake only_one_runtime_process_can_own_a_workspace_database -- --exact --nocapture`
- `cargo test -p novelx-runtime --test handshake damaged_storage_emits_initialization_failed_without_ready -- --exact --nocapture`
