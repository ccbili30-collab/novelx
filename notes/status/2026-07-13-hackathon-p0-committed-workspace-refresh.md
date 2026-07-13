# 黑客松 P0：正式提交后工作台即时刷新

日期：2026-07-13

## 范围

本批只处理 Change Set（变更集）正式提交后，桌面工作台仍显示旧资源、旧正文和旧图谱的问题。A2.2 Harness（智能体运行框架）保持冻结；未修改 Rust Runtime V2（第二版运行时）、Provider（模型服务）、权限或持久化协议。

## 已实现

- Assist（协助）模式只有 `finalizeAssist` 返回 `committed` 后才刷新工作区；接受、草稿、拒绝等中间决定只刷新审查列表。
- Free（自由）模式只有 `run.completed` 同时声明 `changeSetState=committed` 并携带 `committed` Change Set Artifact（已提交变更集产物）时才触发同一刷新入口。
- 统一刷新入口重新读取真实 Workspace Snapshot（工作区快照），并更新待审查列表、资源树、当前创作文档和语义图谱。
- 图谱刷新时清除旧节点选择和检查器内容，避免新快照与旧检查器混合显示。
- 创作文档在正式提交刷新键变化后重新读取当前真实内容；不使用本地模板或假数据。

## 验收

- 红测试先证明原行为：Change Set 已形成稳定版本，但 IDE 资源树仍显示世界 0，找不到“银湾世界”。
- `npm run typecheck`：通过。
- `npm run build`：通过；Steward、Decomposer、GM Prompt publication gate（提示词发布门）均为 verified。
- `npx playwright test tests/e2e/change-set-ui.spec.ts --workers=1`：1/1 通过。
- 同一可见 E2E 在不重启 Electron 的情况下证明：
  - 新世界“银湾世界”立即出现在资源树；
  - 新文档“银湾开场”可以打开并显示本次提交的正文；
  - 图谱立即显示“银湾海岸 · 形成原因”事实节点。
- 测试截图：`test-results/novax-change-set-committed-1440x900.png`。
- 本批没有调用真实 Provider；测试直接使用真实 Change Set 服务和真实 SQLite 工作区，不属于 Provider Live（模型真实运行）证据。
- 未运行全量 `npm test`；按黑客松冻结计划留到集中验收。

## 未完成与风险

- Free 模式的 Renderer（渲染进程）事件接线已经实现，但尚未用真实 Provider 完成单独的 Free 端到端验收。
- 当前刷新失败只在工作台显示错误，不会回滚已经成功提交的正式内容；用户可重新打开项目恢复显示。
- 当用户正编辑未落盘文字且 Agent 同时提交同一文档时，仍需要后续冲突策略；本批没有改变现有草稿和版本语义。
- 图片 Job（任务）、Asset（资产）、大管家生图工具和联合展台仍未实现。
