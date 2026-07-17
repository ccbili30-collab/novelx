# World Director Task 4 内部编辑合同

日期：2026-07-18
分支：`codex/hackathon-10day`

## 已完成

- 新增内部合同版本 `1.0.0` 和固定 15 个 `AgentCapabilityId`，未知能力在 Zod 与 TypeBox 两侧均拒绝。
- 新增 `EditorialRoundPlan` 与 `WorkOrderDefinition`：每轮 1–20 个工单；工单固定目标、checkpoint、scope refs、能力、验收维度和依赖。
- Zod 语义校验要求工单 ID 唯一、所有工单固定同一 checkpoint、依赖只能引用同轮前序工单并按计划顺序排列，因此拒绝后向边、自环、环和非规范依赖顺序。
- 新增 `SpecialistCandidate` 的 `ready` / `needs_more_evidence` 严格联合，绑定 Artifact（产物）、证据和覆盖维度。
- 新增 `GraphCuratorCandidate`：断言和有向因果候选都必须绑定精确 source locator（来源定位）；因果必须提供机制、条件、时间范围和认识状态。
- 新增独立的 `CheckerReview` 与 `DirectorReview` 判别联合。
- 所有模型可见输出合同都拒绝未知字段；定向测试证明 Prompt、API key、Provider URL、工具列表、数据库 ID 和 checkpoint 注入在 Zod / TypeBox 两侧失败。

## 验收

- `npx --no-install vitest run --config vitest.config.ts tests/unit/growth-editorial-contract.test.ts`：1 文件，7/7，通过，零跳过。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- 真实 Provider（模型服务）：未运行。
- 全量测试：未运行；本 Task 仅新增未接线的内部合同，按计划使用定向测试和类型检查。

## 边界与风险

- TypeBox 是 Provider 工具参数的结构合同；Zod 是跨字段语义权威。TypeBox 本身不证明 dependency DAG（依赖有向无环图）、checkpoint 一致、source span 非空或候选状态一致，这些由 Zod 定向测试证明。
- 合同尚未接入数据库、Director runtime（运行时）、scheduler（调度器）、Provider 或 Renderer（渲染层），不能称为 World Director 已实现。
- Work Order 生命周期和合法状态转移仍由 Task 6 的 Growth Editorial Repository（编辑仓储）独占；Task 4 不提前实现第二份状态机权威。
- `EditorialRoundPlan` 中的持久身份和 checkpoint 只允许由 Main（主进程）可信编译；模型可见候选只使用 allowlisted alias（允许列表别名）。后续 Task 14/15 接线时必须保持该边界。
- 下一入口是 Task 5 的纯加法 SQLite v28；迁移不得改变 v27 数据、Canon（正史）或 Runtime V2 A2.2。
