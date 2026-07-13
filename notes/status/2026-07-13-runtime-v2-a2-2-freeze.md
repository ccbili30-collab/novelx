# Runtime V2 A2.2 冻结留档

日期：2026-07-13

## 冻结范围

本文件只记录 A2.2 已有的真实代码、测试和运行证据。A2.2 不是完整 Harness（运行框架），也不代表长期记忆、多 Agent、小说领域链路或桌面产品已经完成。

## 已完成并接入生产路径

### Bound Lease（绑定租约）生产接线

- 工作区运行租约会绑定到经过核验的数据库文件身份。
- Run、Provider、Tool、Recovery 和 AgentLoop 的生产写路径使用绑定后的租约执行写入授权检查。
- 不再仅凭路径字符串证明数据库写权限。

### Provider legacy（旧模型调用路径）封口

- Provider 网络副作用统一经过当前授权和持久状态校验路径。
- 旧的、缺少当前权限证明或写入围栏的调用入口已从生产链收口。
- 缺少真实 Provider 配置时仍保持 fail-closed（失败关闭），不会用本地结果冒充模型调用。

### bootstrap bind-before-open（初始化先绑定后打开）

- 新数据库文件先以排他方式创建并同步，再绑定文件身份，最后才由 EventJournal（事件日志）打开和迁移。
- 已存在数据库先验证文件身份并绑定，再进入恢复与写入流程。
- 该顺序避免先打开或迁移错误文件后才检查租约身份。

### Assist proposal/ack/proof（协助续跑提议、确认与证明）

- Assist 工具决定全部持久化后，先完成 Operational Recovery Barrier（运行恢复屏障），不再与 live continuation（实时续跑）并发认领同一 AgentLoop。
- Runtime 持久化 ToolResult、续接 Context 和第二轮 inference identity 后发布 continuation proposal。
- Host 先登记 continuation identity，再发送 acknowledgement；Runtime 精确核对 continuation identity hash、父推理身份和授权证据后返回 accepted response。
- Provider 第二轮只能由消费 move-only `AssistContinuationAckProof` 的 Runner 入口启动。
- 无 Proof 的 Assist generic run 会返回 `AssistContinuationAckProofRequired`，且不会增加 HTTP 请求。
- 合法的普通 `AwaitingProvider` Operational Recovery 不受 Assist Proof 门误伤，仍可复用持久 dispatch identity。
- Approve 和 Deny 都进入第二轮；Deny 使用严格配对的 `TOOL_DENIED` ToolResult。

### Killpoint（强杀点）独立 binary（二进制程序）

- 故障注入只存在于独立 `novelx-runtime-failpoints` 测试 binary。
- release 生产构建不能启用 `runtime-test-failpoints`。
- 测试强杀入口与正式 Runtime binary 分离，不能作为 live 能力发布。

### 测试分层

- `npm test` 先运行 Unit（单元测试），再以单 worker 运行 Integration（集成测试）。
- Integration 命令只构建一次 Rust Runtime。
- 正式测试执行零意外 skip；ToolCall debug selection 只属于显式调试命令。
- 测试清单固定核验为 86 个文件：Unit 83，Integration 3。

## 最终证据

### Rust

- Rust 正式测试：543/543 通过。
- Killpoint 强杀测试：10/10 通过。
- Assist Runner 定向测试同时证明：
  - 合法 Operational Recovery 复用持久 dispatch identity 成功；
  - Assist generic run 缺少 Proof 时失败关闭；
  - 无 Proof 时 HTTP 请求数不增加；
  - 完成 proposal/ack/proof 后才发送第二轮请求。
- Proof 不可由外部直接构造的 compile-fail 测试通过。

### Desktop TypeScript / Integration

- 最终 `npm test`：
  - Unit：402/402 通过；
  - Integration：22/22 通过；
  - ToolCall：10/10 通过；
  - skipped：0；
  - summary：`passed=true`；
  - orchestration errors：0。
- 冻结前两轮完整 `npm test` 均满足相同计数、零 skip、每轮恰好一次 Rust build 和 `passed=true`。
- 最后一次小修后的完整冻结确认再次得到 Unit 402、Integration 22、ToolCall 10、skip 0、summary true。
- `npm run typecheck` 通过。
- `npm run build` 通过；Steward、Decomposer 和 GM Prompt publication gate（提示词发布门）均为 verified。
- 验收过程没有启动 Electron 或 Playwright 可视窗口。

## 明确冻结债务

以下能力没有在 A2.2 完成，且依据用户命令冻结，不继续扩展：

- Durable Assist restart（持久协助续跑重启恢复）：pending proposal 和 acknowledgement 状态仍是进程内状态，重启后不能完整重建和重发未确认 proposal。
- 完整 evidence hash（证据哈希）：当前没有一个覆盖完整 proposal 与全部授权证据的单一权威哈希。
- Trusted Internal Host Boundary（受信任内部宿主边界）自确认：Handshake Service 阻止 Runner 无 Proof 启动，但公开 crate 的受信任内部调用者仍可自行注册并确认一份匹配 proposal；不能宣称 crate-wide Host authenticity（全 crate 宿主真实性证明）。
- Continuation metadata cleanup（续跑元数据清理）：Supervisor 与 Runtime 的进程内 proposal / acknowledgement 索引在终态后尚未统一清理，长寿命进程可能缓慢累积小型元数据。
- EventJournal / ArtifactStore trusted storage（事件日志 / 产物仓库受信任存储边界）：底层存储仍是受信任基础设施，没有完成所有公开低层写入口的 capability 化重构。
- Runtime Cancellation Hub（运行时取消中心）后续统一化未做。
- Coordinator（协调器）后续统一调度未做。
- oh-my-pi 专项审计和选择性引入未做。
- 更低层权限、公开 crate 边界和所有写入口的系统性重构未做。

这些债务不是测试通过后自动消失的事项。A2.2 只能冻结为当前可靠性地基的一批已验收改动，不能描述为 NovelX Harness、长期记忆、多 Agent、小说领域 Runtime 或完整桌面产品已经完成。
