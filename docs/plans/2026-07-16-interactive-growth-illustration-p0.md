# Interactive Growth And Illustration P0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将当前固定的 `world → story → oc` 三轮 Growth 升级为世界、故事、OC 任一内容都可作为种子并互相正推/逆推、可反复接受用户指导、在安全 Cycle 边界修订受影响内容，并为图谱节点或任意文本描述生成来源绑定的“图片＋文字”真实创作闭环。

**Architecture:** Growth Frontier Planner（生长前沿规划器）先识别种子中已有的世界、故事和 OC 信息，再决定下一轮补齐或反向推导哪个领域，不预设固定顺序。内容修改仍由每个 Growth Cycle 的唯一原子 Change Set 完成；用户指导形成单调 Rule Revision，新的修订 Cycle 从最新 checkpoint 重新图检索后更新受影响节点。图片不再作为单个世界 Cycle 的固定尾步骤，而由 Main-authoritative（主进程权威）的持久 Illustration Queue（插图队列）按资源版本或不可变文本锚点异步执行；队列无产品数量上限，只使用有限批次和有限并发保护 Provider。Renderer 只显示持久状态、安全摘要和受管资产。

**Tech Stack:** Electron 43、React 19、TypeScript 6、SQLite、Zod、TypeBox、现有 GrowthRepository / GraphRetrievalService / ChangeSetService / ImageGenerationService、Vitest、Playwright、真实 `gpt-5.4` 与 `gpt-image-2`。

---

## 产品口径与冻结边界

### P0 必须实现

- 用户可以在任意 Growth Cycle 运行期间或初始世界包完成后继续追加指导。
- 世界、故事、OC 三位一体互推互逆：世界种子可以生长故事和角色；故事种子可以反推世界规则、历史与角色；OC 种子可以由经历反推故事冲突和世界背景；混合种子保留已有内容并补齐缺口。
- 模型推导出的世界背景、历史或角色关系先作为有来源候选进入 Change Set；不得因为“逆推”直接升级 Canon。
- Growth Goal 不设固定 Cycle 数。每个 Cycle 本身有界、原子、可恢复，但 Coordinator 必须持续计算下一 Growth Frontier，直到目标 Closure Profile（闭环档案）全部满足或遇到需要用户/Provider 处理的真实阻塞。
- 每个内容 Cycle 在提出 Change Set 前执行 Evidence-grounded Inquiry（证据化自询）：从当前图谱/文档提出 3–7 个高价值问题，标注相关节点与 known/conflicted/unknown 状态，去重后只选择最高价值问题继续推演。自询是正式 Harness 步骤，不是 Prompt 中的“多想想”。
- 自询不保存或展示原始思维链；只持久化问题、安全摘要、证据引用、选择结果和后续行动。只有不同答案会改变作品身份、规则或创作者价值取舍时才暂停询问用户，否则采用明确标注的临时假设继续生长。
- World Closure：具有自洽的宇宙/天文与时间框架、地理和自然环境、连续历史、国家/政治与社会组织、文化/信仰/经济、力量或技术规则、当前冲突、地图和代表性视觉。
- OC Closure：默认选择一个焦点主角，形成完整来历、人格、动机、能力/限制、关系和与世界的相互影响，并至少生成一篇累计不少于 10,000 个 Unicode 字符的个人故事；其他主要 OC 仍需完整角色档案、来历、关系和较短个人经历。用户可将任意其他 OC 提升为焦点角色，再启动其独立万字故事闭环。
- Story Closure：具有清晰的世界历史背景、主要人物来历、冲突起因、发展、关键转折和阶段性结局；故事、世界和主要 OC 的来源与关系可由图谱检索。
- 最终“世界诞生”必须同时满足内容闭环与默认视觉集合 ready；如果图片仍在生成，只能显示“内容已闭环，视觉生成中”。
- 指导先持久化为新的 Rule Revision；正在运行的 Cycle 保持原规则版本，下一安全 Cycle 使用最新版本。
- 新规则影响既有世界、故事或 OC 时，必须先运行修订 Cycle，而不是机械进入下一固定阶段。
- 每个修订 Cycle 固定 input checkpoint、规则版本、检索 Receipt，并且至多提交一个 Change Set。
- 默认插图策略：一张世界地图、主要国家/地区/地点/势力的代表性风貌图、故事背景或关键场景图、每个主要 OC 一张角色立绘；重要物品、怪物、遗迹、建筑或魔法现象由模型按叙事重要性选择。
- 用户明确要求“每个节点一张”“某角色多套服装”等时全部排队，不设产品硬上限；内部按页规划、有限并发执行。
- 任意稳定文档、段落、文本选择、对话中的用户描述或图谱节点都可以成为 Illustration Anchor（插图锚点）；最终投影是来源文字与一张或多张图片组合，而不是只有孤立图片。
- 默认画风为 `illustrated_manga_handdrawn_v1`：成熟漫画构图、手绘线条、绘本/概念艺术材质、克制且有层次的色彩；默认禁止摄影写实、3D 写实、chibi、kawaii、通用萌系或塑料娃娃感。用户明确指定其他画风时覆盖默认值。
- 任何来源版本改变后，旧图片必须变为 `stale`；未发送任务可取消并重新编译，已经发送的 Provider 请求不能伪装撤回。
- UI 显示真实的指导回执、影响对象、Cycle、插图计划、排队/生成/ready/failed/stale 状态；不显示原始思维链。

### 本计划明确不做

- 不进入 Player / GM / Writer / Checker 玩家回合。
- 不扩建 Rust Runtime V2 A2.2、Canon、Creator/Player Lens 或权限系统。
- 不实现费用预算、平台代付、订阅或 API 成本确认；使用用户自己的 Provider 配置。
- 不承诺无限并发；“无数量上限”通过持久队列和分页实现。
- 不实现完整长篇章节管理、导出、安装包或移动端。

### 停止条件

- 需要改变 Canon、权限或 A2.2 冻结语义。
- 新迁移不能证明旧 v23 工作区无损升级、重放和失败恢复。
- Renderer 需要从自然语言或本地状态猜测提交、图片 ready 或修订完成。
- 没有真实 Provider 配置却试图用 Fixture 冒充 Live。

---

## Task 0：冻结当前失败证据并建立干净执行基线

**Files:**
- Review: `tests/e2e/real-provider-growth-three-cycle.spec.ts`
- Review: `notes/status/2026-07-15-hackathon-growth-live-text-boundary.md`
- Review: `notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-15T16-43-43-913Z.json`
- Create: `tests/e2e/real-provider-interactive-growth.spec.ts`

**Steps:**

1. 将当前未提交的 Cycle 间指导实验从世界包基础 E2E 外科迁移到独立 `real-provider-interactive-growth.spec.ts`；不得删除断言或把失败条件改成 skip。
2. 保留 16-43 failure-only evidence 原始字节和 SHA；Player failure evidence 单独留存，不混入 P0 提交。
3. 将 `real-provider-growth-three-cycle.spec.ts` 恢复为已提交的视觉世界包基线，只保留公共 helper 所需的无语义移动。
4. 运行 `npm run typecheck` 与 `git diff --check`；不得运行 Provider。
5. 提交测试基线：`test(growth): isolate interactive guidance acceptance`。

**完成条件:** 工作树中 P0 文件所有权明确，既有真实失败证据未被重写，后续任务不再修改 Player 文件。

---

## Task 1：联合决策与 v24 加法持久化

**Files:**
- Create: `docs/adr/2026-07-16-hackathon-interactive-growth-and-illustration.md`
- Modify: `src/shared/growthContract.ts`
- Modify: `src/domain/workspace/workspaceRepository.ts`
- Modify: `src/domain/growth/growthRepository.ts`
- Test: `tests/unit/growth-contract.test.ts`
- Test: `tests/unit/growth-repository.test.ts`
- Test: `tests/unit/workspace-persistence.test.ts`

**Decision gate:** 该任务新增共享合同和 SQLite v24，必须先由产品负责人和 Main Head 接受 ADR。未接受前不得编码迁移。

**Data design:**

```ts
type GrowthCycleIntentKind = "bootstrap_world" | "bootstrap_story" | "bootstrap_oc" | "revision";

interface GrowthCycleIntent {
  cycleId: string;
  kind: "expand" | "revision";
  focusKinds: Array<"world" | "story" | "oc">;
  resumeFrontier: Array<"world" | "story" | "oc">;
}

type GrowthClosureProfileKind = "world_birth" | "oc_saga" | "story_universe" | "mixed_birth";

interface GrowthClosureState {
  profileId: string;
  goalId: string;
  profileKind: GrowthClosureProfileKind;
  subjectResourceId: string | null;
  revision: number;
  contentState: "growing" | "closed" | "blocked";
  visualState: "planning" | "generating" | "ready" | "blocked";
  satisfiedFacetIds: string[];
  missingFacetIds: string[];
  lastProgressCycleSequence: number;
}

interface GrowthClosureReview {
  id: string;
  goalId: string;
  checkpointId: string;
  profileKind: GrowthClosureProfileKind;
  stewardAssessment: "continue_growing" | "ready_for_checker";
  checkerDecision: "accepted" | "repairs_required" | "blocked";
  findingFingerprint: string;
}

interface GrowthInquiryRecord {
  id: string;
  goalId: string;
  cycleId: string;
  checkpointId: string;
  ruleRevision: number;
  question: string;
  evidenceState: "known" | "conflicted" | "unknown";
  safeSummary: string;
  priority: number;
  selected: boolean;
  fingerprint: string;
}

interface GrowthIllustrationRequest {
  id: string;
  goalId: string;
  cycleId: string;
  ruleRevision: number;
  coverageMode: "default" | "all_visible_nodes" | "custom";
  status: "planned" | "running" | "completed" | "failed" | "cancelled" | "stale" | "reconciliation_required";
}

interface GrowthIllustrationAnchor {
  kind: "resource" | "stable_text_span" | "working_text_snapshot" | "conversation_text_snapshot";
  resourceId: string | null;
  documentVersionId: string | null;
  startOffset: number | null;
  endOffset: number | null;
  sourceSnapshotId: string | null;
  textSha256: string;
}
```

1. 新增 `growth_cycle_intents`、`growth_cycle_intent_focuses` 与 `growth_cycle_intent_frontier`。`cycle_id` 是指向 `growth_cycles` 的 PK/FK；Cycle 与 Intent 必须在同一个 `BEGIN IMMEDIATE` 事务中创建，先持久化成功再发布 `cycle_planned`。Intent 不重复保存规则版本，直接以 Cycle 的 pinned rule revision 为权威；focus/frontier 子表保存显式 ordinal。增加每个 Goal 至多一个 `planned/running` Cycle 的部分唯一索引。旧 v23 Cycle 仅在查询投影中按 sequence 1/2/3 解释为 legacy bootstrap intent，不补写伪历史行。
2. 新增 `growth_inquiry_batches`、`growth_inquiries` 与 `growth_inquiry_evidence_links`。Batch 以 `cycle_id UNIQUE` 固定 Receipt/checkpoint/rule revision、`idempotency_key`、`payload_hash`、状态、3–7 的问题数、nullable selected inquiry 和 sealed 状态；问题写入、选择与封存必须单事务。证据链接使用 `(receipt_id, rank)` 组合外键复用已经授权的 Retrieval Receipt 命中，不保存无类型 `evidenceRefs[]`。除非 Cycle 因真正需要用户取舍而 blocked，封存时必须恰好一条 selected。
3. 新增 `growth_closure_profiles`、`growth_closure_profile_revisions`、`growth_closure_facets`、`growth_closure_assessments`、`growth_closure_reviews` 与 `growth_closure_review_findings`。Profile 使用稳定 `profile_id`；`oc_saga` 必须绑定唯一 `subject_resource_id`。Steward 与独立 Checker assessment 分开追加，绑定角色匹配且不同的 `agent_invocation_id`、Cycle/checkpoint/rule/Receipt/output hash；Review 只引用两份 assessment。Finding 按 facet 正规化并链接 Receipt 证据。规则或来源变化创建新 revision/epoch，不改写旧 accepted review；`closed` 与 `visual ready` 是派生投影，任一默认必需图片 stale 时不得 ready。
4. 新增 `growth_illustration_requests`、`growth_illustration_request_batches`、`growth_illustration_items`、`growth_illustration_item_sources` 与 `growth_illustration_text_snapshots`。Item 保存严格判别联合锚点、规则版本、purpose、标题、编译后 prompt 哈希、source version、唯一 Image Job 绑定和 `planned/queued/running/ready/failed/cancelled/stale/reconciliation_required` 状态；不保存凭证。Request Batch 保存 sequence/cursor/item count/idempotency key/payload hash/status，每批原子封存、可恢复重放；Request 的 completed/stale 必须由 Item 聚合派生或可重新进入 stale。
5. 稳定资源锚点必须带 resource version；稳定正文锚点保存 document version、Unicode code-point offset 单位、字符范围和片段哈希，不重复复制正文；working copy 或对话文本保存项目内不可变 source snapshot 原文与 hash，但不升级为正式文档、Assertion 或 Canon。
6. Item 不设总数约束；单次数据库写入和模型规划使用内部 batch size，默认 20。批次游标只负责恢复与分页，不构成产品配额。
7. 建立唯一键：`request_id + anchor_hash + source_version_set_hash + variant_key`，并为 Inquiry Batch、Closure Assessment/Review 与 Illustration Batch 建立稳定 idempotency key + payload hash，保证恢复与重放不会重复收费或重复提交。
8. 写 v23→v24 保留 Growth、Change Set、文档、断言、关系、图片 Job/Asset 和哈希的迁移测试；迁移只能新增表、索引和约束，不重写内容或伪造旧 Cycle 的 Intent/Inquiry/Closure/Illustration 行。
9. 写 crash/reopen、inquiry 批次原子封存/去重/单选精确重放、Receipt rank 外键、幂等 replay、同 Goal 单写者、闭环 revision 重开、Steward/Checker 调用隔离、图片 stale 聚合与 outcome-unknown 回归。
10. 运行：
   - `npx --no-install vitest run --config vitest.config.ts tests/unit/growth-contract.test.ts tests/unit/growth-repository.test.ts tests/unit/workspace-persistence.test.ts`
   - `npm run typecheck`
11. 提交：`feat(growth): persist inquiries closure and illustration requests`。

---

## Task 2：默认视觉风格策略与来源安全编译

**Files:**
- Create: `src/domain/growth/growthVisualStylePolicy.ts`
- Create: `src/agent-worker/growth/growthIllustrationPlan.ts`
- Modify: `src/shared/agentWorkerProtocol.ts`
- Test: `tests/unit/growth-visual-style-policy.test.ts`
- Test: `tests/unit/growth-illustration-plan.test.ts`
- Test: `tests/unit/agent-worker-contract.test.ts`

**Default style:**

```ts
const defaultVisualStyle = {
  id: "illustrated_manga_handdrawn_v1",
  positive: [
    "mature graphic-novel composition",
    "hand-drawn expressive linework",
    "painterly paper and brush texture",
    "restrained cinematic color design",
    "fantasy concept-art clarity",
  ],
  negative: [
    "photorealistic photography",
    "3D realism",
    "chibi",
    "kawaii mascot style",
    "generic moe doll-like character design",
    "watermark or embedded text",
  ],
} as const;
```

1. 先写失败测试：无用户视觉覆盖时，每个图片 prompt 都包含默认 positive/negative 约束；不得依赖 Prompt 文案自觉补齐。
2. 用户规则明确指定写实或其他风格时，Planner 输出严格 `styleMode: "user_override"` 和用户视觉摘要；模型不能修改 policy ID 或来源 ID。
3. 编译器总是加入当前 Rule Revision 的视觉约束，并把图片内容事实限制在稳定来源中；风格可以变化，身份、装备、地点、事件事实不能凭图片模型新增。
4. `GrowthIllustrationPlan` 只接受证据引用、purpose、标题、构图描述、variant key 与覆盖模式；Main 映射真实资源/version IDs。
5. purpose 继续复用 `world_map | character_portrait | scene`，不为每种图鉴节点扩张枚举：国家、地点、势力、怪物、物品等通过 source target 和 UI 分类呈现。
6. 运行定向 Vitest、`npm run typecheck`、`git diff --check`。
7. 提交：`feat(growth): compile the default hand-drawn manga style`。

---

## Task 3：三位一体生长前沿与可恢复动态 Cycle 调度

**Files:**
- Create: `src/agent-worker/growth/growthSeedAnalysis.ts`
- Create: `src/main/growthFrontierPlanner.ts`
- Modify: `src/main/growthCoordinator.ts`
- Modify: `src/main/growthRunLifecycle.ts`
- Modify: `src/shared/ipcContract.ts`
- Modify: `src/preload/desktopApi.ts`
- Modify: `src/main/registerDesktopIpc.ts`
- Test: `tests/unit/growth-coordinator.test.ts`
- Test: `tests/unit/growth-run-bridge.test.ts`
- Test: `tests/unit/ipc-contract.test.ts`

**Frontier and scheduling rules:**

1. Seed Analysis 只输出严格高层结果：`presentKinds`、`missingKinds`、`evidenceRefs` 和建议 `focusKinds`。它可以识别 world/story/oc/mixed/unknown，但不能提交资源 ID、权限或 Canon 决策。
2. 世界种子默认先巩固 world，再根据缺口生长 story/oc；故事种子必须先保存故事已有表达，再反推所需 world 与 OC；OC 种子必须先保存角色已有表达，再由角色经历反推 story 冲突和 world 背景。混合种子不得覆盖用户已经给出的事实。
3. 每轮从最新图谱 coverage、缺失关系和用户规则计算 Growth Frontier；`focusKinds` 可以是一种或多种，不再按 sequence 硬编码阶段。
4. Planner 不能因为“已有一个 world/story/oc 资源”就停止；它必须读取 Closure State。只有当前 profile 的内容 facets 全部满足，才停止创建内容 Cycle 并等待默认视觉集合完成。
5. 用户指导在任意 running/committed/awaiting-guidance 状态均可追加；删除现有 C3 后 `GROWTH_GUIDANCE_NO_NEXT_CYCLE` 的产品限制。
6. 正在运行的 Cycle 固定旧 revision。边界到达后，如果 Goal 最新 revision 大于刚完成 Cycle revision，先计划一个 `revision` intent；完成后重新计算 frontier，而不是恢复写死阶段。
7. 同一边界前追加多条规则时，全部 revision 持久化，但允许一个 revision Cycle 使用最新 revision 合并处理；不得丢失中间审计记录。
8. revision Cycle 失败时停止后续调度并保留恢复入口；未知结果进入 `reconciliation_required`。
9. `growth.guide` 回执增加 `nextCycleKind: "revision"` 与预计 `focusKinds`，但不承诺尚未提交的结果。
10. Task 1 的 `beginCycle` 省略 Intent 回退只是迁移桥。本任务接管 Coordinator 后，所有新 Cycle 必须显式传入持久 Intent，并删除 sequence 1–3 的新 Cycle fallback；旧 v23 行仍只保留查询时 `legacy_v23_projection`，不得回填历史。
11. 写确定性测试矩阵：world→story/oc、story→world/oc、oc→story/world、mixed seed 保留、unknown seed 澄清/保守生长；另覆盖 C1 中断、初始完成后继续、连续规则、重开、取消、CAS 冲突和 terminal event 精确一次。
12. 运行定向测试、typecheck、Prompt publication gate。
13. 如果连续两个 Cycle 没有新增/修订任何 closure facet、没有解决冲突且没有字符/视觉进度，进入 `blocked / GROWTH_CLOSURE_NO_PROGRESS`，显示需要用户指导；不得无限消耗 Provider。
14. 提交：`feat(growth): plan world story and oc from any seed`。

---

## Task 4：证据化自询与问题选择循环

**Files:**
- Create: `src/agent-worker/growth/growthInquiryBrief.ts`
- Create: `src/domain/growth/growthInquiryRepository.ts`
- Modify: `src/main/growthCoordinator.ts`
- Modify: `src/main/growthRunLifecycle.ts`
- Modify: `src/agent-worker/stewardExecutionStateMachine.ts`
- Test: `tests/unit/growth-inquiry-brief.test.ts`
- Test: `tests/unit/growth-inquiry-repository.test.ts`
- Test: `tests/unit/steward-execution-state-machine.test.ts`

**Inquiry contract:**

```ts
interface GrowthInquiryBrief {
  inquiries: Array<{
    localId: string;
    question: string;
    evidenceRefs: string[];
    evidenceState: "known" | "conflicted" | "unknown";
    safeSummary: string;
    proposedAction: string;
    priority: number;
    requiresCreatorChoice: boolean;
  }>;
  selectedLocalId: string | null;
}
```

1. 每个内容/修订 Cycle 必须先完成 pinned checkpoint 图检索，再提交 3–7 条 Inquiry；少于 3、多于 7、无 evidence state、重复 fingerprint 或选择不存在的问题均在模型副作用前拒绝。
2. 问题必须针对因果和影响，而不是“还能加什么设定”。优先类别包括地理/制度后果、历史因果、角色选择、故事不可逆结果、跨节点冲突和视觉一致性。
3. Main 根据标准化 question、evidence refs 和 rule revision 生成 fingerprint；当前 Goal 未解决问题和最近 Cycle 问题参与去重。模型不能自行指定 fingerprint。
4. 仅一条最高价值 Inquiry 可成为本 Cycle 的 Growth Frontier；其他问题持久为 backlog，后续重新检索后可提升或关闭。
5. `requiresCreatorChoice=true` 只有在多个答案会改变作品身份、核心规则或价值取舍时成立。此时 Cycle 在 Change Set 前进入 `blocked / GROWTH_CREATOR_CHOICE_REQUIRED`，UI 显示安全问题和选项；用户回答成为新 Rule Revision。
6. 普通 unknown 不阻塞：模型必须给出明确标注的 provisional assumption（临时假设），并在后续 Checker review 中保持可追踪。
7. 选定问题驱动恰好一个 Change Set；提交后下一 Cycle 必须从 output checkpoint 重新检索，更新该 Inquiry 为 answered/conflicted/unknown，不能直接沿用旧答案。
8. 连续两个 Cycle 选择相同 fingerprint 且证据状态、目标节点和 closure facets 均无变化时，进入 `GROWTH_INQUIRY_STALLED`；不继续自言自语。
9. Renderer 只接收 `safeSummary`，例如“正在推演：潮汐魔法对港口贸易、历法和宗教权力的连锁影响。”不得接收原始思维链、草稿答案或模型 token stream。
10. 定向测试覆盖 2/3/7/8 数量边界、fingerprint 去重、backlog、provisional assumption、用户取舍阻塞、提交后重检、原地打转停止和重开恢复。
11. 运行 3 文件定向 Vitest、typecheck、Prompt publication gate。
12. 提交：`feat(growth): ground self inquiry in graph evidence`。

---

## Task 5：Closure Evaluator 与万字长文分段写作

**Files:**
- Create: `src/domain/growth/growthClosureEvaluator.ts`
- Create: `src/agent-worker/growth/growthLongformOutline.ts`
- Create: `src/agent-worker/growth/growthLongformSection.ts`
- Modify: `src/main/growthCoordinator.ts`
- Modify: `src/main/growthRunLifecycle.ts`
- Modify: `src/agent-worker/stewardExecutionStateMachine.ts`
- Test: `tests/unit/growth-closure-evaluator.test.ts`
- Test: `tests/unit/growth-longform-authoring.test.ts`
- Test: `tests/unit/growth-run-bridge.test.ts`
- Test: `tests/unit/steward-execution-state-machine.test.ts`

**Decision gate:** Task 1 只允许 Closure assessment 在 `running` evaluation Cycle 中评估它的 pinned input checkpoint；Receipt、Cycle input、Closure revision 与 assessment checkpoint 必须完全一致。编码本任务前，必须先冻结“Checker accepted 且无需 Change Set”时 evaluation Cycle 的真实成功终态。不得把它伪装成 `blocked/cancelled`，也不得提交空 Change Set。若现有状态合同无法表达该终态，停止并返回产品负责人/Main Head 决策，不得在本任务中静默改 schema。

**Closure profiles:**

1. `world_birth` 至少检查：cosmology/astronomy/time、geography/environment、history/timeline、polities/institutions、culture/belief/economy、power/technology rules、current conflicts、world map、world scenes。检查对象必须是带稳定来源的文档、Assertion、资源和关系，不用关键词出现次数冒充结构。
2. `oc_saga` 至少检查：唯一焦点 OC 的 profile、来历、人格/动机、能力与限制、主要关系、world/story bindings、角色立绘、关键场景，以及当前稳定个人故事总长度 `>= 10_000` Unicode code points。字符数不按字节、Token 或 HTML 长度计算。非焦点主要 OC 必须有完整 profile、来历、关系和个人经历，但默认不要求各自达到 10,000 字；显式提升为焦点后使用新的 `oc_saga` 评估。
3. `story_universe` 至少检查：世界历史背景、主要角色来历、起因、发展、关键转折、阶段性结局、uses_world、uses_oc 和故事场景图。
4. `mixed_birth` 组合种子中用户明确要求的 profiles；不能为了快速完成偷偷降低单项门槛。

**Longform flow:**

5. 长文先生成结构化 outline：章节/段落目标、所需世界与 OC evidence、连续性约束和预计字符区间；outline 不是正文，也不能计入 10,000 字。
6. 每个 Writer Cycle 只写一个有界 section，并把 Writer candidateText 原字节写入独立稳定 prose document；不得用模板、重复段落或确定性 filler 补字符数。
7. 下一 section 必须从最新 checkpoint 检索已写正文、世界规则和角色状态；不能只依赖会话历史。
8. 每完成若干有实际进展的内容 Cycle，Steward 必须提交严格 `ClosureSelfAssessment`：缺失 facets、冲突、继续生长理由或 `ready_for_checker`。这不是思维链，也没有关闭权限。
9. Closure assessment 使用独立的 evaluation Cycle：它先从待评估 checkpoint 检索，Steward 与 Checker 使用同一可信 Receipt、不同且角色匹配的终态 invocation；不得复用产生该 checkpoint 之前的旧 Receipt。
10. 只有 deterministic facets 达到 review 门槛且 Steward 提交 `ready_for_checker` 后，Coordinator 才启动独立真实 Checker 调用。Checker 固定当前 checkpoint、Closure Profile 和 Creator Lens 图谱证据，不能直接写项目。
11. Checker 输出严格 findings：severity、category、target evidence refs、安全问题摘要和 repair objective。没有来源的评价不能成为阻塞项；Checker 不生成替代正文。
12. 有 blocking findings 时，Coordinator 为其创建 repair intent；Steward/Writer 在下一原子 Cycle 修复并提交 Change Set，然后重新执行 evaluator 和 Checker。只有 deterministic facets 全通过、Steward `ready_for_checker`、Checker `accepted` 且无未解决 blocking finding，内容才能 `closed`。
13. Closure 是 checkpoint-versioned（按检查点版本化）的临时闭环。后续故事或 OC 修改影响已关闭世界 facet 时，旧 review 失效并重新打开对应 closure，不能把一次 accepted 当永久真理。
14. 相同 finding fingerprint 连续两轮出现，或两个 repair Cycle 没有解决任何 finding 时，进入 `blocked / GROWTH_CLOSURE_REPAIR_STALLED` 等待用户；不得让两个 Agent 无限互相打回。
15. 用户中途修改角色秘密、世界规则或故事方向时，相关 sections、reviews 和图片进入受影响集合；修订后重新执行 evaluator，不把旧字符数直接算入当前闭环。
16. 定向测试覆盖 9,999/10,000 字符边界、Unicode、跨多个 prose 文档累计、superseded 版本排除、重复 filler 拒绝、Steward 提前自我通过无效、Checker 无来源 finding 拒绝、repair→recheck→accepted、重复 finding 停止、旧 closure 被下游修改重新打开、evaluation Cycle 成功终态和重开恢复。
17. 运行定向 Vitest、typecheck、Prompt publication gate。
18. 提交：`feat(growth): review and repair closure profiles`。

---

## Task 6：受影响节点分析与修订 Fragment

**Files:**
- Create: `src/agent-worker/growth/growthRevisionFragment.ts`
- Create: `src/agent-worker/growth/growthImpactBrief.ts`
- Modify: `src/agent-worker/stewardExecutionStateMachine.ts`
- Modify: `src/agent-worker/stewardRuntime.ts`
- Modify: `src/main/growthRunLifecycle.ts`
- Test: `tests/unit/growth-revision-fragment.test.ts`
- Test: `tests/unit/steward-execution-state-machine.test.ts`
- Test: `tests/unit/workspace-agent-tool-gateway.test.ts`

1. revision Cycle 必须先用最新 checkpoint、Creator Lens 和授权 scope 调用 `growth_v1` 检索。
2. 模型提交严格 Impact Brief：受影响 evidence refs、`revise/preserve/stale_visual` 决策、安全理由摘要和需要新建的世界/故事/OC 节点类型；不得提交数据库 ID、checkpoint 或权限字段。
3. Revision Fragment 允许更新已有稳定文档、断言和关系，也允许在授权父节点下创建新资源；编译器从 Receipt 映射真实 ID、expected head 和 source versions。
4. 所有创作正文、名称和事实来自模型 Fragment；编译器只负责 ID、依赖、来源和版本约束。
5. 一个 revision Cycle 只调用一次真实 Change Set executor。结构错误允许既有有限 pre-executor correction；Gateway/Domain/结果未知不得重提。
6. Main 发布安全影响事件，例如“规则 #2 影响 1 个世界、2 个地点、1 个故事和 3 张图片”；不发布模型思维链。
7. 回归覆盖：用户将“日式实体元素”修正为“轻小说叙事 + 原创西幻”时，world/story/OC 可在同一原子 Change Set 中更新，旧来源图片进入待 stale 集合；OC 新秘密也能反向修改故事冲突和世界历史。
8. 运行 3 文件定向 Vitest、typecheck、diff check。
9. 提交：`feat(growth): revise graph-backed content from new rules`。

---

## Task 7：持久 Illustration Queue 与多图执行

**Files:**
- Create: `src/main/growthIllustrationCoordinator.ts`
- Modify: `src/domain/asset/imageAssetRepository.ts`
- Modify: `src/domain/asset/imageGenerationService.ts`
- Modify: `src/main/workspaceAgentToolGateway.ts`
- Modify: `src/main/agentProcessSupervisor.ts`
- Test: `tests/unit/growth-illustration-coordinator.test.ts`
- Test: `tests/unit/image-asset-repository.test.ts`
- Test: `tests/unit/image-generation-service.test.ts`

**Default selection:**

- `bootstrap_world`：世界地图 1 张；至少 1 张主要国家/地点/势力的风貌 `scene`；其余高重要性节点由 Planner 选择。
- `bootstrap_story`：至少 1 张背景或关键故事 `scene`。
- `bootstrap_oc`：每个本轮主要 OC 默认 1 张 `character_portrait`。
- `revision`：只重绘来源已变化或新规则明确影响的当前图片；用户要求全量重绘时覆盖全部目标。
- 任意文本请求：用户选中段落、描述或对话文本后，可创建一张或多张 `scene`/`character_portrait` 插图；图像旁必须保留授权范围内的来源文字投影。

1. Change Set committed 后创建 Illustration Request；内容提交不等待全部图片完成。
2. 规划结果先持久化全部 items，再开始第一张图片调用。崩溃后从持久 item 状态恢复，不从审计日志猜计划。
3. 内部默认并发 1；可分页处理任意数量，队列长度不作为拒绝理由。Provider 限流进入等待/失败状态，不删除剩余 items。
4. 每个 Item 通过现有 `generate_image` Gateway。资源节点绑定 resource revision 与稳定文档 version；文本插图绑定 immutable text anchor、范围和 hash；幂等键由 request/item/anchor/source/style hash 确定。
5. source version 变化时，将现有 ready Asset 标记 `stale`；旧图片仍可回看，但 Showcase 当前主图只选择最新规则兼容版本。
6. 请求已发送后超时或结果未知进入 `reconciliation_required`，不得自动重复收费。
7. 回归覆盖：10/100/超过单批大小的队列、每节点一图、同一段文字多个变体、working snapshot、段落修改后 stale、取消未发送任务、崩溃重开、单项失败不丢后续项、Provider 缺失失败关闭、旧图 stale、新图 ready。
8. 运行 3 文件 Vitest、typecheck、build。
9. 提交：`feat(growth): queue source-bound illustrations without a product cap`。

---

## Task 8：中央推演流、右栏编辑与游戏图鉴展台

**Files:**
- Modify: `src/renderer/src/features/agent/StewardRuntimePanel.tsx`
- Modify: `src/renderer/src/features/agent/RunActivityTimeline.tsx`
- Modify: `src/renderer/src/features/activity/RunWorkTargetPane.tsx`
- Modify: `src/renderer/src/features/showcase/CreativeShowcase.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles/base.css`
- Test: `tests/unit/growth-presentation.test.ts`
- Test: `tests/e2e/growth-presentation-ui.spec.ts`
- Test: `tests/e2e/creative-showcase.spec.ts`

1. 用户保存指导后立即显示“规则 #N 已持久化，等待安全边界”；不得显示为已经应用。
2. revision Cycle 开始后显示安全影响摘要和目标 chips；提交后显示新增/修改/过期图片数量。
3. 右栏按真实状态呈现：正在修订的文档、图谱节点、旧/新版本、图片 queued/generating/ready/failed/stale。
4. Showcase 改成游戏图鉴式分区：世界总览与地图、国家/地区风貌、故事正文与背景、OC 卡与立绘、重要细节、关系图谱。核心渲染单元是 `{ sourceText, images[], sourceRef }`，支持图在上/左/右、文字环绕或多图画廊，而不是把图片堆在独立附件区。
5. 文档编辑器和图鉴允许选中任意段落/文本描述后发出“为这段配图”；用户也可对节点发出“再生成一张”“生成多个变体”“每个节点一张”“只保留文字”等请求。这些请求走 Main 持久 Illustration Request，不由 Renderer 直接调用图片 Provider。
6. 动画只延迟播放已收到的权威事件；failed/stale 不播放 ready 高潮。
7. E2E 覆盖无 Provider、图片部分失败、旧 scope、重载恢复、reduced-motion、100 项分页 UI；Fixture 仅称 UI 证据。
8. 运行 unit、两个 Electron E2E、typecheck、build；确认 Electron 残留为 0。
9. 提交：`feat(renderer): present revisable illustrated world growth`。

---

## Task 9：真实交互式 P0 Live 验收（只运行一次）

**Files:**
- Modify: `tests/e2e/real-provider-interactive-growth.spec.ts`
- Create: `notes/evidence/novax-desktop-growth/growth-interactive-illustrated-live-<timestamp>.json`
- Modify: `notes/status/2026-07-15-hackathon-growth-live-text-boundary.md`

**Scenario:**

1. 通过 UI 在“生长”模式输入：`生成一个中世纪日式冒险世界包，整体画风为二次元。` 断言 Goal 选择 `mixed_birth`，必须同时满足 world/story/oc 三类闭环，而不是创建三个空壳资源后停止。
2. C1 运行期间通过 UI 追加：`日式仅指轻小说叙事和成熟漫画手绘视觉，不出现真实日本元素，以原创西幻为主；将王权视觉锚点统一为“暮辉纹章”。`
3. 断言规则 #2 在当前 Cycle 提交前已持久化，但没有提前显示为应用。
4. 断言当前 Cycle 后先出现 revision Cycle，再由 Frontier Planner 自动继续所需的 world/story/oc/longform Cycle；不假定总轮数。每个 Cycle 的 revision、intent、checkpoint、Receipt 和 Change Set 连续且唯一。
5. 至少检查一个完整 Inquiry 链：当前 checkpoint 检索 → 3–7 条去重问题 → 一条 selected → 安全“正在推演”摘要 → 一个 Change Set → output checkpoint 重新检索 → Inquiry 状态更新。Evidence 不包含原始思维链。
6. 断言 World Closure 的天文/时间、地理/环境、历史、国家/制度、文化/经济、力量规则和当前冲突 facets 均由目标 scope 的稳定来源满足。
7. 断言 OC Closure 恰有一个默认焦点主角，具有详细 profile、world/story/relationship bindings，当前个人故事累计至少 10,000 Unicode 字符；其他主要 OC 具有完整 profile、来历、关系和较短个人经历。Story Closure 有历史背景、人物来历、起因、发展、转折和阶段性结局。
8. 至少观察一次真实 `ready_for_checker → repairs_required → repair Cycle → accepted`，或在首轮 Checker 已接受时证明其 findings 为空且所有结构 facets 已通过；不能用 Steward 自检替代独立 Checker。Checker requested/actual Provider、checkpoint、evidence links 和 review fingerprint 必须持久化且安全可审计。
9. 断言最终世界设定、故事正文和至少一个主要 OC profile 包含“暮辉纹章”及其一致含义；不以全库计数代替目标 scope 验证。
10. 断言最终图片至少包含：1 张地图、1 张世界风貌图、1 张故事场景图、每个主要 OC 的 1 张立绘；全部使用 `gpt-image-2`、最新 source versions 和默认漫画手绘风格策略。
11. 在故事正文中通过 UI 选中一个稳定段落并请求配图；断言新 Illustration Anchor 的 document version、字符范围和 text hash 正确，最终 Showcase 同时显示该段文字和 ready 图片。
12. 如果旧规则图片已发送并完成，断言其为 `stale` 且不作为当前主图；未发送旧任务应被取消。
13. 断言先出现“内容已闭环，视觉生成中”，只有默认图片集合 ready 后才出现“世界已诞生”；中央时间线、右栏修订状态、插图队列和游戏图鉴展台均来自真实公开事件。
14. 保存 Agent、自询、修订中、Checker 返工、长文生长中和最终 Showcase 截图；关闭/重开后规则、Inquiry、Closure State/Review、Cycle intent、文档、图谱、文本锚点、图片 Job/Asset 和当前/过期状态保持一致。
15. 独立 research-only Run 必须重新检索最新 checkpoint，不新增 Change Set、checkpoint、规则、Inquiry、Closure Review、Illustration Request、Job 或 Asset。

**Preflight commands:**

- `npm run typecheck`
- `npm run verify:prompt-publication`
- `git diff --check`
- `npm run build`
- 确认本工作树 Electron / Playwright 残留为 0。

**唯一真实命令:**

`$env:NODE_USE_ENV_PROXY='1'; npx --no-install playwright test tests/e2e/real-provider-interactive-growth.spec.ts --workers=1 --retries=0`

**Stop rule:** Provider 启动后，无论成功或首次失败均停止；不得在同一候选上修复后盲目重跑。Evidence 只记录模型身份、规则 revision、Cycle/Change Set/checkpoint/图像计数、状态、哈希和安全布尔值，不记录原文、Prompt、工具参数、locator、路径或凭证。

---

## Task 10：冻结与集中验收

**Files:**
- Create: `notes/status/2026-07-<day>-hackathon-interactive-growth-p0-freeze.md`
- Modify: `notes/engineering/hackathon-debt-register.md`

1. 只有 Task 9 Live 成功后才能标记 P0 closed；否则记录精确首次失败和恢复入口。
2. 代码冻结后集中运行一次：
   - `npm test`
   - `npm run typecheck`
   - `npm run verify:prompt-publication`
   - `npm run build`
   - 定向无 Provider Electron E2E。
3. 检查迁移重放、取消、崩溃恢复、Provider 缺失、图片部分失败、结果未知和残留进程。
4. 按语义拆分提交，不提交密钥、临时工作区、构建产物、失败截图目录或伪 Live。
5. 明确未完成：Player 回合、导出、安装包、连续三次演示和赛后主线兼容审查。

---

## 推荐执行顺序与文件所有权

必须串行执行 Task 1–7，因为它们共同修改 Growth 合同、Coordinator、状态机、自询、闭环评估或迁移。Task 8 只能在 Task 7 的 IPC 投影冻结后开始。Task 9 只在全部确定性验收通过后运行一次。禁止多个 Agent 同时修改 `growthCoordinator.ts`、`stewardExecutionStateMachine.ts`、`growthContract.ts`、`workspaceRepository.ts` 或 `ipcContract.ts`。

建议使用短会话逐批执行：

1. Persistence/ADR 执行会话：Task 0–1。
2. Growth Runtime 执行会话：Task 2–3。
3. Inquiry 执行会话：Task 4。
4. Closure/Longform 执行会话：Task 5–6。
5. Illustration Queue 执行会话：Task 7。
6. Renderer 执行会话：Task 8。
7. Live Acceptance 执行会话：Task 9。
8. Worktree Head：每批审查、提交与最终 Task 10。

每个会话只接收一个有界 Task，不自行进入下一阶段。
