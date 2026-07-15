# Growth World Fragment Compiler Implementation Plan

> **For C execution session:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** 让真实 Steward 在 Growth 的 world Cycle 中提交高层创作 Fragment，由 Worker 确定性编译为现有 create-only Change Set，避免模型手写资源父级、稳定 ID、依赖 DAG 和文档来源占位符。

**Architecture:** 仅 world 阶段替换模型可见的 `propose_change_set` 参数结构；工具名、Main Gateway、ChangeSetService、数据库和原子提交语义保持不变。模型负责标题、正文、事实和关系选择；纯编译器负责 ID、父级、create/state、依赖、证据占位符及排序，并在调用现有 executor 前完成全部验证。编译失败不产生领域写入，只允许既有有界纠正。

**Tech Stack:** TypeScript、Zod、TypeBox、Vitest、Electron Playwright、现有 GrowthRunBinding / ChangeSet / SQLite 路径。

---

## Requirements and non-functional constraints

- 仅适用于受信任 `GrowthRunBinding.phase === "world"` 的 Run；普通 Steward 与 story/oc 阶段行为不变。
- Main 必须从当前 workspace 的初始化 domain roots 派生受信任的 world/oc/story root IDs；模型和 Renderer 不得提供或覆盖。
- world Fragment 不规定固定实体数量。它必须至少包含一个 world、一个稳定世界设定文档和至少三个有文档来源的事实；location、faction、附加文档、事实和 `related_to` 关系均可开放增长。
- 模型提供所有创作语义：标题、正文、事实 subject/predicate/value、关系端点选择。编译器不得补写世界事实、正文或标题。
- 编译器可生成且只能生成：稳定内部 ID、资源父级、create/state/sortOrder、Change Set item ID、dependsOn、`greenfield_document_output:` 来源占位符及 author/gateway 已有机械字段。
- 编译结果只调用一次现有 `executor.proposeChangeSet`。不得持久化 Fragment，不得多 Change Set，不得 post-apply retry，不得绕过 Policy/Gateway/ChangeSetService。
- 错误仅使用固定 allowlist，不回显 Fragment、Prompt、工具参数、正文或原始异常。
- 没有真实 Provider 时继续 Fail Closed；Fixture 只证明编译器，不是 Live。

## Alternatives considered

1. **继续扩展低层预检和重试**：改动小，但模型仍需手写数据库形状，复杂度和失败会随世界规模增长；拒绝。
2. **Worker 内高层 Fragment 编译为单一既有 Change Set**：保留真实模型创作、最小化协议和持久化变化、可在提交前失败关闭；采用。
3. **持久化 Fragment 或分阶段多 Change Set**：可恢复性更强，但需要新 Schema、部分提交和审计语义；本黑客松 P0 冻结。

## Task 1: Freeze the model-facing contract

**Files:**
- Create: `src/agent-worker/growth/growthWorldFragment.ts`
- Test: `tests/unit/growth-world-fragment.test.ts`

1. 先写失败测试，定义严格 world Fragment：`summary`、单个 `world`、开放 `entities`、`documents`、`assertions`、`relations`。
2. 本地引用使用短 `localId`；实体仅允许 `world | location | faction`，文档仅允许既有 world 相关 document kinds，关系仅允许 `related_to`。
3. 验证 localId 唯一、所有引用存在、world 唯一、每个 Assertion 至少引用一个 Fragment 文档、禁止 self relation。
4. 运行该单测，确认在实现前失败。
5. 实现 Zod/TypeBox 对齐的严格结构，并使用固定安全错误码：duplicate、reference、phase/shape invalid。
6. 运行单测并确认通过。

## Task 2: Compile creative fields into the existing Change Set

**Files:**
- Modify: `src/agent-worker/growth/growthWorldFragment.ts`
- Test: `tests/unit/growth-world-fragment.test.ts`

1. 先写失败测试：相同 `cycleId + Fragment` 输出相同 IDs 和完全相同 Change Set args。
2. world 的 parent 必须是受信任 world root；location/faction 默认归 world，也可引用合法的同 Fragment 父实体。
3. 为每份文档生成 `creative_document.put` 和 `document.put`；为事实生成 `assertion.put`，来源转换为对应 document item 的 `greenfield_document_output:`，并生成完整 dependsOn。
4. 关系端点只能引用 Fragment 内创建资源，dependsOn 包含两端资源 item。
5. 断言编译结果不得包含 project file、domain root、update/delete；正文、标题、事实和关系选择必须逐字段等于模型 Fragment。
6. 运行单测并确认：开放数量、嵌套父级、确定性、引用失败、无创作补写均通过。

## Task 3: Bind trusted domain roots

**Files:**
- Modify: `src/shared/agentWorkerProtocol.ts`
- Modify: `src/main/growthRunLifecycle.ts`
- Test: `tests/unit/agent-worker-contract.test.ts`
- Test: `tests/unit/growth-run-bridge.test.ts`

1. 先写失败测试：Growth binding 必须包含严格 `domainRootResourceIds: { world, oc, story }`，三者唯一、均在 Main 授权 scope 内；未知字段拒绝。
2. Main 从当前 checkpoint 可见的正式 domain roots 派生这三个 ID；缺失、重复、类型不匹配时在 Worker 启动前以 `GROWTH_BINDING_INVALID` 失败关闭。
3. Renderer、模型 tool args 和公共 Growth start 不能提供这些 IDs。
4. 运行绑定/桥接测试并确认通过。

## Task 4: Replace only the world-phase tool schema

**Files:**
- Modify: `src/agent-worker/tools/createAgentTools.ts`
- Modify: `src/agent-worker/stewardExecutionStateMachine.ts`
- Modify only if required for safe labels: `src/agent-worker/workerController.ts`
- Test: `tests/unit/agent-worker-tool-bridge.test.ts`
- Test: `tests/unit/steward-execution-state-machine.test.ts`
- Test: `tests/unit/agent-worker-contract.test.ts`

1. 先写失败测试：world Growth 的模型可见 `propose_change_set` 不得出现 `resourceId`、`parentId`、`dependsOn`、`create`、`state`、item IDs、evidence placeholder 或 project file 分支。
2. `createAgentTools` 在 `phase=world` 时解析 Fragment、调用纯编译器，再把编译后的现有 `ProposeChangeSetArgs` 交给原 executor；普通和 story/oc 仍使用旧参数。
3. 编译器失败映射到固定内部码，并加入现有 world Greenfield 的有界预执行纠正；不得增加 post-service retry 次数或改变普通 Run。
4. 成功时必须只有一次 executor 调用；返回值仍为既有 `ProposeChangeSetResult`，状态机/Coordinator 不获得伪成功。
5. 运行三组定向测试并确认通过。

## Task 5: Prove the compiled path against the real Domain boundary

**Files:**
- Test: `tests/unit/workspace-agent-tool-gateway.test.ts` or create one focused integration test if isolation is clearer.
- Create: `docs/adr/2026-07-15-hackathon-growth-world-fragment-compiler.md`

1. 先写失败的 SQLite 集成测试：初始化空 workspace，构造可信 world binding 和 Fragment，经真实 tool executor/Gateway/ChangeSetService 提交。
2. 验证一个 committed Change Set、checkpoint 增量 1、资源父级合法、稳定文档/Assertion 来源可回放、关系端点有效、outputs 与实际版本对应。
3. 增加失败用例：坏引用、非法父级、编译器异常均在 ChangeSetService 前终止，Change Set/outputs/checkpoint/正式对象增量全部为 0。
4. ADR 记录采用方案、创作字段与机械字段边界、失败模式、无迁移/无中间写入、story/oc 后续扩展点。
5. 运行定向测试、typecheck、publication gate 和 diff check。

## Task 6: One real Provider acceptance attempt

**Files:**
- Modify only if safe evidence fields are missing: `tests/e2e/real-provider-growth-three-cycle.spec.ts`
- Add one failure-or-success evidence JSON under `notes/evidence/novax-desktop-growth/`.
- Update: `notes/status/2026-07-15-hackathon-growth-live-text-boundary.md`

1. 生产构建通过后，使用现有保存配置与 `NODE_USE_ENV_PROXY=1` 运行一次、仅一次现有 Growth Playwright。
2. 报告 world Cycle 是否产生 committed Change Set、output checkpoint、正式对象/文档/Assertion/关系；若进入 Cycle 2，记录其首个安全终态，但不得在本任务修 story/oc。
3. 不运行图片，不把 Fixture、编译器测试或部分 world commit 称为三 Cycle Live 完成。
4. Leak scan 必须通过；证据不得包含正文、Fragment、Prompt、工具参数、locator、原始错误或凭证。
5. 真实运行后停止，返回父线程审查；不提交实现批次。

## Final acceptance commands

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-world-fragment.test.ts tests/unit/agent-worker-contract.test.ts tests/unit/agent-worker-tool-bridge.test.ts tests/unit/steward-execution-state-machine.test.ts tests/unit/growth-run-bridge.test.ts tests/unit/workspace-agent-tool-gateway.test.ts
npm run typecheck
npm run verify:prompt-publication
git diff --check
npm run build
$env:NODE_USE_ENV_PROXY='1'; npx --no-install playwright test tests/e2e/real-provider-growth-three-cycle.spec.ts --workers=1
```

停止条件：需要新数据库迁移、公开 Renderer 输入、Prompt 调优、Policy 放宽、post-apply retry、多个 Change Set、图片工作，或真实失败落在 story/oc 阶段。任何停止条件出现时保留安全证据并返回，不自行扩大。
