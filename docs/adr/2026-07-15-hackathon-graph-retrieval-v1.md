# ADR: 黑客松 Creator Lens 图检索 v1

日期：2026-07-15

状态：已实现，等待父级最终验收。

## 决策

Graph Retrieval（图检索）v1 是 NovelX Domain Runtime（领域运行时）的内部只读服务。它在明确的 branch/checkpoint、Creator Lens（创作者视角）与授权资源范围通过验证后，才读取该检查点祖先链上的资源、稳定文档、current/conflict 断言、显式创作关系和断言中的 entityRef/entityRefs。

查询使用 Unicode NFKC 规范化和字面/显式 alias 匹配；不使用 embedding、向量索引、Provider（模型服务）或隐式别名发现。评分只使用已冻结的 Receipt reason codes，并以分数、类型、ID、版本进行确定性排序。图遍历只使用显式关系和实体引用边，受 maxHops、扩展、CPU、结果、token/字符预算约束。

## 边界

- 查询固定到具体 checkpoint，不读取后续 head；不要求 sealed_at，因此可用于初始未 sealed 的 Growth checkpoint。
- 授权 scope 可为 domain root；匹配和遍历只纳入其在该 checkpoint 可见的后代。跨 scope seed 失败关闭。
- 非空 validTime/recordedTime 失败关闭：当前 Domain evidence 未实现时间语义，不能伪装过滤支持。
- 查询输出包含两层：仅在本次 Creator 授权、pinned checkpoint 内存中存活的 ephemeral authorized evidence hits，以及可由 `GrowthRepository` 验证和持久化的 `GrowthRetrievalReceiptCreate` 兼容 Receipt。Receipt 不持久化原始证据内容；每条 link 使用真实 targetVersionId；文档证据携带稳定、非磁盘路径 locator、真实文档版本与 content SHA-256。
- Assertion source 不返回 `source_records.ref`、文件路径或原始 locator。`document_version` 仅在该版本位于 pinned checkpoint 祖先链且资源位于有效 scope 时，投影为安全的 `stable_document`（资源 ID、标题、版本 ID）；其他种类或不可见来源仅返回 allowlisted `unresolved` 原因，不泄露原始引用。
- conflict 是已命中证据的属性，不是召回理由；未知查询返回空的 unknown coverage，不注入全库上下文。
- CPU、扩展、内容或结果预算提前停止时，coverage 为 partial 且 truncated 为 true。`omittedCount` 是已知遗漏项的保守下界；服务不会把未枚举的候选说成已经完整搜索。

## 不包含

- Agent Worker、Main/IPC、Renderer、公开协议、UI、Provider 或 Live（真实运行）演示。
- Canon（正史）提升、Change Set 写入、权限或 Player Lens 语义。
- 语义别名、时间过滤、向量 RAG 或整库上下文注入。
