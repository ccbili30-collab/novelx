# Growth Agent Worker 路由

本目录承载 Growth（生长）各创作阶段的模型可见输入与确定性编译器。它不拥有 Goal/Cycle 持久化、Provider（模型服务）调用、Change Set（变更集）提交、Canon（正史）或 Renderer（渲染层）状态。

## 最短阅读路径

| 任务 | 先读 | 相邻权威 |
| --- | --- | --- |
| 修改阶段工具顺序 | `core/growthPhaseRegistry.ts`、`core/growthPhaseHandler.ts` | `stewardExecutionStateMachine.ts` 中的顶层门禁 |
| 修改世界生成 | `growthWorldFragment.ts`、`growthWorldMapBrief.ts` | 世界 Fragment/地图定向测试 |
| 修改故事生成 | `growthStoryBrief.ts`、`growthStoryFragment.ts` | Story Fragment/Brief 定向测试 |
| 修改 OC 生成 | `growthOcFragment.ts` | `creativeRelationPolicy.ts`、OC Fragment 定向测试 |
| 修改证据化自询 | `growthInquiryBrief.ts` | pinned Receipt 与 Inquiry 定向测试 |
| 修改 OC 个人长篇 | `phases/longform/growthLongformPhase.ts` | `growthLongformOutline.ts`、`growthLongformSection.ts`、Longform 定向测试 |
| 修改 Closure/Repair Worker 行为 | `phases/closure/growthClosurePhase.ts` | Closure 阶段测试、顶层原子提交门禁 |
| 修改默认插图规划 | `growthIllustrationPlan.ts` | Image Job/Asset 与来源绑定测试 |

## 稳定不变量

- 模型只提供创作内容；资源 ID、父子关系、依赖、来源绑定和提交结构由编译器确定。
- 每个 Growth Cycle 使用固定 checkpoint、规则修订和 Retrieval Receipt（检索回执）。
- 阶段只能使用 `growthPhaseRegistry.ts` 声明的工具序列；顶层状态机只执行门禁和终态规则。
- 所有正式写入通过一个原子 Change Set；模型不能直接修改 Canon。
- `story` 与 `volume` 都是叙事容器，可作为 `uses_world` / `uses_oc` 的源；`chapter` 不可。唯一领域权威是 `src/domain/workspace/creativeRelationPolicy.ts`。
- Longform 的 `volume` 是 OC 个人故事容器，不是文件大小、数据库卷或发布卷号。
- 没有真实 Provider 时必须失败关闭；本目录的纯函数测试不是 Live（真实运行）证据。

## 当前冻结债务

- `GrowthPhaseHandler` 已负责阶段匹配与工具计划；Longform、Closure/Repair 的 Worker 编译/展示已迁入阶段目录。顶层状态机仍保留跨阶段的运行时状态、工具分派和原子副作用门禁，尚未把 world/story/OC 迁入同一接口。
- Longform 与 Closure/Repair 的 Main authority 已迁入 `src/main/growth/phases/`；`growthRunLifecycle.ts` 仍保留 Receipt 投影、Closure 结果持久化、提交与恢复，这是后续维护的主要剩余体积。
- 用户 Cycle 间指导已有一次真实失败边界：规则修订被持久化并用于后续 Cycle，但图谱 Story scope 验收未完成。不得称交互式 Growth 已闭环。
- Longform 的确定性编译、身份和 pinned progress 已存在；自动 outline→section→recheck 协调尚未冻结，不得继续向 Coordinator 添加未经规则边界验证的分支。

## 定向验收

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-phase-registry.test.ts tests/unit/steward-execution-state-machine.test.ts
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-longform-phase.test.ts tests/unit/growth-closure-phase.test.ts
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-longform-progress.test.ts tests/unit/growth-run-bridge.test.ts
npx --no-install vitest run --config vitest.config.ts tests/unit/creative-relation-policy.test.ts tests/unit/creative-relation-repository.test.ts
npm run typecheck
git diff --check
```

全量测试、生产构建、安装包和真实 Provider 只在代码冻结后集中运行，不能用上述定向命令替代。
