# ADR-0004: Runtime Event Stream Addressing

## Status

Accepted on 2026-07-12.

## Context

Runtime V2（第二版运行时）当前只有一个 `runtime_events` 表：

```text
(run_id, sequence) primary key
message_id unique
event_type
payload_json
created_at
```

`sequence` 是单个 Run（运行）内的连续序号。`RunAggregate`（运行聚合）读取整个 Run 流并重放 `run.*` 事件。这个结构足以证明 Run 状态的持久化和恢复，但未来 Tool（工具）、Goal（目标）、Plan（计划）和 Agent（智能体）都需要独立聚合：它们必须能按自身地址和版本重放，同时又必须保留同一 Run 内的全局因果顺序，供恢复、投影、诊断和跨聚合约束使用。

如果只给每个聚合增加独立序号，则无法回答“Tool 完成和 Plan 修订谁先发生”；如果只保留 Run 全序，则重放一个长生命周期 Tool/Agent 必须扫描整个 Run，且无法用数据库约束阻止同一聚合的并发旧版本写入。

当前 `0001_event_journal.sql` 还没有 migration ledger（迁移账本），`EventJournal::open()` 每次只执行 `CREATE ... IF NOT EXISTS`。该方式不能可靠演进已有严格表、索引和 immutable trigger（不可变触发器）。

## Decision

采用 **Run 全序 + Aggregate 地址 + Aggregate 局部序号**。

每个事件同时属于：

1. 一个 Run 全局流，由 `(run_id, run_sequence)` 唯一定位；
2. 一个聚合流，由 `(run_id, aggregate_type, aggregate_id, aggregate_sequence)` 唯一定位。

Run 全序是跨聚合的权威提交顺序。Aggregate 局部序号是单聚合乐观并发和高效重放的权威版本。两者在同一个 SQLite `BEGIN IMMEDIATE` 事务中分配并写入，不能先写一个再补另一个。

### Addressing Contract

V2 事件行采用以下逻辑字段：

```text
run_id                 TEXT
run_sequence           INTEGER > 0
aggregate_type         TEXT
aggregate_id           TEXT
aggregate_sequence     INTEGER > 0
message_id             TEXT globally unique
idempotency_key        TEXT
event_type             TEXT
event_version          INTEGER > 0
payload_json           TEXT JSON
created_at              TEXT
```

首批 `aggregate_type` 固定为：

- `run`
- `tool`
- `goal`
- `plan`
- `agent`

类型值属于存储协议，不使用 Rust enum 的调试字符串。新增类型需要 migration/runtime capability（迁移/运行能力）升级。

`aggregate_id` 只在 `(run_id, aggregate_type)` 内解释；Run 聚合使用 `aggregate_type='run'` 且 `aggregate_id=run_id`。Tool、Goal、Plan 和 Agent 使用各自稳定 UUID，不复用 UI 临时 ID。

### Ordering And Concurrency

- `run_sequence` 在同一 Run 内从 1 连续增长，给投影和跨聚合恢复提供全序。
- `aggregate_sequence` 在同一聚合地址内从 1 连续增长。
- append 接口同时接受 `expected_run_sequence` 和 `expected_aggregate_sequence`。
- SQLite 事务读取两个当前最大值，任一不匹配都失败，不追加事件。
- 事务成功后才更新内存聚合；事务失败时内存不变。
- 不允许用“只校验 aggregate sequence”绕过 Run 全序，因为这样无法确定并发聚合事件的提交次序。

这会使同一 Run 的写入在 SQLite 内短暂串行化。NovelX 的瓶颈是 Provider 和工具执行，不是本地事件 INSERT；优先选择确定性，而不是为假设的超高事件吞吐牺牲恢复语义。

### Event Identity And Idempotency

`message_id` 与 `idempotency_key` 分工：

- `message_id` 是已持久化事件/传输 envelope（信封）的全局唯一身份。两个不同事件不得共用。
- `idempotency_key` 是一次 append intent（追加意图）的稳定去重键，在 `(run_id, idempotency_key)` 上唯一。
- 同一 idempotency key 重试时，只有 `aggregate address + expected sequences + event_type + event_version + canonical payload hash` 全部一致，才返回原事件。
- 同 key 不同语义返回冲突；同 message ID 不同语义也返回冲突。
- Aggregate API 不把随机 message ID 当业务幂等键。调用方必须为可重试命令提供稳定 idempotency key。

这保留网络/进程重试能力，同时阻止当前 strict `append_after` 所防范的重复状态迁移。

### Aggregate Replay

Journal 提供两类读取：

```text
read_run(run_id, after_run_sequence)
read_aggregate(run_id, aggregate_type, aggregate_id, after_aggregate_sequence)
```

`read_run` 用于全局恢复、投影和诊断；`read_aggregate` 用于单聚合纯重放。单聚合查询必须按 `aggregate_sequence` 排序，并验证：

- 序号从 1 连续；
- 首事件是该聚合允许的创建事件；
- event type/version 已知；
- payload schema（载荷结构）严格；
- 状态迁移合法且只有一个终态。

聚合恢复不得依赖同 Run 中其他聚合的 payload。跨聚合约束由 Run coordinator（运行协调器）按 `run_sequence` 重放或读取明确的关联 ID 完成，不能隐式扫描自然语言。

### Unknown Event Versions

事件身份是 `(aggregate_type, event_type, event_version)`。

- 已知旧版本通过纯函数 upcaster（向上转换器）转为当前内存事件；原始行不修改。
- 未知 event type、未知 event version 或未知 aggregate type 在权威恢复路径上一律 fail closed（失败关闭）。
- 旧 runtime 遇到更新 runtime 写入的未知版本时，不得继续 live write（在线写入），只允许报告需要升级和导出只读诊断。
- Projection（投影）也不能静默跳过未知事件；否则 UI 会展示一个看似完整但实际缺事件的状态。
- 删除 upcaster 前必须有数据库最低版本门和升级证据，不能依赖“线上应该没有旧事件”。

### SQLite Schema And Indexes

目标表保留 append-only trigger，并至少建立：

```sql
PRIMARY KEY (run_id, run_sequence)
UNIQUE (run_id, aggregate_type, aggregate_id, aggregate_sequence)
UNIQUE (message_id)
UNIQUE (run_id, idempotency_key)

INDEX runtime_events_aggregate_replay
  (run_id, aggregate_type, aggregate_id, aggregate_sequence)

INDEX runtime_events_run_type_order
  (run_id, aggregate_type, run_sequence)
```

第一个唯一约束保护 Run 全序；第二个保护聚合版本；两个查询索引分别支持单聚合重放和按类型构建 Run 投影。`PRIMARY KEY (run_id, run_sequence)` 已覆盖普通 `read_run`，不再保留与主键完全重复的 `runtime_events_run_order` 索引。

不为 `event_type` 单独建立全库索引。主要查询必须先限定 Run 或 aggregate；全库事件类型统计属于离线诊断，不应增加每次 append 的写放大。

### Migration From 0001

新增 `runtime_schema_migrations(version, applied_at, checksum)`，以后 migration 只执行一次并校验 checksum。不能继续只靠 `CREATE TABLE IF NOT EXISTS` 推断 schema 版本。

`0002_event_stream_addressing.sql` 在单个 `BEGIN IMMEDIATE` 中：

1. 验证旧表只包含 0001 列和约束预期；不匹配则停止。
2. 删除旧表的 no-update/no-delete triggers。
3. 创建 `runtime_events_v2` 及新约束。
4. 按旧表 `(run_id, sequence)` 拷贝：
   - `run_sequence = sequence`
   - `aggregate_type = 'run'`
   - `aggregate_id = run_id`
   - `aggregate_sequence = sequence`
   - `event_version = 1`
   - `idempotency_key = message_id`
5. 比较行数、每 Run 最大序号和 payload JSON 有效性。
6. 重命名旧表为临时备份、新表为 `runtime_events`。
7. 建立新索引和 immutable triggers。
8. 写入 migration ledger 后删除事务内临时备份并 COMMIT。

旧 0001 数据全部被解释为 Run 聚合事件。这是当前事实：0001 的正式聚合只有 RunAggregate。早期 `turn.started`/`tool.completed` journal 单元测试数据只是测试 fixture（夹具），不代表已发布的 Tool 聚合契约；迁移测试仍必须证明这些任意 event_type 可无损复制，但权威 RunAggregate 重放可以按原规则拒绝未知事件。

### Migration Of Existing 0001 Tests

现有测试按以下方式迁移：

- `appends_monotonic_events_per_run...`：断言 `run_sequence` 仍按 Run 单调，同时补同 Run 两个 aggregate 各自 `aggregate_sequence=1`。
- `duplicate_message_id_is_idempotent...`：改为同 `idempotency_key` 同语义返回原事件；另保留 message ID 冲突测试。
- `concurrent_connections...`：同时断言 Run sequence 唯一连续，以及每个聚合局部 sequence 连续。
- `update_and_delete...`：继续验证迁移后 triggers，增加迁移前旧行也不可修改/删除。
- `RunAggregate` 恢复测试：改用 `read_aggregate('run', run_id)`；另用 `read_run` 验证全序与局部序号一致。
- 新增 `0001 -> 0002` 文件数据库测试：关闭连接、以 0001 fixture 重开执行 migration、核对所有旧行字段、索引、trigger 和 migration checksum。

测试不得直接把 0001 表结构更新为新结构后继续沿用旧测试；必须保留一个真实旧 schema fixture，证明发布用户数据库可升级。

## Alternatives Considered

### Alternative A: Single Run Stream With In-Memory Filtering

所有事件只用 `(run_id, sequence)`，aggregate type/id 仅放 payload 或 event type 前缀。

优点：schema 最简单；Run 全序天然存在；0001 无需重建表。

缺点：单 Tool/Agent 重放需要扫描整个 Run；数据库无法唯一约束 aggregate sequence；payload 地址不能稳定索引；并发旧聚合只能争用全局 sequence，错误无法指出具体聚合版本。随着长任务和多个 Agent 增长，恢复成本和耦合都会扩大。

结论：拒绝。它把聚合边界留在应用约定里，没有存储级不变量。

### Alternative B: Independent Sequence Per Aggregate Only

主键使用 `(run_id, aggregate_type, aggregate_id, aggregate_sequence)`，不保留 Run 全序。

优点：各聚合并发追加自然；单聚合重放和乐观并发简单；热点比 Run 全序低。

缺点：跨聚合事件没有确定提交顺序；投影只能依赖时间戳或 rowid，而二者都不是领域顺序；崩溃恢复无法稳定判断 Tool 完成、Plan 修订和 Run 终态的先后；不同连接下的时间戳不能替代序列。

结论：拒绝。它优化了局部并发，却破坏 Run 作为 orchestration boundary（编排边界）的可恢复性。

### Alternative C: Run Global Order Plus Aggregate Address And Local Order

即本 ADR 的决策。

优点：Run 恢复与投影有确定全序；单聚合可索引重放并做版本冲突检测；跨聚合关系可引用稳定地址；SQLite 约束能同时保护两个维度。

缺点：每次写入分配两个序号；同一 Run 的写事务串行；schema 和 migration 更复杂；append API 必须同时携带两个 expected sequence。

结论：接受。NovelX 优先恢复正确性、审计和明确失败，增加的本地事务成本可控。

## Consequences

### Positive

- Tool/Goal/Plan/Agent 可以成为真正独立、可重放、可并发校验的聚合。
- UI projection 和崩溃恢复保留单 Run 确定顺序。
- 幂等重试与事件身份不再混为一个字段。
- 未知事件版本不会被旧 runtime 静默忽略。

### Negative

- 0001 必须通过重建表迁移，不能简单 `ALTER TABLE` 完成所有约束。
- append 和 recovery API 需要同时理解 Run 与 Aggregate sequence。
- 单个超高频 Run 的写入仍受 SQLite 单写者和 Run 全序约束。

### Neutral

- 本决策不规定 Tool/Goal/Plan/Agent 的具体状态机或 payload。
- 本决策不引入 Provider、Electron 或网络传输实现。
- Event Journal 仍是 append-only SQLite；未来更换存储必须保持相同寻址和排序语义。

## References

- `runtime/crates/novelx-runtime/migrations/0001_event_journal.sql`
- `runtime/crates/novelx-runtime/src/event_journal.rs`
- `runtime/crates/novelx-runtime/src/run_aggregate.rs`
- `docs/adr/ADR-0003-rust-runtime-v2-and-codex-reference.md`
- `docs/runtime-v2/protocol-v1.md`
