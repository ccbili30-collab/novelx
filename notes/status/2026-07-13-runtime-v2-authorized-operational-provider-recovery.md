# Runtime V2 Authorized Operational Provider Recovery（第二版运行时已授权 Provider 操作恢复）

日期：2026-07-13

## 本批完成

- `ProviderDispatchRecoveryService` 的 `Requested` 恢复分支不再调用 legacy（旧版）`execute_guarded -> provider.sent v1 -> infer_prepared` 网络路径。
- OriginalOwner（原始所有者）和 ResumeAuthorized（恢复授权者）统一通过 `ProviderRecoveryEffectAuthorizationService` 签发一次性 Provider Effect Capability（Provider 副作用能力）。
- 唯一允许的恢复派发顺序为：
  `authorize_recovery -> arm_authorized_dispatch -> dispatch_authorized_attempt -> finalize_authorized_attempt_in -> finish_from_attempt`。
- `Arc<WorkspaceRuntimeLease>`（共享工作区运行租约）从 Supervisor（监督器）原样传入 Service（服务）、Issuer（签发器）、Capability（能力）和 HTTP 派发结果，避免重建或替换租约身份。
- `Sent / OutcomeUnknown / Responded / Failed` 仍走零网络证据投影；不会重新调用 Provider（模型服务）。
- 终态/已发送投影恢复了进程内 `ProviderAttemptExecutionGuard`（Provider 尝试执行守卫），防止并行 live（实时）请求仍持有 `Sent` 时被恢复线程误判成 `OutcomeUnknown`。
- 删除了已无调用者的 `ProviderInferenceService::execute_guarded` 旧入口。
- service、supervisor、handshake（服务、监督器、握手）测试资料不再手写伪 `context.compiled`；统一通过正式 `ContextCompileService::compile` 生成来源命令、请求哈希、归一化输入和回执。
- 测试明确验证 `provider.sent` 为 eventVersion 2（事件版本 2），grant（授权凭证）可重新校验，且 authority（权威来源）为 OperationalRecovery（操作恢复），覆盖原始所有者和恢复授权者。

## 验证证据

- `cargo test -p novelx-runtime --test provider_dispatch_recovery_service --test provider_dispatch_recovery_supervisor --test provider_dispatch_recovery_handshake -- --nocapture --test-threads=1`
  - Provider recovery handshake（Provider 恢复握手）：1/1
  - Provider dispatch recovery service（Provider 派发恢复服务）：14/14
  - Provider dispatch recovery supervisor（Provider 派发恢复监督器）：7/7
- `cargo clippy -p novelx-runtime --all-targets -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。

## 尚未完成，不能算完整闭环

- Operational Recovery（操作恢复）目前由 Provider bind/startup barrier（Provider 绑定/启动屏障）触发，没有可接入的用户取消信号；本批只能贯穿一个保持开放的 cancellation receiver（取消接收器）。这不是“可取消恢复”，后续必须由 Runtime Host（运行时宿主）提供真实取消源。
- 尚未补 process-kill failpoint（进程终止故障点）矩阵：`authorized_sent_before_http`、`authorized_response_before_terminal`、`Responded before recovery outcome`。
- 尚未补 recovery attempt > 1（恢复重试第二次及以后）通过 Service/Supervisor 的集成验收；当前只有 Issuer（签发器）级重试证据校验。
- Legacy（旧版）普通 Provider 网络入口仍存在于其他兼容调用者，Gateway（网关）尚未完全封口。
- 本批没有修改 AgentLoop Host Lifecycle（智能体循环宿主生命周期）协议，也没有完成多轮 Provider Attempt（Provider 尝试）的宿主事件映射。

