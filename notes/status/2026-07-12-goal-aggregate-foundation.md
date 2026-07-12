# GoalAggregate（目标聚合）地基批次

## 范围

- 基于 `WorkspaceEventJournal（工作区事件日志）` 建立 GoalAggregate（目标聚合）。
- 覆盖 workspace/project/session/owner 身份、目标定义、验收标准、约束、权限模式、状态、证据与 blocker（阻塞项）。
- 使用 expected revision（预期修订号）做乐观并发。
- 领域事件带 SHA-256 前序哈希链；checkpoint（检查点）带独立完整性摘要。

## 当前实现

- 状态：`active`、`completion_proposed`、`completed`、`blocked`、`cancelled`。
- 只有非 child（子级）的 owner agent（所有者智能体）可以完成或取消。
- required criterion（必需验收标准）必须已满足且具备证据；存在 blocker 时不能进入完成态。
- append（追加）后总是从 Journal 重放，不以命令内存状态冒充持久结果。
- 未知事件版本、损坏载荷、事件哈希断链、损坏检查点均 fail closed（失败关闭）。

## 未实现

- 尚未加入 Runtime command（运行时命令）、桌面 UI（用户界面）、Goal/Plan 协调或多 Agent 自动分派。
- 检查点目前是可验证领域对象，尚无独立持久化表和自动压缩策略。
- 尚未实现 Goal 与 Plan、批注、会话分支之间的引用协议。

因此本批只是 Goal 持久聚合地基，不能称为完整 Goal 产品闭环，也不能称为整体 Harness（运行框架）完成。
