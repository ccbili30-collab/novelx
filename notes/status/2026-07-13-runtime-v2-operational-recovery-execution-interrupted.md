# Runtime V2 Operational Recovery Execution Interrupted

日期：2026-07-13

## 本批完成

- 在 `operational_recovery`（运行恢复）权威聚合中加入
  `execution_interrupted`（执行已中断）审计事件。
- 事件显式固定：
  - Workspace（工作区）、Run（运行）、Operation（恢复操作）、Execution（执行）和
    Provider Attempt（模型调用尝试）身份；
  - Claim（所有权声明）、owner、fencing token（隔离令牌）、source fingerprint
    （来源指纹）和 action hash（动作哈希）；
  - Attempt revision（尝试修订）、definition hash（定义哈希）和 evidence hash
    （证据哈希）；
  - cancellation cause（取消原因）、`transportBoundaryCrossed=false`、是否可恢复；
  - 当前 Workspace lease（工作区租约）的 owner 与 epoch（租约世代）。
- 事件是非 Outcome（非结果）事件：不会写入 `Succeeded`、`FailedSafe`、
  `OutcomeUnknown`，不会把 Run 写成 cancelled（已取消），也不会关闭恢复操作。
- `OperationalRecoveryRecordingService`（运行恢复记录服务）会在一个全局序列快照内
  重新读取权威 Execution 与仍处于 `Requested` 的 Provider Attempt；Attempt 已经跨过
  Sent（已发送）边界时拒绝记录 pre-Sent（发送前）中断。
- `ProviderDispatchRecoverySupervisor`（模型派发恢复监督器）收到
  `InterruptedBeforeSent` 后，必须先成功持久化该事件，才把中断结果返回给上层。
- 回放继续使用原有 append-only（只追加）哈希链；事件字段被篡改会使严格回放失败。

## 幂等与多次真实中断

`interruption_id`（中断标识）由以下稳定事实派生：Execution、Attempt 证据、取消原因和
Workspace lease epoch；记录时间不参与标识。

- 同一租约、同一取消信号、同一 Execution/Attempt 证据的重复持久化，即使调用方重试时
  产生了稍晚的记录时间，也命中同一标识，不新增事件，并保留第一次成功写入的时间。
- 同一 Execution 后续发生新的真实中断时，新进程会取得新的 lease epoch；不同取消原因
  也会生成不同标识，因此可以追加新的审计事件。
- 当前 cancellation hub（取消中心）的信号是 sticky（粘性）的；同一进程在同一粘性信号下
  重跑 Supervisor 不被伪装成新的中断。

## 验证证据

- `operational_recovery_aggregate`：25/25 通过。
- `operational_recovery_recording_service`：3/3 通过。
- `provider_dispatch_recovery_supervisor`：9/9 通过，其中发送前 shutdown（关闭）测试使用
  真实 loopback HTTP（本机回环 HTTP），验证 0 次请求、Attempt 保持 `Requested`、事件已持久化。
- 另有跨 owner（所有者）恢复测试：旧 Runtime 已开始的 Requested Execution 由新租约先取得
  Provider resume authorization（模型恢复授权），随后在 0 HTTP 下持久化中断；事件同时保留旧
  Execution owner 与新 recorder lease epoch（记录者租约世代）。
- 新增测试覆盖：精确幂等、同一 Execution 的不同真实中断、非终态保持、租约与证据固定、
  payload（载荷）篡改后的哈希链拒绝。

## 未完成与边界

- 本批没有修改 `main` 或 `RuntimeActor`（运行时 Actor）；shutdown、EOF（输入结束）和
  Host disconnect（宿主断开）是否真实送入 cancellation hub 由后续控制面接线负责。
- `run.cancel`（取消运行）仍没有 durable cancel intent（持久取消意图）和
  `CancelledSafe`（安全取消）终态；本批只定义其审计语义为不可自动恢复，不能据此宣称
  业务取消已经闭环。
- 本批没有实现 UI（用户界面）展示、运行时 drain（排空）或桌面端恢复提示。
- 因此这只是 ADR-0016 的审计事件闭环，不是完整 Host cancellation（宿主取消）闭环。
