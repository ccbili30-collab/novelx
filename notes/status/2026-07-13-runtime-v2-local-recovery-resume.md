# Runtime V2：本地恢复续接与可信完成

日期：2026-07-13

## 本批完成

- 新增 `OperationalRecoveryResume`（运行恢复续接授权）及持久事件。
- 新 Runtime（运行时）只有在持有同一数据库的独占 WorkspaceRuntimeLease（工作区运行租约）后，才能为已开始、未结束的纯本地 Provider（模型服务）结果投影追加续接授权。
- 续接保持原 `execution_id`、Claim、fencing token（围栏令牌）和稳定 Agent Loop（智能体循环）命令键，不生成第二次逻辑执行。
- 每次重启可以追加新的续接授权，但只有最后一位被持久化授权的 resumer（续接者）拥有投影和完成权限。
- Projection Service（投影服务）现在从 Recovery Repository（恢复仓库）读取 Claim、Execution 和完整 action spec（动作规格），不再接受调用方提供动作。
- Projection Service 同时核验数据库租约、Claim/Execution/action hash/effect class 和首次执行者或最新续接者身份。
- 新增 Completion Service（完成服务），从经过哈希校验的投影 manifest（清单）派生 Outcome（结果）；调用方不能直接填写结果哈希或最终检查点。
- 同一 Run（运行）新增单活动恢复操作硬约束，旧 Claim/Execution 未终结时不能领取新操作。

## 崩溃窗口验收

测试覆盖：

1. 旧 Runtime 创建 Claim 并开始 Execution。
2. 已持久化 Provider 结果完成本地 Agent Loop 投影。
3. 模拟在写入 Recovery Outcome 前进程退出并释放工作区锁。
4. 新 Runtime 获得独占锁并写入 Resume authorization（续接授权）。
5. 使用相同 execution ID 和命令键重建完全相同的投影 manifest。
6. Completion Service 写入 Succeeded（成功）；重复完成保持同一 revision（修订），不产生第二个结果。

## 安全边界

- 本路径仅允许 `PersistedProviderResultProjection`（已持久化模型结果投影）。
- 不发送 Provider 请求。
- 不执行 Tool（工具）。
- 工具调用只允许落盘参数 Artifact（产物）并把 Agent Loop 推进到等待工具结果。
- 旧 Claim owner 不能被新 Runtime 冒用；重启必须走显式 Resume authorization。

## 明确未完成

- 自动 Supervisor（监督器）还没有把 scan、record、claim、start、project、finish 串成运行循环。
- `recover_if_last_command` 当前依赖恢复投影仍是 Agent Loop 的最后事件；后续应升级为按命令键恢复该事件时的检查点。
- Provider Dispatch（模型请求分发）与 Tool Dispatch（工具分发）恢复未实现。
- 尚未完成全部故障矩阵和真实进程杀死测试。

因此本批闭合了一个具体的本地投影崩溃窗口，但不等于完整 Operational Recovery（运行恢复）闭环。
