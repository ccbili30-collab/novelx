# 2026-07-15 Growth Live text boundary

## 冻结基线

- 本批次冻结前的提交基线为 `f1eb09a8ef40f05eb6404903b3da5c61242ad307`（`codex/hackathon-10day`）。
- 本批次仅冻结 HX-C 008–013 已审查的 Worker/Main、状态机、测试和真实验收 Harness（测试运行框架）改动；没有宣称 Growth（增长）Live（真实运行）闭环。

## 已有的确定性能力

- Main（主进程）为单个 Growth Cycle 绑定服务端授权的 checkpoint（检查点）、scope（范围）、规则版本、种子资源和可信阶段；Worker（工作进程）不能自选这些权威字段。
- world 阶段使用可信 `retrieve_graph_evidence -> propose_change_set` 计划；Receipt（检索回执）持久化且是提案前置条件。首 Cycle 的空工作区仅在受信任 Free 授权下可走既有 create-only（仅创建）策略。
- Greenfield（空白创建）结构预检提供内容无关的稳定错误码，最多两次零副作用纠正；进入 ChangeSetService（变更集服务）后的失败不会重试。
- `submit_steward_result` 成功后立刻结束当前 Pi Provider（模型服务）回合；被拒绝的结果工具仍保留既有的一次有界纠正。Provider 协议阶段和 Change Set/Domain（领域）失败均只写入固定安全码，不回显原始错误、参数、正文或凭证。
- 真实验收 Harness 具备按 Cycle/总体 watchdog（看门狗）采样、取消前快照、关闭后的 SQLite（数据库）摘要、泄漏扫描，以及 Change Set 总数、状态计数、输出数和 checkpoint 增量记录。

## 真实 Provider 里程碑（不含创作正文）

保存的本机配置请求身份为 `openai-compatible / gpt-5.4`。最新 Run 的审计请求身份也是该值；审计中实际 Provider 为 `openai-compatible`，但没有可用的实际模型回执值，因此不能把实际模型回执写成已确认。所有下列文件均已做 JSON 解析和内容无关的凭证标记扫描。

1. `growth-live-2026-07-15T03-55-32-180Z.json`：首轮已真实完成受限检索并记录 Receipt，未形成 committed Change Set。
2. `growth-live-2026-07-15T04-05-23-829Z.json`：真实链首次达到 `retrieve -> writer -> propose`，提案失败；它证明工具路径而非成功创建。
3. `growth-live-2026-07-15T05-26-34-736Z.json`：结构分类和有界纠正后，真实 Run 出现三次失败的 propose；这是旧 Completion Guard 尾随 Provider 请求问题之前的结构边界证据。
4. `growth-live-2026-07-15T05-37-45-176Z.json`：当前权威边界。真实 Cycle 1 完成检索和 Receipt，提案进入 ChangeSetService 后以 `RESOURCE_PARENT_REQUIRED` 失败。存在 1 条 `failed`、未绑定到 Cycle 的 Change Set 记录；输出数为 0，checkpoint 总数为 1、相对初始增量为 0，正式 resource/document/assertion/relation 数均为 0。

最新记录中的 Cycle 为 `blocked`，失败码为 `GROWTH_CHANGE_SET_NOT_COMMITTED`。没有 Cycle 2/3、独立 research Run、图片 Provider、地图或任何 Live 成功声明。

## 定向验证

- `vitest`：9 个定向单元文件，124/124 通过，0 skipped；Growth watcher 夹具 2/2 通过。
- `npm run typecheck`：通过。
- `npm run verify:prompt-publication`：通过，activePrompts=3 未变。
- `git diff --check`：通过。
- 已运行过一次构建以供最后一次真实验收使用；本冻结任务不运行 Provider、Playwright、全量测试或构建。

## 冻结项与恢复入口

当前失败不是 Provider、可信计划、Receipt、结构预检重试或 Completion Guard 的未诊断失败；它是 Change Set 应用期的 `RESOURCE_PARENT_REQUIRED`。不得继续靠 Prompt 调优、增加 post-apply 重试或放宽 create-only/来源/权限策略掩盖它。

下一恢复入口是经过产品审查的模型侧高层 Growth Fragment（增长片段）编译器：模型提供创作字段，确定性编译器仅构造既有 Change Set 的结构、父子关系和依赖，再走一次既有策略与服务。此冻结不实现该路线。

明确排除：Renderer、图片/地图、Prompt 激活、迁移、Canon（正史）、Lens（视角）、权限、自动额外 Cycle、全量和 Live 成功验收。
