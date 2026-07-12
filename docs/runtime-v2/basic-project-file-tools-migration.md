# Runtime V2 基础项目文件工具迁移与黑盒验收

日期：2026-07-12

状态：审计完成；Rust Runtime（Rust 运行时）工具执行器尚未接通，本文不得作为 live（正式可用）证明。

## 结论

旧 Pi Agent（Pi 智能体）链路已经有 `list_project_directory`、`read_project_file`、`search_project_files`、`glob_project_files` 和 `stat_project_file` 的真实 Node.js 文件实现。Rust Runtime 当前只有 ToolCall（工具调用）状态机、持久化 Aggregate（聚合）和 Context Compiler（上下文编译器）的工具调用/结果配对约束；没有从 Provider（模型服务商）响应解析工具调用、执行项目文件工具、持久化结果、继续模型推理的完整链路。

因此迁移必须以真实黑盒证据为准，不能因为旧工具存在、Prompt 中写了工具名，或 Rust 中有 ToolCall 状态机，就宣称 Runtime V2 已支持项目读取。

## 旧实现审计

| 能力 | 现有真实实现 | 已有保护 | 必须修正或补充 |
| --- | --- | --- | --- |
| `list`（列出目录） | `ProjectFileService.list` 递归读取真实目录，按中文区域规则排序，最多返回 2,000 项 | 隔离 `.git`、`.novax`、`node_modules`；每个路径经过真实路径校验 | 达到上限后，当前 `omittedEntries` 只按遇到的入口计数，不代表被跳过子树的真实数量；Runtime 必须把计数定义清楚，或只承诺下界。需要取消信号和耗时预算，避免超大目录长期阻塞。 |
| `read`（读取文件） | UTF-8 文本分块读取；DOCX（Word 文档）和 EPUB（电子书）解包提取；返回 SHA-256、字符区间和 `hasMore` | 单次最多 120,000 字符；输入文件超过 4 MB 不读取；二进制不暴露内容 | `Buffer.toString("utf8")` 会用替换字符吞掉非法 UTF-8，必须返回编码错误或显式记录替换。DOCX/EPUB 解压缺少解压后体积和条目数量上限，存在 Zip Bomb（压缩炸弹）风险。必须保留稳定字符边界、文件哈希和分块连续性。 |
| `search`（搜索内容） | 遍历最多 2,000 个文件，大小超过 2 MB 跳过，最多 200 个匹配，返回路径、行号和摘录 | 不扫描已隔离目录；二进制跳过；查询长度受限 | 当前通过默认 `read` 只搜索每个文件前 120,000 字符，但没有因 `hasMore` 标记不完整。这会误报“全文无匹配”。Runtime 必须扫描完整允许范围，或返回 `incomplete: true`、每文件扫描区间和遗漏原因。行号必须基于真实原文且可稳定跳转。 |
| `glob`（通配匹配） | 基于真实目录列表匹配 `*`、`**`、`?` | 拒绝绝对路径、盘符和 `..` | 自制 Glob 语义不是完整标准；迁移应冻结支持子集并进行跨语言契约测试。结果继承目录列表上限，必须保留遗漏信息。 |
| `stat`（文件信息） | 返回类型、字节数、修改时间和文件 SHA-256 | 同路径 confinement（范围限制） | 当前对任意大小文件同步计算完整哈希，可能阻塞主进程。Runtime 应流式哈希、支持取消和最大执行时间；结果必须绑定读取时文件身份，避免后续写入使用过期哈希。 |

## 路径 confinement（路径范围限制）迁移合同

1. 只接受项目根目录相对路径；拒绝盘符路径、UNC（通用命名约定）路径、绝对路径和任何 `..` 段。
2. `.novax`、`.git`、`node_modules` 在任意路径层级均不可见。
3. 必须同时校验词法路径和最终真实路径，阻止 Junction（目录联接）、Symlink（符号链接）和重解析点逃逸。
4. 不能只执行一次 `realpath` 后再按字符串路径打开文件。应尽量使用已校验句柄读取，并记录打开后文件身份，降低校验与使用之间的 TOCTOU（检查与使用时序竞争）风险。
5. Runtime 只能从 Run（运行）固定的 `projectId`、`workspaceId` 和工作区根目录取得范围；Renderer（渲染进程）、模型参数和 Prompt 均不能提交真实根路径。
6. 错误必须区分 `NOT_FOUND`（不存在）、`RESTRICTED`（受限目录）、`OUTSIDE_ROOT`（越界）、`NOT_A_FILE`（不是文件）、`BINARY`（二进制）和 `INCOMPLETE`（结果不完整），不能统一解释成“未授权”。

## UTF-8 与长上下文合同

- 中文文件名、中文查询和中文正文必须通过真实 Rust 子进程 JSON 协议往返验证，不能只做 Rust 单元测试或 ASCII 测试。
- `read` 的区间单位必须固定为 Unicode Scalar Value（Unicode 标量值）、UTF-8 字节或 UTF-16 code unit（代码单元）之一。旧实现使用 JavaScript 字符索引，实际是 UTF-16 code unit；Rust 若改用字节偏移，必须升级协议，不能沿用同字段却改变含义。
- 每个分块结果至少包含 `path`、稳定文件版本身份、`start`、`end`、`returned`、`hasMore`、`complete` 和内容哈希。
- 下一块必须从上一块返回的 `end` 开始；文件在分块间改变时必须失败并要求重新读取，禁止拼接两个版本。
- Context Compiler（上下文编译器）只能接收本轮明确选中的工具结果。超预算时保留来源定位与遗漏声明，不能裁切后标记为完整。
- Task Note（任务笔记）可作为长任务工作记忆，但必须绑定文件版本和精确区间；它不是 Canon（正史）或项目事实本身。

## 权限与 Change Set（变更集）

- 五个基础工具均为只读、无副作用工具；仍须经过 Tool Policy（工具策略）白名单、Run 固定工作区和审计记录，不能因为只读就允许读取任意本机路径。
- Agent 不得直接获得 Shell（命令行）、任意进程启动或裸文件句柄。
- 创建、覆盖、重命名和删除不属于本迁移批次。所有写操作继续进入 Change Set，并携带读取所得版本哈希。
- Assist（协助）模式下，覆盖和删除必须等待用户确认；Free（自由）模式也不能绕过路径限制、版本冲突和审计。
- Provider 未配置、工具未注册、权限未固定或执行器不可用时必须 fail closed（失败关闭），返回结构化阻塞错误，不得生成假文件列表或用 Prompt 猜测目录。

## Runtime V2 迁移清单

1. 在 `novelx-protocol` 定义严格版本化的五种工具参数、结果和公开错误 Schema（模式），拒绝未知字段。
2. Provider Gateway（模型网关）解析 OpenAI-compatible（OpenAI 兼容）的 `tool_calls`，保留原始调用 ID、工具名和参数哈希；未知工具直接失败，不发送伪结果。
3. Runtime Actor（运行时 Actor）为每次调用创建 ToolCall Aggregate，完成 requested -> authorized -> running -> completed/failed 的持久化转换。
4. 在 Rust 侧实现项目根目录固定和五个只读执行器，或建立严格的 Host Tool Gateway（宿主工具网关）。若由 TypeScript 执行，Rust 仍必须拥有授权、状态、幂等、超时、取消和结果审计权。
5. 工具结果先持久化为 terminal result（终态结果），再作为成对的 `tool` 消息进入下一次 Context Compilation；崩溃恢复不得出现 tool call 没有终态结果。
6. 对相同 ToolCall ID 重放必须返回同一持久化结果，不能重复扫描并产生不同审计事实；显式新调用使用新 ID。
7. 只读工具可以有限并行，但同 Run 的总文件数、总字节、总字符、总耗时和结果 token（词元）预算必须受控。
8. 将旧 Pi 路径标记为迁移期间兼容路径；Runtime V2 功能门未通过全部黑盒测试前，UI 不得显示为 Runtime V2 live。

## 必须通过的真实黑盒测试

测试必须启动真实 `novelx-runtime.exe`、真实临时项目目录、真实 SQLite 日志和真实 loopback Provider（回环模型服务）。Provider 第一次响应返回工具调用，Runtime 执行后，第二次 Provider 请求必须包含严格配对的工具结果。禁止直接调用 `ProjectFileService` 代替 Runtime。

### RT-FILE-01 五工具闭环

项目包含中文目录和文件，但没有 `README.md`。Provider 依次请求 `list`、`stat`、`glob`、`search`、`read`。断言：

- Provider 恰好收到预期次数的请求，每次 continuation（继续推理）都带前一工具调用的终态结果；
- 结果来自磁盘真实内容，包含中文文件名和正文，不含项目绝对路径或 `.novax`；
- SQLite 中每个 ToolCall 有唯一、有序、可恢复的 requested/authorized/running/completed 事件；
- Run 只在最终无工具调用的模型响应通过 Validator（校验器）后完成。

### RT-FILE-02 路径逃逸失败关闭

Provider 分别请求 `../secret.txt`、`C:\\Windows\\win.ini`、UNC 路径、`.novax/workspace.db` 和指向项目外的 Junction。断言：

- 没有项目外文件内容进入 Provider 后续请求、Journal（日记）或公开事件；
- 每次调用产生对应结构化终态失败；
- Runtime 继续或阻塞必须符合工具策略，但不得把错误改写成“项目未授权”。

### RT-FILE-03 中文 UTF-8 与分块连续性

创建超过单块上限的中文、补充平面字符和换行混合文件。Provider 连续读取所有区间。断言：

- 拼接结果逐字符等于原文件，无乱码、替换字符、重复或缺口；
- 每块 `start/end` 连续，文件哈希一致；
- 中途修改文件后，下一块读取以版本冲突失败，不能继续拼接。

### RT-FILE-04 搜索完整性

把唯一关键词放在第 120,000 字符之后，并加入超过大小限制的文件、二进制文件和超过结果上限的匹配。断言：

- 若策略允许完整扫描，必须找到后段关键词；
- 若预算阻止完整扫描，必须返回 `incomplete: true`、扫描区间和遗漏原因，不能返回貌似完整的零结果；
- 行号和摘录可通过随后 `read` 精确复核。

### RT-FILE-05 崩溃恢复与幂等

在工具已执行但结果尚未返回 Provider 时终止 Rust 进程并重启。断言：

- 不重复执行同一 ToolCall；
- 从 Journal 恢复相同终态结果并继续；
- 不产生无结果调用、不自动重发可能有副作用的后续操作。

### RT-FILE-06 Change Set 写入边界

Provider 尝试调用未授权的直接写文件工具，然后改为提交 `project_file.put` Change Set。断言：

- 直接写工具不存在或被拒绝，磁盘不变；
- Change Set 携带 `expectedSha256`，Assist 模式确认前磁盘不变；
- 用户确认后写入、建立检查点并可回溯；文件已外部修改时提交失败。

## 当前不能宣称完成的内容

- Rust Runtime 尚未执行上述五个文件工具。
- 尚无真实 Provider 工具调用 -> Runtime 执行 -> 工具结果续传的跨进程测试。
- 尚无 Runtime 级中文分块、路径逃逸、搜索完整性和崩溃恢复证据。
- 旧 `search` 的后段遗漏问题、同步大文件哈希和压缩文档解压预算问题尚未修复。

