# Runtime V2 Authorized Recovery Killpoints（第二版运行时授权恢复进程终止故障点）

日期：2026-07-13

## 本批完成

- 既有真实 Runtime 子进程 + loopback HTTP（本机回环 HTTP）验收已从 legacy Sent v1（旧版已发送事件版本 1）切换到授权派发故障点：
  - `provider_attempt.authorized_sent_before_http`
  - `provider_attempt.authorized_response_before_terminal`
- 新增 `provider_dispatch.responded_before_recovery_outcome`，精确停在 `provider.responded` 已持久化、Operational Recovery outcome（操作恢复结果）尚未提交的窗口。
- 故障点只在 `runtime-test-failpoints` 测试特性中编译；release（发布）构建继续由现有编译屏障拒绝该特性。
- killpoint（进程终止故障点）资料改为通过正式 `ContextCompileService`（上下文编译服务）写入来源命令和规范化上下文，不再手写过时的 `context.compiled` 事件。
- 每个授权派发测试都审计 `provider.sent`：必须为 `eventVersion = 2`，Grant Receipt（授权凭证）必须通过校验，并精确绑定 Recovery operation/execution/action/fencing/revision/hash（恢复操作、执行、动作、栅栏、修订与哈希）。OriginalOwner（原所有者）与 ResumeAuthorized（恢复授权者）分别对照持久化执行或授权证据。
- Runtime（运行时）的 `runtime.hello`、`runtime.ready`、`provider.bound`、`runtime.stopped` 四类响应全部改由独立 stdout reader（标准输出读取线程）接收，并受 10 秒硬超时约束。
- 响应超时、stdout 关闭、协议解码失败或 reader（读取线程）异常都会先 `kill + wait`（终止并回收）子进程，再等待 stdout/stderr reader 退出并输出 ExitStatus（退出状态）与完整 stderr（标准错误）诊断；不会依赖测试栈展开后才清理。
- `RuntimeProcess::Drop` 和显式 `kill_exact` 仍保留兜底终止与回收；Windows 继续使用 `CREATE_NO_WINDOW`，loopback Provider（本机回环模型服务）线程也有显式停止与回收路径。

## 已验证的故障窗口

1. Authorized Sent before HTTP（授权已发送、HTTP 前）
   - 终止前：`provider.sent v2` 已持久化，真实 HTTP 次数为 0。
   - 重启后：Operational Recovery 投影为 `OutcomeUnknown`（结果未知），HTTP 仍为 0，永不重发。
2. Authorized response before terminal（授权响应已返回、终态前）
   - 终止前：真实 HTTP 次数恰好为 1，持久证据仍停在 `provider.sent v2`。
   - 重启后：投影为 `OutcomeUnknown`，HTTP 总次数仍为 1，永不重发。
3. Responded before recovery outcome（模型响应已持久、恢复结果前）
   - 终止前：`provider.responded` 已持久化，恢复 operation outcome（操作结果）为空。
   - 重启后：零新增 HTTP，恢复结果投影为 `Succeeded`（成功），Agent Loop（智能体循环）完成。
4. Execution started（执行已开始）与 recovery persisted before Host response（恢复已持久、宿主响应前）历史窗口仍通过，分别验证一次真实发送和丢失宿主确认后的幂等恢复。

## 验证证据

- `cargo test -p novelx-runtime --features runtime-test-failpoints --test provider_recovery_killpoints -- --test-threads=1`：连续 3 轮均为 5/5 通过。
- `cargo clippy -p novelx-runtime --features runtime-test-failpoints --test provider_recovery_killpoints -- -D warnings`：通过。
- `cargo fmt --all -- --check`：通过。
- 历史 Sent v1（旧版已发送事件）零网络兼容未删除，并重新定向验证：
  - `provider_dispatch_recovery_supervisor::old_owner_sent_execution_is_closed_unknown_without_network`：通过。
  - `provider_dispatch_recovery_service::sent_attempt_is_evidence_first_and_never_requires_provider_binding_or_network`：通过。

## 尚未完成，不能算完整闭环

- 本批只覆盖 Provider dispatch recovery（模型派发恢复）的三个关键进程终止窗口，不等于完整的进程终止矩阵。
- Attempt 2 的普通 Service/Supervisor 授权恢复已经在相邻批次验证，但它的进程终止窗口、`Retry-After` 和持久退避压力测试尚未完成；Attempt 3 及以上仍安全隔离。
- Recovery cancellation（恢复取消）的真实宿主取消源与 Sent 前/后取消故障验收不在本批；目前启动恢复仍使用保持开放的本地 cancellation receiver（取消接收器）。
- Legacy Provider network entries（旧版模型网络入口）尚未全部移除，Gateway（网关）仍未完全封口。
- Agent Loop Host Lifecycle（智能体循环宿主生命周期）、oh-my-pi 审计、长期记忆、图谱检索和 Electron 工作台仍未完成。

## 完成边界

本批完成的是“授权 Operational Recovery 的三个要求窗口可被真实进程终止并安全恢复”的验收闭环，不是完整 Harness（运行框架）闭环。
