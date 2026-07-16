# Growth Illustration Queue

## 负责

- 将已编译、来源绑定的 Illustration Plan（插图计划）完整持久化为 Request、Batch 和 Item。
- 固定每批最多 20 项、执行并发 1，但不限制 Request 总量。
- 每项通过既有 `generate_image` Gateway（网关）与 Image Job/Asset（图片任务/资产）权威链执行。
- 从持久 Item、Job、Asset 和当前 source version 恢复状态；来源变化时把旧 Item/Asset 标记为 `stale`。
- 未发送的中断 Job 可重排队；已发送但结果未知的 Job 进入 `reconciliation_required`，不得自动重试收费。

## 不负责

- 不决定 Canon（正式事实），不创造图片事实，不读取 Renderer 状态。
- 不保存凭证；Item 只保存编译 Prompt 哈希，Image Job 沿用既有受管 Prompt 持久化。
- 不展示 UI，也不把 Fixture（测试夹具）称为 Live（真实运行）。

## 修改入口

- 队列编排：`growthIllustrationCoordinator.ts`
- 重启与来源 currentness：`growthIllustrationRecovery.ts`
- 模型高层规划和默认覆盖：`src/agent-worker/growth/growthIllustrationPlan.ts`
- 持久化不变量：`src/domain/growth/growthRepository.ts`
- Provider 副作用：既有 `workspaceAgentToolGateway.ts` → `ImageGenerationService`

## 定向验收

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-illustration-coordinator.test.ts tests/unit/growth-illustration-plan.test.ts tests/unit/growth-visual-style-policy.test.ts tests/unit/growth-repository.test.ts tests/unit/image-asset-repository.test.ts tests/unit/image-generation-service.test.ts tests/unit/image-workspace-recovery.test.ts tests/unit/workspace-agent-tool-gateway.test.ts tests/unit/agent-process-supervisor.test.ts
npm run typecheck
npm run verify:prompt-publication
npm run build
git diff --check
```

## 冻结边界

- 本模块提供 Main-only（仅主进程）队列入口；Renderer 接入和真实多图 Live 属于后续阶段。
- 不增加公开 IPC、数据库迁移、Provider 协议或产品数量上限。
