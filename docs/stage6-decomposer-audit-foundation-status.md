# Stage 6 Decomposer Audit Foundation Status

Date: 2026-07-11

## Completed

- Workspace Schema 17（工作区数据库结构版本 17）新增 Decomposer Run Audit（拆解器运行审计）和来源块关联表。
- 审计身份固定记录 Job（任务）、Source（来源）、Provider（模型提供方）、Model（模型）、Prompt（提示词）、配置哈希和输入哈希。
- 每个运行绑定有序来源块和内容哈希，不能用未记录的来源伪装输入证据。
- 运行只能从 running（运行中）进入一次终态，并记录错误码、输出哈希和 Provider Receipt（模型提供方回执）。
- 身份字段和已终态运行由数据库触发器阻止改写。

## Not Completed

- Agent Worker（Agent 工作进程）尚未增加 Decomposer 命令和事件协议。
- Decomposer Process Supervisor（拆解器进程监督器）尚未创建、取消或处理中断运行。
- 当前 Decomposition Service（拆解服务）尚未使用新审计仓储。
- Decomposer Prompt 仍为 candidate（候选），没有真实 Provider eval（模型提供方评测）发布证据。
- UI 按钮保持禁用。

## Functional Reduction Risks

- 这一批只是不可变审计存储底座，不是可运行拆解器，不能作为 Stage 6 完成证据。
- 在监督进程接入前，任何直接调用现有 Decomposition Service 的代码都缺少完整终态审计，不应进入 live（实时可用）路径。

## Verification

- TypeScript typecheck（类型检查）：通过。
- Decomposer audit repository（拆解器审计仓储）和 workspace persistence（工作区持久化）针对性测试：2 个文件、5 个测试通过。
- `git diff --check`：通过。
