# Stage 6 Decomposer Audit Foundation Status

Date: 2026-07-11

## Completed

- Workspace Schema 17（工作区数据库结构版本 17）新增 Decomposer Run Audit（拆解器运行审计）和来源块关联表。
- 审计身份固定记录 Job（任务）、Source（来源）、Provider（模型提供方）、Model（模型）、Prompt（提示词）、配置哈希和输入哈希。
- 每个运行绑定有序来源块和内容哈希，不能用未记录的来源伪装输入证据。
- 运行只能从 running（运行中）进入一次终态，并记录错误码、输出哈希和 Provider Receipt（模型提供方回执）。
- 身份字段和已终态运行由数据库触发器阻止改写。
- Decomposer Contracts（拆解器数据契约）已提升到共享层，Domain（领域层）、Agent Worker 和协议使用同一份严格 Schema。
- Agent Worker 已支持类型化 `decompose.start` 命令和 started/completed/failed 事件。
- Worker Controller（工作进程控制器）在 Prompt 未发布时会在访问 Provider 前失败关闭。
- Decomposer Run Service（拆解器运行服务）将候选、候选首个修订、Import Job 终态和审计终态放在同一个 SQLite 事务中提交。
- Decomposer Process Supervisor（拆解器进程监督器）验证 Worker 事件的 runId 和 Schema，处理完成、失败、取消和进程中断，并清除内存中的 Provider credential（模型提供方凭据）。
- Workspace Session（工作区会话）提供受生命周期保护的拆解运行租约；应用退出时会处置拆解监督器。

## Not Completed

- 当前 Decomposition Service（拆解服务）尚未使用新审计仓储。
- 可见 UI 尚未连接拆解监督器；按钮仍保持禁用。
- Decomposer Prompt 仍为 candidate（候选），没有真实 Provider eval（模型提供方评测）发布证据。
- UI 按钮保持禁用。

## Functional Reduction Risks

- 这一批只是不可变审计存储底座，不是可运行拆解器，不能作为 Stage 6 完成证据。
- 在监督进程接入前，任何直接调用现有 Decomposition Service 的代码都缺少完整终态审计，不应进入 live（实时可用）路径。

## Verification

- TypeScript typecheck（类型检查）：通过。
- Decomposer audit repository（拆解器审计仓储）和 workspace persistence（工作区持久化）针对性测试：2 个文件、5 个测试通过。
- `git diff --check`：通过。
