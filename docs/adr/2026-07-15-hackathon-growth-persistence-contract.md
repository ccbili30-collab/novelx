# ADR: 黑客松 Growth Goal/Cycle 持久化合同

日期：2026-07-15

状态：已实现，等待父级最终验收。

## 决策

黑客松分支以 SQLite schema v23 的加法表持久化 Growth Goal（生长目标）、规则修订、Growth Cycle（生长循环）、Retrieval Receipt（检索凭证）与安全事件。本层只保存已授权元数据；不执行图检索、不启动 Agent（智能体）、不调用 Provider（模型服务）、不提交 Change Set（变更集），也不拥有 Canon（正史）、Run（运行）、权限或恢复决策。

每个 Cycle 最多一个 Run、Receipt、已提交 Change Set 和输出 Checkpoint（检查点）。只有已提交 Change Set 的真实 base/output checkpoint 可使 Cycle committed。Outcome Unknown（结果未知）必须进入 reconciliation_required，禁止后续 Cycle。

## 合同与审计边界

- 共享合同使用严格 Zod；未知字段和 Player Lens（玩家视角）失败关闭。v1 Event 只持久化 Cycle 事件：cycle_planned、run_attached、receipt_recorded、change_set_committed、cycle_terminal。虽然 v23 数据库 CHECK 为兼容已接受更宽集合，所有写入均经更窄的 shared schema 与 Repository（仓储）约束。
- Goal 只接受 text/source_document/resource 三类 seed（种子）。长小说只存文档/版本引用，不复制全文。resource/source_document 的指定版本必须在 Goal 固定 checkpoint 的递归祖先链可见，不能仅因全库存在而通过。
- Receipt 创建输入不允许 hashes、派生 counts 或 createdAt。Repository 以 canonicalAuditHash 从有效查询参数生成 queryHash，并以 coverage、truncated、按 rank 排序的 links 生成 resultHash；hit/conflict/locator counts 与 createdAt 同样由仓储生成。Receipt id 是不可变重放键；相同规范化输入返回既存 Receipt，不同输入失败关闭。
- Receipt links 的 rank 必须按数组连续 1..N；reason code/path target 去重；稳定 locator/version/hash 必须全有或全无。complete coverage 不可同时 omitted 或 truncated。
- Event append 输入不接受 createdAt；Repository 生成时间并以 (goalId, sequence) 实现精确重放。listEvents 供未来 UI 读取单调历史。Event 不保存通用 payload、Prompt、工具参数、原始日志、思维链或磁盘路径。
- contentRef 只允许稳定的 document/resource/assertion/relation/change_set 版本，不允许 image 或 working copy。它必须属于 Goal branch，且在 running/planned/非提交终态的 input checkpoint，或 committed 的 output checkpoint 可见。change_set_committed 目标必须等于 Cycle 已绑定 Change Set/output checkpoint。
- Creator/Player Lens 与权限仍由未来服务端接入层执行；本合同仅接受 creator，player 输入失败关闭。

## 迁移与恢复

v22→v23 仅新增 growth_* 表和索引；不重写资源、文档、断言、Change Set、审计或图片记录。旧二进制遇到 schema 23 必须按既有 schema gate 失败关闭。

赛后是否复用、重写或放弃本层由 Main Head（主线负责人）重新决定；不得自动合并长期主线。回退只允许在备份副本中删除 v23 加法表并将 schema version 回设 22。该操作会丢失 Growth 元数据，不得静默执行，也不是运行时自动恢复策略。

## 不包含

- 图查询、向量召回、别名、N-hop（多跳）推演或相关性排序。
- Agent 编排、IPC（进程间通信）、Renderer（渲染层）、Provider 或 Live（真实运行）验收。
- 修改 A2.2 Runtime（第二版运行时）恢复/权限/审计语义，或 Change Set/Checkpoint 提交语义。
