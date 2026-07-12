# ADR-0011: Durable Child Agent Assignment（持久化子智能体分配）

Status: accepted
Date: 2026-07-12

## Context

Runtime V2（第二版运行时）已经有跨 Run（运行）的 Goal（目标）和 Plan（计划），但 `PlanStep.assignedAgent` 只是计划字段。它不能证明子 Agent（智能体）已被创建、获得了什么权限、是否启动、绑定了哪个子 Run、是否被取消，或者产物来自哪里。

如果直接根据该字符串启动后台任务，进程重启后会出现无法证明是否已经派发、重复派发、子任务越权写入和父任务错误完成等问题。多 Agent 协调必须先有独立、可恢复的权威账本。

## Decision

NovelX 增加 Workspace-scoped（工作区范围）的 `agent_assignment` 事件流。每个分配拥有不可变身份并永久绑定：

- workspace、project；
- Goal ID + revision、Plan ID + revision、Plan step ID；
- parent Run + parent invocation；
- child Agent profile；
- 排序且唯一的资源范围及其 SHA-256；
- `read_only` 或 `propose_change_set` 权限；
- 预期产物类型。

状态机为：

```text
allocated -> running -> completed | failed | cancel_requested
allocated -> cancelled
cancel_requested -> cancelled | completed | failed
```

`running` 必须绑定唯一 `child_run_id`。同一分配不得换绑另一个 Run。`completed` 必须包含不可变证据引用和内容哈希；它只证明子任务完成，不完成父 Goal，也不自动提交 Change Set（变更集）。

取消是协作式且持久化的。`cancel_requested` 表示取消意图已记录，不代表 Provider（模型服务）、ToolCall（工具调用）或外部副作用已经停止。只有子 Run 达到可证明终态后才能写入 `cancelled`。若结果已在取消竞争中完成，允许记录 `completed`，但必须保留先前取消请求。

## Authority and permissions

- Child Agent 默认 `read_only`。
- `propose_change_set` 只允许生成待审查 Change Set，不授予 canonical commit（权威提交）权限。
- 文件、领域对象和外部服务写入仍由 Tool Policy（工具策略）、Free / Assist（自由 / 协助）、permission lease（权限租约）、Change Set 和 Validator（校验器）裁决。
- 子 Agent 可以提交步骤证据，不能完成父 Goal、修改自身权限或扩大资源范围。
- 真正的并发调度必须在 startup recovery barrier（启动恢复屏障）完成之后进行。

## Write serialization

本 ADR 不把“一个分配一个子 Run”误当成并发写入安全。`propose_change_set` 子任务只能写自己的暂存产物。对项目 canonical state（权威状态）的提交必须通过单独的 project write lease（项目写入租约）按目标资源串行化，并使用源版本乐观校验。

在写入租约实现前，Runtime 可以持久化和检查分配，但不得启动会直接修改项目权威状态的子 Agent。

## Recovery

启动时从 WorkspaceEventJournal（工作区事件日志）完整回放所有非终态分配：

- `allocated` 且没有 child Run：只有在持久化调度 intent（意图）存在、恢复屏障完成且预算可用时才允许创建指定身份的子 Run；
- `running`：必须恢复精确 child Run，不得创建替代 Run；
- `cancel_requested`：继续驱动同一个 child Run 取消并等待可证明终态；
- terminal（终态）：只重建投影，不重新调度。

未知事件版本、序列缺口、哈希不匹配、Goal/Plan/step 绑定不一致或 child Run 缺失都 fail closed（失败时关闭），不能猜测状态。

## Consequences

- UI（用户界面）可以区分“计划分配”“已真实派发”“运行中”“正在取消”和“有证据完成”。
- 重启不会因为内存任务丢失而重复创建子 Agent。
- 多 Agent 的成本、取消、来源和父子责任可审计。
- 仍需后续实现命令服务、Runtime 协调器、恢复驱动、并发预算、project write lease、Handoff（任务交接）、Shared Memory（共享记忆）和桌面投影。

## 2026-07-12 Recovery Amendment

The Started event persists an immutable ChildRunSpec（子运行规格） containing the fixed child Run ID, stable Run-start idempotency key, complete RunPinnedIdentity（运行固定身份） and its canonical SHA-256. The child identity references Assignment allocation revision 1 and its event hash, not the Started event, avoiding a self-referential hash cycle.

Legacy Started events without ChildRunSpec remain readable for audit but cannot be used to provision a missing child Run. Structural recovery classifies a missing child with a valid specification as ProvisionChildRun（可补建子运行） only; it does not create the Run or call a Provider（模型服务）.

## Rejected alternatives

### 仅依赖 Prompt（提示词）让 Steward 记住子任务

拒绝。上下文压缩、进程退出和 Provider 重试都会丢失或重复该状态。

### 把子任务只写进 Plan step

拒绝。Plan 是意图版本，不是执行账本；它不能表达 child Run 身份、取消竞争和运行恢复。

### 子 Agent 直接并行写项目

拒绝。即使写不同文件，也可能同时修改同一领域对象、索引或图谱。没有资源租约和版本前置条件时不能证明提交顺序正确。
