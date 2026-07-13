# Runtime V2 Assist continuation handshake（协助续跑握手）

## 完成

- 修复 `tool.authorization.resolve` 启动 continuation 后又立即运行 recovery barrier 的并发竞态。
- 授权决定落盘后先执行 barrier，再准备第二轮推理。
- 新增 `provider.inference.continuation.proposed` event、Host acknowledge command 和 `provider.inference.continuation.accepted` response。
- continuation identity 使用已持久化的第二轮 inference identity；Host 在确认前登记 active continuation，Runtime 收到匹配确认后才调用 Provider。
- continuation terminal 使用 continuationId 关联并执行严格 identity 校验。
- Approve 与 Deny 真实黑盒均收到第二次 Provider 请求；Deny 请求包含 `TOOL_DENIED`。
- Rust 定向测试证明 prepare 阶段不会调用 Provider，只有显式执行 prepared continuation 后请求数才从一变二。
- `AssistContinuationAckProof` 是不可 Clone、不可序列化且字段私有的 move-only（仅移动）能力证明，只能由 Handshake Service（握手服务）在精确核对 pending proposal、identity hash、parent identity 和授权证据后构造。
- Runner 的 continuation HTTP 启动入口必须消费该 Proof；旧 `resume_after_assist` 和无 Proof 的 `run_prepared_assist` 已删除。公开通用 `run` 也会拒绝 requestNumber 大于 1 的已持久化 continuation。
- compile-fail 文档测试证明外部调用方不能伪造 Proof。

## 未完成

- pending proposal 和 acknowledgement 幂等表仍是进程内状态。
- Runtime 重启后尚不能从持久事件重建、重发未确认 proposal。
- 尚未完成强杀发生在 proposed/acknowledged/accepted 各边界的故障矩阵。
- Proposal 尚未拥有覆盖完整 proposal 与全部授权证据的单一 evidence hash；这是 durable restart 冻结债务，本批未扩大处理。
- `AssistContinuationHandshakeService` 当前属于 Trusted Internal Host Boundary（受信任内部宿主边界）：它阻止 Runner 无 Proof 启动，但公开 crate 的受信任内部调用者仍可自行注册并确认一份匹配 proposal。用户冻结后不再下沉重构 crate/Host 身份边界，因此不能宣称具备 crate-wide Host authenticity（全 crate 宿主真实性证明）。

因此本批关闭的是 A2.2 live Assist 验收阻断，不能宣称 durable Assist recovery 已完成。
