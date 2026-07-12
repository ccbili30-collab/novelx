# Runtime V2：Provider Dispatch 独立副作用门

日期：2026-07-13

## 本批完成

- 新增 `ProviderDispatchReady`（模型分发就绪）恢复门。
- 只有状态仍为 `Requested`，且 Attempt、Inference、Context、Provider、载荷哈希、Agent Loop 检查点和序号全部匹配时，Scanner 才产生该门。
- Recovery Claim（恢复声明）校验 gate 与完整 action spec（动作规格）相符，不能用本地投影动作领取模型分发，也不能反向冒用。
- 新增 `ProviderDispatch` effect class（模型分发副作用等级）。
- Claim Service 提供独立的 `claim_provider_dispatch_ready`，普通 local-only claim 不能领取该操作。
- `start_claimed` 根据持久化动作派生 effect class，调用方不能伪造。
- UI guard（界面守卫）获得独立错误码与用户安全提示。

## 验证

- Requested Attempt 被扫描为 `ProviderDispatchReady`。
- 使用专用入口领取后，Execution 的 effect class 为 `ProviderDispatch`。
- local-only Supervisor 仍只处理 `RecoveryReady`，不会发送 Provider 请求。

## 未完成

- 尚未实现异步 Provider Dispatch Supervisor 的真实 HTTP 执行和终态收口。
- 尚未实现 Provider Dispatch Execution 在重启后的 Requested-only resume（仅未发送续接）。
- Sent/OutcomeUnknown 仍必须人工调和，不能自动重投。
