# Change Set Service（变更集服务）

`ChangeSetService` 是正式内容写入的领域入口。Agent Worker（代理工作进程）只能提出候选，不能导入 `ChangeSetRepository`、`AssertionRepository`、`ResourceRepository`、`DocumentRepository` 或 `CheckpointRepository` 直接写库。

## 已实现合同

- Assist（协助）模式逐项记录 `accepted`、`rejected` 或 `draft` 决策；仍有 `pending` 项时不能提交。
- Free（自由）模式只在受信任的 `ChangeSetPolicyEvaluator`（变更策略评估器）把全部项目判定为低风险且没有重大冲突时自动提交。
- 任一 `major` 冲突都会把策略门标记为 `blocked`；不能靠逐项接受绕过。
- 接受项必须同时接受它的全部显式依赖；依赖断裂不会静默提交。
- 提案和最终提交都绑定基线 Checkpoint（检查点）；当前分支头变化后，旧提案不能覆盖新版本。
- 候选内容使用完整负载哈希实现幂等；相同 key（键）但不同内容会失败。
- 正式写入、检查点前移和状态变更位于同一 SQLite 事务；应用器失败时全部回滚，并把变更集记录为 `failed`。
- `WorkspaceChangeSetApplier`（工作区变更应用器）当前支持 Assertion（断言）、Resource（资源）和稳定 Document Version（文档版本）三类真实领域写入。
- 正式 Assertion（断言）的数据库来源由服务写成实际已提交 Change Set（变更集），Agent 候选不能伪造“用户确认”来源；Agent 文档变更也不能冒充 `user` 作者。
- Agent 新断言必须提交当前分支的证据版本 ID。`WorkspaceChangeSetPolicy` 验证证据、Scope、资源依赖、重复创建、断言身份和值冲突；提交后把确认变更集与证据版本共同写入来源链。

## 尚未闭环

- 当前 `WorkspaceChangeSetPolicy` 是结构 Validator（验证器），不接受 Agent 自报风险，并已由 Main Process 注入。它不能识别任意自然语言隐含冲突，仍需真实 Checker/Validator 增强语义检查。
- Agent tool（代理工具）已经通过 Main Process 工具网关接线；Worker 仍不能导入可写 Repository（仓储）。
- 历史测试仍使用已标记 deprecated（弃用）的 Repository setup helper（仓储测试搭建辅助接口）构造旧版本数据。它不应进入 Agent 或 live（真实运行）路径。

## Renderer Review IPC（渲染进程审查接口）

Preload（预加载层）只公开 `listPending`、`get`、`decide` 和 `finalizeAssist`。它不公开 `propose`、通用 `commit`、Repository（仓储）或数据库访问。

审查投影只包含创作语义摘要、正文预览、公开 item kind（项目类型）、决策、风险、依赖和折叠后的公开冲突码。原始 payload（负载）、JSON、Source ref（来源定位符）、机器路径、Checkpoint ID（检查点标识）、内部 Policy code（策略码）和调试错误不会进入 Renderer。没有打开工作区、版本陈旧、依赖断裂和重大冲突都返回固定公开错误；重大冲突即使逐项选择接受仍不能 finalize（完成提交）。
