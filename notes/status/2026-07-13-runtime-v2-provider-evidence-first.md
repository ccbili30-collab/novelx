# Runtime V2：Provider 恢复证据优先

日期：2026-07-13

## 修复

ProviderInferenceService（模型推理服务）过去在检查已持久化 Attempt（尝试）之前，会先加载 Context（上下文）、解析当前 Provider 绑定和准备网络请求。结果已经完整落盘时，恢复仍可能因为凭据未绑定而失败。

现在执行顺序为：

1. 验证 Run 与 pinned Provider identity（固定模型身份）。
2. 优先读取已持久化 Provider Attempt。
3. `Responded` 直接恢复结果，不要求当前 Provider 凭据，也不准备网络请求。
4. `Sent` / `OutcomeUnknown` 直接阻塞调和。
5. `Failed` 返回已持久化终态。
6. 只有 `Requested` 或不存在 Attempt 时，才加载 Context、解析 Provider、重建 transport payload（传输载荷）并准备派发。

恢复 `Requested` 时，会重新核对 inference、invocation、context compilation、canonical context hash、transport payload hash、Provider identity 和 attempt number。任一不一致均返回 `PROVIDER_ATTEMPT_EVIDENCE_MISMATCH`，不会发送请求。

主 Runtime 的 `provider.inference.start` 同样改成先调用 evidence-first prepare（证据优先准备）；只有返回 Dispatch（分发）时才解析敏感 Provider 凭据。

## 验证

- 已持久化 `Responded` 结果在空 ProviderRegistry（无模型绑定）下成功恢复。
- Provider inference service 与真实 handshake 聚焦测试通过。

## 未完成

该修复让已知结果真正做到 evidence-first，但尚未实现 `Requested` 的自动恢复监督器，也没有改变 `Sent` 的禁止自动重试规则。
