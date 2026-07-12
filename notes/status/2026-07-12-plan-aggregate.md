# PlanAggregate（计划聚合）状态

## 本批实现

- 在 `WorkspaceEventJournal`（工作区事件日志）上新增独立 `PlanAggregate`（计划聚合）。
- `planId` 永久绑定 `goalId`，每个不可变 `PlanRevision`（计划修订）记录精确 `goalRevision`。
- 有序步骤保存用途、依赖、分配 Agent（智能体）、能力、预期产物、必需证据、状态和完成证据。
- 每次计划编辑或步骤状态变化生成新修订，旧修订可重启后读取。
- 依赖未完成时禁止启动或完成；完成必须提交满足声明类型的哈希证据。
- expected revision（预期修订）和工作区日志序列共同提供乐观并发控制。
- 每个 checkpoint（检查点）具有 SHA-256 哈希和前一修订哈希链；未知事件、未知版本、损坏载荷、断链或哈希不符均 fail closed（失败关闭）。

## 明确未实现

- 本批没有 Runtime command（运行时命令）、桌面 UI（用户界面）、GoalAggregate（目标聚合）存在性验证、Run evidence（运行证据）跨日志真实性校验。
- 尚未实现 `plan.step_assigned`、`plan.step_blocked`、`plan.superseded` 命令；当前只覆盖创建、修订、启动和带证据完成。
- 因此这只是 Plan 领域地基，不是 Goal / Plan 产品闭环，也不能标记为 live（正式可用）。
