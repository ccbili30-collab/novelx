# WorkspaceEventJournal 状态

## 已实现

- 新增独立 `workspace_events` append-only SQLite 表，不改变现有 Run-scoped `runtime_events` 语义。
- 地址包含 `workspace_id / stream_type / stream_id / stream_sequence`，同时维护 workspace 全局连续序号。
- 支持 expected workspace/stream sequence 乐观并发、workspace 范围幂等键、全局 message ID 冲突检测。
- 支持事件版本、JSON payload、RFC3339 时间元数据、`append`、`read_stream`、`list_streams`。
- migration 0004 使用 checksum ledger，重复升级幂等，checksum 不符时 fail closed。
- UPDATE 和 DELETE 由 SQLite trigger 拒绝。

## 测试定义

- 从已有 Runtime 数据库升级并重开。
- 中文 JSON payload 往返。
- 相同语义幂等重试与不同语义冲突。
- UPDATE / DELETE 篡改拒绝。
- migration checksum 篡改拒绝。
- 双连接并发 expected sequence 冲突。
- workspace 全序与 stream 局部序独立。

## 验证

- `cargo test -p novelx-runtime --test workspace_event_journal`：6 tests passed。
- `rustfmt` 与 `git diff --check`：通过。

本模块仅提供工作区事件日志基础，没有实现 Goal、Plan 或多 Agent 业务聚合。
