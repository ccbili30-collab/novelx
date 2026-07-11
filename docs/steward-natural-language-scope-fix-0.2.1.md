# Steward Natural Language And Project Scope Fix

Date: 2026-07-11
Target release: `0.2.1`

## Fixed

- Steward（大管家）的最终用户消息不能再包含 `Steward`、`Harness`、`Plan -> Execute`、`Finalize`、状态重置、正确收口、资源 ID、结构化提交和拒绝码等内部运行术语。
- 违反该边界的模型输出会被运行合同拒绝，不会直接展示给用户。
- Agent Mode（Agent 模式）没有选中具体对象时，当前工作区已有的非根级创作对象会成为默认可用范围。
- 用户选中具体世界、OC、故事或其他对象后，仍只使用该明确范围。

## Not Fixed

- 只存在于磁盘、尚未进入 Source Library（来源库）或创作对象系统的散乱文件，不会因为本次改动而自动变成模型可读资料。
- 本次没有增加关键词回复、固定问候语或本地假 Agent。
- 没有修改 GM、Writer、Checker 或 Canon（正史）写入权限。

## Verification

- TypeScript typecheck（类型检查）：通过。
- Vitest：74 个测试文件、281 个测试通过。
- Agent Electron E2E（Agent 桌面端到端测试）：3 个通过。
- Production build（生产构建）：通过。

