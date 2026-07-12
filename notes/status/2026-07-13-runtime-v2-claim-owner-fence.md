# Runtime V2：Claim 所有者围栏修复

日期：2026-07-13

## 原因

`start_claimed` 之前只验证传入 owner（所有者）与已持久化 Claim（声明）一致，以及调用方持有同一数据库的 WorkspaceRuntimeLease（工作区运行租约）。新进程获得数据库锁后，可以在请求中填写旧 owner，从而在没有 Claim 转移和 fencing token（围栏令牌）递增的情况下启动旧 Claim。

## 修复

- 启动 Execution（执行）前，Runtime 现在强制验证 Claim owner 就是当前独占 WorkspaceRuntimeLease 的 owner。
- 新 owner 不能冒用旧 Claim；必须通过允许的转移或未来专门的已启动执行恢复协议。
- 新增双 owner 测试，确认旧 owner 释放锁、新 owner 获得锁后仍不能启动未转移 Claim，且不会写入 `ExecutionStarted`。

## 验证

- Claim Service 聚焦测试：7/7 通过。
- Clippy `-D warnings` 通过。

## 未完成

已开始但未完成的本地投影执行，仍需要专门的 restart resume/finalize（重启续接/收口）协议。不能通过放宽 owner 检查实现恢复。
