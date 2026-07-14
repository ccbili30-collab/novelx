# ADR: 黑客松 Growth Goal/Cycle 持久化合同

日期：2026-07-15

状态：代码实现待定向测试与父线程验收

## 决策

为黑客松的目标驱动世界生长增加独立的 SQLite v23 加法表与严格共享合同：Growth Goal（生长目标）、规则修订、Growth Cycle（生长循环）、检索凭证、凭证链接和安全事件。

该层只记录已发生或已被上游授权的元数据。它不执行检索、不启动 Agent、不调用 Provider（模型服务）、不提交 Change Set（变更集），也不拥有 Canon（正史）、Run（运行）、权限或恢复决策的权威。

每个 Cycle 最多绑定一个 Run、一个 Retrieval Receipt（检索凭证）、一个已提交 Change Set 和一个输出 Checkpoint（检查点）。只有已提交 Change Set 的实际 base/output checkpoint 可把 Cycle 标为 committed。Outcome Unknown（结果未知）必须进入 reconciliation_required，不能创建下一 Cycle。

## 合同与安全边界

- 共享合同使用严格 Zod；未知字段、Player Lens（玩家视角）、重复 scope/rank、非稳定 content reference（内容引用）和不一致终态失败关闭。
- Goal 仅保存 text/source_document/resource 三种 seed（种子）；长小说只保存来源文档和版本标识，不复制全文。
- Receipt 保存受限的查询与预算元数据、哈希、覆盖状态和链接；不把查询结果、Prompt、工具参数或模型思维链写成通用 payload。
- Event 仅保存 allowlist phase（允许阶段）、安全摘要、类型化目标与稳定内容引用；不允许 working copy、路径、原始日志或 draft 冒充 committed。
- Creator/Player Lens 与权限仍由未来服务端接入层执行。本批合同只接受 creator，Player 输入明确失败关闭。

## 迁移与恢复

v22→v23 只新增 growth_* 表和索引，不重写旧资源、文档、断言、Change Set、审计或图片记录。旧二进制遇到 schema 23 应按既有 schema gate 失败关闭。

赛后是否复用、重写或放弃本层由 Main Head（主线负责人）重新决定；不得自动合并到长期主线。若需回退，只允许在备份副本删除 v23 的加法表并把 schema version 回设为 22。该操作会丢失 Growth 元数据，故不得静默执行，也不能作为运行时自动恢复策略。

## 不包含

- 图查询、向量召回、别名、N-hop（多跳）推演或相关性排序。
- Agent 编排、IPC（进程间通信）、Renderer（渲染层）、Provider 或真实 Live（真实运行）验收。
- 修改 A2.2 Runtime（第二版运行时）恢复/权限/审计语义，或修改 Change Set/Checkpoint 的提交语义。
