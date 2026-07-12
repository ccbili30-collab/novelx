# Runtime V2：Provider Dispatch 恢复审计

日期：2026-07-13

## 结论

当前 ProviderAttempt（模型调用尝试）已经具备保守的防重复收费边界，但尚无完整自动恢复执行器：

- `Requested`：请求定义已落盘，尚未跨越 HTTP 边界，可以安全续发。
- `Sent` / `OutcomeUnknown`：可能已经到达 Provider，禁止自动重试。
- `Responded`：完整响应已落盘，只允许本地投影，不再请求 Provider。
- `Failed(retryable=true)`：能识别可重试，但尚未实现新 Attempt、持久退避、累计延迟和截止时间调度。

`provider.sent` 当前在真正调用 HTTP 之前写入。这会把“写完 sent 后、进入网络调用前崩溃”保守地归为结果未知。它可能造成不必要的人工调和，但不会造成自动重复收费。没有 Provider 服务端幂等或结果查询能力时，这一保守选择不能被本地猜测替代。

## 本批代码变化

- 将原本含义模糊的 Provider dispatch 动作细分为 `PersistedProviderAttemptDispatch`（已持久化模型尝试分发）。
- 动作固定以下证据：
  - invocation ID
  - attempt ID
  - inference ID
  - context compilation ID
  - attempt number
  - Provider identity
  - canonical context hash
  - transport payload hash
  - Agent Loop checkpoint hash
  - Provider Attempt aggregate sequence
- `Requested` 只有在上述身份与当前 Agent Loop 和 Run 完全一致时才产生该动作。
- 该动作进入独立的 `ProviderDispatchReady` gate（模型分发就绪门），不会被 local-only Supervisor 当成本地投影。
- Recovery Repository、Claim Service 和 Execution 已支持独立的 `ProviderDispatch` effect class（模型分发副作用等级）；只有完整动作规格与该 gate 匹配时才允许领取和启动。

## 下一执行协议

Provider Dispatch Supervisor（模型分发监督器）必须：

1. 使用已经建立的独占 Claim、Execution 和 `ProviderDispatch` effect class 驱动真实分发。
2. 重启时再次核对 Attempt：
   - 仍是 Requested 才允许续发；
   - Sent/OutcomeUnknown 立即转入结果未知调和；
   - Responded 只完成持久结果并交给本地投影；
   - Failed 根据真实 retry policy 创建新 Attempt，不能复用旧 Attempt。
3. 在任何自动重投 Sent 之前，要求该 Provider 的服务端幂等或结果查询能力经过正式 profile 验证。
4. 不得把 NovelX 内部 `inference_idempotency_key` 当作 Provider 已支持外部幂等；当前 Gateway 尚未发送该键。

## 最大不确定性

不同 Provider 是否承诺 chat completions 请求幂等或提供按请求 ID 查询结果，必须逐 Provider 依据正式文档和真实故障测试确认。在此之前，DeepSeek 等 OpenAI-compatible（兼容 OpenAI 协议）接口不能因“兼容”二字被假定支持相同的幂等语义。

本批没有实现 Provider 自动续发，因此不能宣称 Provider Dispatch 恢复闭环完成。
