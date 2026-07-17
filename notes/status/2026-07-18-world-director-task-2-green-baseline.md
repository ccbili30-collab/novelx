# World Director Task 2 绿色 pre-feature 基线

日期：2026-07-18
分支：`codex/hackathon-10day`
代码冻结提交：`ce8378e9deb9ad86dbbacc6eefe1bd2afbb8e4d5`

## 已完成

- 按 `src/agent-worker/growth/README.md` 与 `src/main/growth/README.md` 去重运行 18 个定向测试文件，190/190 通过，零跳过。
- 重新验证历史报告的 `trustedLongformPhase` 类型错误、`RELATION_SOURCE_KIND_INVALID` 与 `story/volume` 关系语义冲突；三者均未在当前快照复现。
- 首次全量测试发现唯一局部回归：Main Revision proposal policy 已新增 `GROWTH_REVISION_POLICY_CLOSURE_REQUIREMENT_INVALID`，但 Safe Diagnostic（安全诊断）目录完整性测试缺少该期望项。
- 生产 policy、诊断目录与专门 policy 测试证明该码已有真实唯一用途；最小修复只同步测试期望，没有改变生产逻辑、公开协议、Schema（数据结构）、权限或 Canon（正史）。
- 代码、测试与 E2E Harness（端到端测试框架）已提交为一个可编译冻结候选；计划、状态和脱敏 Live（真实运行）证据另作证据提交。

## 验收

- 定向 Growth：18 文件，190/190，零跳过。
- 首次 `npm test`：Unit 883/884，Integration 22/22，E2E-support 9/9；唯一失败为上述过期测试清单。
- 修复定向验证：2 文件，25/25，零跳过。
- 修复后 `npm test`：141 文件；Unit 884/884、Integration 22/22、E2E-support 9/9，总计 915/915，零跳过。
- `npm run typecheck`：通过；冻结末尾再次通过。
- `npm run build`：通过；3 个 active Agent Prompt、Decomposer Prompt 与 GM Prompt publication gate 均通过。
- `git diff --check`：通过。
- 本 worktree 残留 Node、Electron、npm、npx、pnpm、yarn、PowerShell、cmd 进程：0。
- 真实 Provider（模型服务）：未运行。

## 未完成

- World Director、Editorial contracts（编辑合同）、SQLite v28、因果关系和调度器尚未开始实现。
- 最新双 Provider Live 仍停在 `gpt-5.4` + `gpt-image-2` 的 incomplete 世界包；本任务的确定性绿色基线不能升级这项 Live 结论。
- 最终文本 Live 必须在任何 Provider 副作用前验证公开模型身份精确为 `openai-compatible / 5.6luna`。

## 风险与恢复入口

- 本次全量冻结证明当前提交的确定性测试、集成测试、E2E-support、类型和生产构建，不证明 Electron 交互、安装器、真实 Provider 或最终世界包质量。
- 下一入口是 Phase B / Task 3：记录 World Director 架构。若 ADR 需要改变公开协议、Schema、权限、Canon、数据兼容性或 Runtime V2 A2.2，必须停止并请求产品决策。
