# Durable Global Event Order（持久全局事件顺序）

状态：Implemented foundation（已实现基础层），尚未接入 Run Cancellation Intent Proof（运行取消意图凭证）。

## 目标

`runtime_events` 与 `workspace_events` 必须共享一个可审计的写入顺序。全局 CAS（比较并交换）不能只依赖一个可修改的计数器；每个迁移后的事件都必须能反查它实际获得的 `globalSequence`（全局序号）。

## 0006 迁移策略

旧数据库的两张事件表只有各自的流内序号。`created_at`（创建时间）、SQLite `rowid`（行号）和表内序号都不能证明两张表的真实交错顺序。因此 0006 不为旧事件编造全局序号：

- 迁移时记录 `legacy_runtime_event_count` 与 `legacy_workspace_event_count`。
- 旧事件通过 API 返回 `GlobalEventOrder::LegacyUnordered`（旧事件顺序未知）。
- 两表旧事件总数成为 `ordered_sequence_base`（有序序号基线）。
- 第一条迁移后事件获得 `ordered_sequence_base + 1`，之后严格连续。
- 旧 global clock（全局时钟）只用于损坏检查，不作为历史顺序证据；若其值大于实际事件总数，迁移 fail closed（失败关闭）。

## 持久结构

- `runtime_database_identity`：单行、不可插入第二行、不可更新、不可删除的 UUID。
- `runtime_global_event_ordering`：单行、不可变的迁移边界与旧事件计数。
- `runtime_global_event_ledger`：append-only（只追加）全局账本；每行绑定一条 runtime 或 workspace 事件。
- `runtime_legacy_unordered_events`：逐条标记迁移前事件，使合法的 `LegacyUnordered` 与迁移后账本缺失可以被区分。
- 两张事件表的 `AFTER INSERT`（插入后）触发器在同一 SQLite 事务中把下一连续序号写入账本。
- 当前全局序号从账本 `MAX(global_sequence)` 或无新事件时的基线读取，不再维护可外部 `UPDATE`（更新）的时钟行。
- 所有可能进入 RPC（远程过程调用）或哈希的 run、aggregate、workspace、stream、global 与 base 序号都限制在 JavaScript `MAX_SAFE_SEQUENCE`（最大安全整数）以内。

## 完整性屏障

完整性检查分为两层：

1. `EventJournal::open`（事件账本打开）只执行 O(1) 的迁移检查和结构检查，适用于频繁命令路径。
2. `verify_deep_data_integrity`（深度数据完整性检查）在稳定只读事务中扫描事件、旧事件标记、账本连续性与外键。正式 Runtime（运行时）初始化会在 `runtime.ready`（运行时就绪）之前强制执行深检；深检失败时不会进入可接收命令状态。

结构检查包括：

- 0001 到 0006 migration checksum（迁移校验和）。
- 事件表、关键索引、所有 0006 表与触发器的大小写敏感精确 SQL（只折叠无意义空白和末尾分号）。
- 同名 no-op trigger（空操作触发器）会阻止打开。
- UUID 使用规范小写连字符格式。
- 旧可变 global clock 及其触发器已不存在。

深检额外验证旧事件计数、逐条旧事件标记、账本引用、连续序号和 Foreign Key（外键）完整性。

## 已知边界

`databaseInstanceId`（数据库实例标识）识别的是数据库血统，不是物理文件副本。完整复制数据库会保留同一个 ID，这是预期行为；因此它能识别“同一路径被另一数据库替换”，不能单独识别两个克隆数据库正在分叉写入。克隆检测需要未来额外的 host installation ID（宿主安装标识）、lease epoch（租约代次）或显式 fork lineage（分叉血统），不属于 0006。

SQLite 文件及 raw SQL write permission（原始 SQL 写权限）属于可信单写者边界。触发器与深检可以捕获程序错误、意外损坏和一部分直接篡改，但它们不是 cryptographic tamper-evidence（密码学防篡改证明）。拥有数据库文件写权限的攻击者可以同时重写数据、schema（模式）和迁移记录；如需对抗该威胁，必须另加外部签名、密钥保护或不可变远端审计日志。

本层也没有完成 `RunCancellationIntentProof`（运行取消意图凭证）从 path hash（路径哈希）迁移到 `databaseInstanceId + exact globalSequence`（数据库实例标识加精确全局序号）的接线；在该接线与回归测试完成前，A2.1 不能宣称闭环。
