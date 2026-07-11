# Retrieval Domain（检索领域）

Last verified（最近验证）: 2026-07-10

`ContextPacketService`（上下文包服务）只接受调用方明确提供的 `scopeResourceIds`（范围资源标识）。它从当前活动分支的检查点祖先链读取：

- 当前有效且范围匹配的 Canonical Assertion（权威断言）。
- 每个明确范围资源的当前 Stable Document Version（稳定文档版本）。
- 位于同一祖先链上的已提交 Change Set（变更集）来源，以及已接受的具体变更项。

以下数据不会进入上下文包：

- Dirty Working Copy（未稳定工作副本）。
- 回溯后仅存在于归档未来分支的资源、文档、断言或 Change Set 来源。
- 未列入 `scopeResourceIds` 的其他 Story Project（故事项目）范围。
- 原始 `source_records.ref`、文件路径或 locator（定位串）。

## Retrieval Budget（检索预算）

`ContextPacketService` 已强制执行以下默认上限：

- `maxDocuments: 12`：最多返回 12 个稳定文档。
- `maxAssertions: 200`：最多返回 200 条当前权威断言。
- `maxDocumentChars: 20_000`：单个稳定文档最多返回 20,000 个 JavaScript UTF-16 code units（JavaScript UTF-16 代码单元，当前实现中的“字符”定义）。
- `totalChars: 160_000`：断言序列化字符数与实际返回的文档内容字符数合计不得超过 160,000。

安全硬上限分别为 50 个文档、1,000 条断言、单文档 100,000 字符和总计 500,000 字符；越界预算直接返回 `CONTEXT_BUDGET_INVALID`，不会退回无限读取。

预算分配顺序固定为：

1. 断言按 Repository（仓储）已有的 `subject -> predicate -> assertionId` 稳定顺序取前缀。
2. 文档按调用方提供的去重 `scopeResourceIds` 顺序取前缀。
3. 当前不执行 Semantic Ranking（语义排序）、关键词相关性或“更重要内容”猜测，返回元数据固定声明 `relevanceRanking: not_applied`。

`totalChars` 只计算完整返回断言的 `JSON.stringify` 长度和文档 `content` 实际返回长度，不代表整个 IPC（进程间通信）消息的字节数或模型 Token（词元）数。每个返回文档包含 `contentState.complete/originalChars/returnedChars`；整个上下文包包含：

文档裁切不会在 UTF-16 surrogate pair（UTF-16 代理对）中间截断；因此遇到边界 Emoji（表情符号）等字符时，实际返回字符数可能比剩余预算少一个代码单元，但绝不会超过预算。

- 实际用量和生效预算。
- `incomplete` 状态。
- 省略的断言与文档数量。
- 被裁切的文档数量。
- 触发的具体上限。
- 实际采用的稳定顺序及未使用相关性排序的声明。

只要存在省略或文档裁切，`incomplete` 必须为 `true`。调用 Agent 不得把这种上下文描述为完整资料，也不得根据被省略部分自行补全事实。

当前仍未实现 Semantic Ranking（语义排序）、FTS5 Full-text Search（FTS5 全文检索）、文档分块或真实 Token Budget（词元预算）。因此当前结果只是“明确范围内按稳定顺序返回的有界前缀”，不是“与用户问题最相关的全部证据”。

验证结果：

- `npm.cmd run typecheck`: passed
- `npm.cmd test`: 21 个测试文件、93 个测试通过
- `npm.cmd run build`: passed
- `npm.cmd run test:e2e`: 10 个 Electron Playwright（桌面实机自动化）测试通过
