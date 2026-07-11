# Stage 6 Decomposer Prompt Publication Status

Date: 2026-07-11

## Completed

- 新增独立 Decomposer Prompt Evaluation（拆解器提示词评测）构建和 PowerShell 运行入口。
- 评测直接调用生产 `runDecomposerWithReceipt` 路径，不使用 mock live（模拟实时能力）。
- 安全报告只保存输出哈希、候选类型、来源块 ID、时间类型、通过状态和 Provider Receipt（模型提供方回执），不保存原始模型输出或 API key。
- Prompt `1.0.0` 的真实 DeepSeek 评测发现明确相对时间“三年后”被丢为 `temporal: null`，发布被阻塞。
- Prompt `1.1.0` 增加相对时间保留和候选去重约束。
- Prompt `1.1.0` 使用 DeepSeek `deepseek-chat` 完成真实评测；Provider 实际回执模型为 `deepseek-v4-flash`。
- 三个发布用例全部通过：来源绑定与原著未来、来源提示注入、冲突来源歧义。
- 独立构建门校验 Prompt 哈希、报告哈希、Prompt 身份、Provider 身份、用例结果和 Context Policy（上下文策略）回执。
- `novax.decomposer@1.1.0` 已标记为 active（启用），并固定不可变发布证据。

## Not Completed

- Import Workbench（导入工作台）尚未通过 IPC 连接 Decomposer Process Supervisor（拆解器进程监督器）。
- 已接受候选尚未转换为目标明确的 Change Set（变更集）提案。
- 尚未对大体量 EPUB/DOCX 做真实 Provider 分批拆解与取消恢复验收。

## Functional Reduction Risks

- 当前发布评测覆盖三个关键安全行为，不等于覆盖所有小说类型和语言；后续 Prompt 版本仍需扩展回归语料。
- Provider 请求模型为 `deepseek-chat`，实际回执为 `deepseek-v4-flash`。报告保留两者，不能把请求模型名称冒充实际执行模型。
- Prompt 已发布不代表可见功能已经闭环；在 UI/IPC 接线完成前，用户仍不能启动真实拆解。

## Evidence

- Published report（发布报告）：`notes/evidence/novax-decomposer-prompt-evals/decomposer-prompt-eval-2026-07-11T06-55-03-697Z.json`
- Report SHA-256：`b627015e6e8f36657bf6419ec900ec468db29e0586bf73b21ee16ed085381312`
- Prompt SHA-256：`eadcabbf9c0eab271364fbdd65b4049546d2d3cbc38d54c09f36fa917b60f548`
