# Growth Main 路由

本目录承载 Growth（生长）在 Main（主进程）内的可信编排辅助模块。它不拥有模型创作内容、Renderer（渲染层）展示、Domain（领域层）写入规则或公开 IPC（进程间通信）合同。

## 最短阅读路径

| 任务 | 先读 | 相邻权威 |
| --- | --- | --- |
| 启动/恢复一个 Cycle | `../growthRunLifecycle.ts` | `GrowthRepository`、`AgentProcessSupervisor` |
| 自动串行多个 Cycle | `../growthCoordinator.ts` | Goal/Cycle 持久状态与 Coordinator 测试 |
| 修改规则修订 authority | `phases/revision/growthRevisionAuthorityResolver.ts`、`growthRevisionProposalPolicy.ts` | pinned Receipt、Revision bridge/Coordinator 测试 |
| 修改 Longform 自动调度 | `phases/longform/growthLongformCoordinator.ts` | `growthLongformProgress.ts`、Coordinator 测试 |
| 修改 Longform authority/提交边界 | `phases/longform/growthLongformAuthorityResolver.ts`、`growthLongformProposalPolicy.ts` | pinned Receipt、Longform bridge/Gateway 测试 |
| 修改规则修订后的 Closure 衔接 | `phases/revision/growthRevisionClosureSync.ts` | Rule Revision、Closure revision、Coordinator 测试 |
| 修改 Closure/Repair authority | `phases/closure/growthClosureAuthorityResolver.ts` | Closure profile/review/Receipt、Growth bridge 测试 |
| 修改 Repair 对象/关系边界 | `phases/closure/growthRepairTargetPolicy.ts` | pinned checkpoint 身份、唯一关系策略、Repair target policy 测试 |
| 修改 Worker 阶段工具和编译 | `../../agent-worker/growth/README.md` | 对应阶段目录与定向测试 |

## 稳定不变量

- Main 只从持久化 Goal、Cycle、checkpoint、Receipt 和 Domain 投影派生 authority；Renderer 和模型不能提供这些字段。
- authority resolver 只读、失败关闭，不启动 Worker、不写 Cycle、不提交 Change Set（变更集）。
- `growthRunLifecycle.ts` 保留 Run 绑定、Receipt、外部副作用门禁、恢复和终态；阶段 resolver 不拥有这些职责。
- 每个 Cycle 至多绑定一个 Run 和一个原子 Change Set；未知结果进入 reconciliation，不得重试制造第二份副作用。
- 修改 resolver 不应要求修改共享协议、数据库迁移或 Renderer；若需要，说明阶段边界已扩大，必须停止并重新审查。

## 定向验收

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-run-bridge.test.ts tests/unit/growth-longform-progress.test.ts
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-longform-coordinator.test.ts tests/unit/growth-coordinator.test.ts
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-revision-authority.test.ts tests/unit/growth-coordinator.test.ts
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-illustration-coordinator.test.ts tests/unit/growth-illustration-plan.test.ts tests/unit/growth-visual-style-policy.test.ts tests/unit/image-workspace-recovery.test.ts
npm run typecheck
git diff --check
```

这些命令验证 authority/bridge 的确定性边界，不是 Provider（模型服务）Live（真实运行）或全量产品验收。
