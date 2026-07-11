# ADR: Agent 项目文件网关与命令执行隔离

日期：2026-07-11

状态：代码已实现，Prompt 发布门待真实 Provider 评测

## 决策

NovelX Agent 可以在当前项目根目录内列出、读取、搜索、创建、更新和删除真实文件，但不获得 Shell（命令行）、进程启动或代码执行能力。

模型不能直接接触 Node.js `fs`。所有读取通过 `inspect_project_files`，所有写入通过 Change Set（变更集）。Main（主进程）负责解析相对路径、校验真实路径、阻止符号链接逃逸并记录审计结果。

默认隔离 `.novax`、`.git` 和 `node_modules`。绝对路径、盘符路径、`..` 和越出项目根目录的真实路径均被拒绝。

## 读取合同

`inspect_project_files` 支持：

- `overview`：列出目录并在预算内读取多份文本。
- `read`：读取单个文件。
- `search`：在项目文本中搜索并返回文件和行号。

普通文本和代码按 UTF-8 读取；DOCX（Word 文档）和 EPUB（电子书）提取文本；图片及其他二进制只返回元数据。返回值明确记录截断、遗漏和预算，禁止把片段冒充完整项目。

## 写入与版本

Change Set 新增：

- `project_file.put`
- `project_file.delete`

已有文件必须携带读取时的 SHA-256，防止覆盖并发修改。新文件要求 `expectedSha256: null`。覆盖和删除属于 elevated（较高风险），必须在 Assist（协助）审查；Free（自由）只允许低风险新建文件自动提交。

文件版本使用 `.novax/file-snapshots/<sha256>` 内容寻址快照，数据库 `project_file_versions` 记录检查点、相对路径、状态和内容哈希。首次跟踪时把修改前状态挂到父检查点，检查点恢复会重建所有已跟踪文件。数据库提交失败时，磁盘修改按相反顺序回滚。

## 不包含

- 不执行代码、脚本或命令。
- 不读写隔离目录。
- 不对二进制文件做内容修改。
- 当前公开 Artifact（产物）只显示文件路径和读取完整性，尚不能点击跳转到具体文件行。
- Steward 1.9 仍是 candidate（候选），尚未进入 live（正式运行）路径。
