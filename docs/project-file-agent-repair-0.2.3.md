# NovelX 项目文件 Agent 修复记录

日期：2026-07-11

版本基线：0.2.3

完成版本：0.2.4

## 已实现

- 新增真实项目文件读取服务，支持目录总览、单文件读取、全文搜索、DOCX 和 EPUB 文本提取、二进制元数据。
- 阻止绝对路径、路径穿越、符号链接逃逸以及 `.novax`、`.git`、`node_modules`。
- Pi Agent（Pi 智能体框架）新增 `inspect_project_files` 工具，并接入 Worker（工作进程）、Main（主进程）、IPC（进程间通信）、审计活动和“已处理”产物。
- “已处理”可以显示实际读取的相对文件路径，以及完整文本、文本片段或二进制元数据状态。
- Change Set 支持真实项目文件创建、覆盖和删除。
- 已有文件写入使用 SHA-256 并发保护；失败不会覆盖用户的新修改。
- Schema（数据库结构）升级到 19，加入内容寻址文件快照和检查点恢复。
- 发布 Steward 1.9、Writer 1.4、Checker 1.5 和 Tool Policy 2.7，明确当前文件夹读取、六个领域根节点不是文件、片段不可冒充完整读取、写入必须走 Change Set。
- 新增真实 Provider 评测用例 `steward.current-folder-uses-real-files`。

## 验证证据

- `npm run typecheck`：通过。
- `npm test`：76 个测试文件、290 项测试全部通过。
- `npm run build`：通过，包括现有 Prompt、Decomposer（拆解器）和 GM 发布门。
- 真实 DeepSeek 评测：10/10 用例通过，报告为 `prompt-eval-2026-07-11T15-20-08-944Z.json`。
- 真实桌面 E2E：总结项目文件、显示审计文件路径、Assist 修改 README、检查点恢复旧文件均通过。
- `npm run package:update`：生成 `release/novelx-Setup-0.2.4-x64.exe` 和更新 blockmap。
- `npm run verify:package`：通过，包内敏感/测试文件检查通过。
- 文件版本专项测试覆盖：Free 新建、Assist 覆盖、旧哈希拒绝、失败回滚和检查点恢复。

## 闭环中发现并修复的问题

- 顶层 TypeBox Union（联合类型）生成的工具参数没有 `type: object`，DeepSeek 对所有 Steward 请求返回 HTTP 400。现已改成单一 Object Schema，并保留 Zod 严格判别校验。
- Electron 评测引导脚本没有显式等待异步评测，导致进程长期挂起。现已提供独立 Electron 评测入口和逐用例安全进度。
- 专项 Agent 只提示调用结果工具，模型偶发只输出普通文本。现对 Writer/Checker 的唯一结果工具使用 Provider `tool_choice`，且结果接收后停止强制。
- 无效结构化工具参数曾被计入有效 submission（提交）数量，导致修正成功后仍被判重复提交。现只统计通过 Schema 校验的提交。
- IPC 审查 Schema 漏掉 `project_file`，现已补齐。

## 仍未完成

- 文件 Artifact 尚不能点击跳转到编辑器具体行。
- 0.2.4 安装包尚未上传 GitHub Release（GitHub 发布版本），因此已安装客户端暂时收不到该版本更新。
- Windows Authenticode（代码签名）状态为 `NotSigned`，安装时可能显示未知发布者。
