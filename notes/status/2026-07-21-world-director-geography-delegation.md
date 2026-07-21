# World Director 地理专业员工委派批次

状态日期：2026-07-21
分支：`codex/hackathon-10day`

## 已完成

- 正式桌面 IPC（进程间通信）创建的 `GrowthCoordinator` 已明确选择 `world_director_geography` 路由，不再由 Renderer 假造专业员工结果。
- Main 为一个 Growth Goal 创建稳定幂等的地理 Editorial Round（编辑轮次）和单个 `geography_ecology_author` Work Order，并将创作者种子、当前用户规则和来源 checkpoint 编译成受限证据包。
- `AgentProcessSupervisor` 可用已发布 Prompt、固定能力合同和真实文本 Provider 身份启动专业员工 Worker，记录 Steward/Writer 审计、Provider receipt、取消、超时和失败终态。
- 专业员工候选正文与交接 JSON 进入工作区 `.novax/artifacts/growth-editorial/sha256/` 内容寻址存储；SQLite 只保存不可变引用和 SHA-256，读取时复核引用、种类和内容完整性。
- Growth 写工具的项目级串行队列覆盖完整持久化边界，区分排队超时与执行超时；关系可见性同时检查 creative 与 causal 版本表。
- World Fragment 在进入 Main 前严格校验 owner 类型、当前检索证据和结构错误，并返回可纠正的精确错误；没有放宽 Domain、权限或 Canon 边界。
- 真实 E2E 的文本模型验收 ID 已从不存在的 `5.6luna` 更正为上游实际公开的 `gpt-5.6-luna`。

## 验收

- 定向测试：11 个文件，152/152 通过，0 失败、0 跳过。
- `npm run typecheck`：通过。
- `npm test`：全量清单 166 个文件；unit 1066/1066、integration 22/22、E2E-support 9/9，共 1097/1097，0 失败、0 跳过。
- `npm run build`：通过；三个 active Prompt publication gate 均通过，Electron main/preload/renderer 生产构建成功。
- 构建仍报告 `SemanticGraphView.tsx` 同时被静态和动态导入的 Vite 分包警告；该警告未阻塞构建，本批没有顺手改动图谱加载策略。
- 本批没有运行真实 Provider、Electron UI E2E、Windows 安装包或真实世界项目，因此不能标记为 Live。

## 未完成

- 当前正式 Growth 路由只完成一个地理候选及交接 Artifact 落盘，尚未把候选送入 Graph Curator、Checker、Director 审查，也没有编译或提交 Change Set。
- 尚未将地理候选投影成用户可见的正式世界文档、Canon、因果图谱、地图或风貌图片。
- 尚未继续人文、国家/组织、历史、故事、角色和世界包导出阶段。
- `running` attempt（尝试）在进程中断后会进入 `reconciliation_required`，当前调用不会自动证明安全重发；恢复策略仍需后续受权任务处理。

## 风险与恢复入口

- 最大风险是正式桌面 Growth 入口现在有意停在第一段地理候选：它证明真实路由和失败关闭边界已接上，但用户暂时无法从该入口得到完整世界。
- 没有真实 Provider 证据，专业员工的实际文本质量、上游响应身份和长时间流式行为仍未验证。
- 后续应从 `src/main/growth/editorial/worldDirectorGeographyDelegation.ts` 继续：先补候选审查与确定性 Change Set 编译/提交，再接地图和图片；不得绕回 Renderer 模板或用 Fixture 冒充 Live。
