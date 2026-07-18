# Semantic Graph（语义图谱）领域合同

Last verified（最近验证）: 2026-07-18

Semantic Graph（语义图谱）是当前 Canonical Assertion Version（权威断言版本）的只读投影，不是独立事实存储。

## 当前投影规则

- 只读取当前活动分支检查点祖先链中的最新 assertion version（断言版本）。
- 当前图谱显示 `current`（当前有效）与 `conflict`（冲突）状态；已取代、已拒绝和草稿版本不进入当前快照。
- 每条断言生成 Subject Node（主题节点）、Fact Node（事实节点）以及以 predicate（谓词）命名的边。
- 自然语言内容不会被关键词或字符串匹配推断为关系。
- 只有断言对象明确包含以下结构时，才生成 Fact-to-Entity Edge（事实到实体边）：

```ts
{
  entityRef?: { resourceId: string; relation?: string };
  entityRefs?: Array<{ resourceId: string; relation?: string }>;
}
```

- 被引用资源必须在当前活动分支中存在；归档未来或已删除资源不会投影。
- 当前检查点可见的 Causal Relation Version（因果关系版本）会在两个 Fact Node（事实节点）之间投影为定向因果边；端点缺失时整条边不进入快照。
- 因果边只公开安全机制摘要、`current|conflict` 状态、`confirmed|inferred|disputed` 认识状态，以及去除内部 source ID/hash 的来源版本与稳定定位。
- 默认 Lens（观察视角）固定为 Creator Lens（创作者视角）。Character Knowledge Lens（角色认知视角）尚未实现，API 明确返回 `characterLensAvailable: false`，不能视为已有能力。

## Causal Relation（因果关系）政策

Task 7 已冻结内部领域政策，Task 8 已加入 SQLite v29 版本化持久化，Task 9 已接入原子 Change Set，Task 10 已接入 Creator Lens 投影、上下游有界检索与 Renderer 展示。Player Lens 仍失败关闭，不能把 Creator Lens 因果边视为玩家可见信息。

- 因果端点必须是两个不同的 assertion identity（断言身份）；原始正文、模糊实体 ID 和自环都不是合法端点。
- 固定关系类型为 `causes`、`enables`、`constrains`、`prevents`、`amplifies`、`mitigates` 和 `depends_on`，不得用任意字符串扩展。
- 每条边必须声明机制、适用条件、时间范围、方向/强度文字摘要、认识状态和至少一个精确来源引用。
- 认识状态只允许 `confirmed`、`inferred`、`disputed`；模型置信度、相似度和 `unknown` 不能冒充领域认识状态。
- feedback loop（反馈环）由多个不同断言之间的有向边表达，不能用自环缩写。
- 相关性、共现或没有机制/来源的推断失败关闭；不影响发展的纯描述文本不强制制造因果边。
- `validateCausalRelationSet` 拒绝重复身份和同类型同端点重复边，但允许 A→B 与 B→A 两条有来源的独立边。

政策规格位于 `tests/unit/causal-relation-policy.test.ts`；持久化规格位于 `tests/unit/causal-relation-repository.test.ts`。`CausalRelationRepository` 按 checkpoint ancestry（检查点祖先关系）解析最近版本，只投影 `current` / `conflict`，由 `deleted` 墓碑隐藏后代视图；写入会验证端点断言和精确来源在目标 checkpoint 可见，并拒绝跨分支未来数据、身份改写和冲突重放。

## 安全 IPC（进程间通信）

Renderer（渲染进程）只获得哈希化节点键、语义标签、范围、状态、关系数量、用户可读来源摘要和 Creator Lens 因果边的安全来源引用。以下字段不会通过图谱 API 暴露：

- 原始 `source_records.ref`。
- 文件路径、数据库位置，或未经清理的定位串。因果边只公开经过路径清理和长度限制的稳定定位。
- Causal source record（因果来源记录）的内部 ID 与来源哈希。
- checkpoint（检查点）标识。
- assertion object（断言对象）或 Change Set payload（变更集负载）的原始 JSON。

公开 API：

- `window.novaxDesktop.graph.getSnapshot()`
- `window.novaxDesktop.graph.inspectNode({ nodeId })`

Main-only（仅主进程）的 `inspectCreatorNodeEvidence(nodeId)` 可把哈希节点键解析回当前分支的来源资源，用于来源绑定插图。原始资源 ID 不进入公开图谱投影；Main 仍须再按 Growth Goal 授权范围验证。

## 未完成边界

- 未实现 Character + Timeline Lens（角色 + 时间线视角）。
- 未实现用户直接编辑图谱、节点合并/拆分和布局持久化。
- 已实现版本化因果关系、Change Set 原子写入、Creator Lens 服务投影、IPC 安全投影、Renderer 展示与有界上下游检索；未实现 Player Lens 因果投影。
- 未实现分页或超大图增量加载；当前快照有明确 Schema（结构模式）上限，超限会失败关闭。
- 未实现 Custom Type Registry（自定义类型注册表）；当前 `semanticType` 来自稳定资源类型或通用 concept/assertion 类型。

## 验证入口

- `tests/unit/semantic-graph-service.test.ts`
- `tests/unit/graph-retrieval-service.test.ts`
- `tests/unit/semantic-graph-rendering.test.ts`
- `tests/unit/ipc-contract.test.ts`
- `tests/e2e/semantic-graph-ui.spec.ts`
