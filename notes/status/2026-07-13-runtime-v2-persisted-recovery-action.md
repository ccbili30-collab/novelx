# Runtime V2：恢复动作规格持久化

日期：2026-07-13

## 本批完成

- 将 `OperationalRecoveryAction` 从扫描器内部类型提升为独立 Runtime 类型。
- 新创建的 Recovery Claim（恢复声明）同时持久化完整、不可变的动作规格和其 Canonical SHA-256（规范哈希）。
- Claim 创建与转移会验证动作规格和哈希一致；篡改规格或哈希会 fail closed（失败关闭）。
- 旧事件缺少完整动作规格时仍可回放，使用 `None` 保持兼容，但不能被后续 Supervisor 当作可自动执行规格。
- Claim 转移必须保留完全相同的动作规格，不能只复制一个调用方可伪造的哈希。

## 为什么必须先做

本地 Provider（模型服务）结果投影会改变 Agent Loop（智能体循环）检查点。进程若在投影写入后、Recovery Outcome（恢复结果）写入前崩溃，新扫描看到的是变化后的来源，不能重新推导旧动作。只有 Claim 自身持久化完整动作，重启后的 Supervisor（监督器）才能使用原 execution ID（执行标识）和稳定命令键确认或幂等重放旧投影，而不是误把它标记为 stale（过期）或再次请求模型。

## 验证

- Rust workspace（Rust 工作区）全量测试通过。
- Clippy `-D warnings` 通过。
- 新增动作规格哈希篡改拒绝测试。
- Claim Service（声明服务）测试确认新 Claim 确实持久化完整动作并能重算相同哈希。

## 明确未完成

- 独占 Supervisor 尚未接线。
- Projection Service（投影服务）目前仍需由高层 Supervisor 绑定 WorkspaceRuntimeLease（工作区运行租约）并复核 Claim / Execution 围栏，不能直接暴露为任意调用入口。
- “旧 Execution 已开始但 Outcome 未写”的重启自动收口尚未完成。
- Provider/Tool 外部副作用恢复仍未完成。

因此本批只是 Supervisor 的必要持久化前提，不能宣称自动运行恢复已经闭环。
