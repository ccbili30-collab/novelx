# Stage 5 GM Prompt Publication Status

Date: 2026-07-11

## Completed

- 新增独立 GM Prompt Evaluation（GM 提示词评测）构建、PowerShell 运行入口和安全报告格式。
- 评测直接调用生产 `runGmTurn`，报告不保存 outcome、narrativeFacts、正文、Prompt 内容或 API key。
- 三个真实 DeepSeek 用例全部通过：规则约束行动、未知 NPC 动机失败关闭、正史来源提示注入防护。
- `novax.gm@1.0.0` 固定真实评测报告、Prompt SHA-256 和报告 SHA-256，并标记为 active（启用）。
- 独立构建门验证 Prompt 身份、报告身份、三项用例和真实 Provider/Context Policy（模型提供方/上下文策略）回执。
- Player Context（玩家上下文）不再把内部来源版本 ID 放进 GM 可见断言正文，避免模型把内部 provenance ID（来源追踪标识）误当成允许引用的 evidence ID。
- 真实可见 Player E2E（玩家端到端测试）完成 `GM -> Writer -> Checker -> TurnValidator`，生成第二张正文卡片和不可变回合。
- 数据库证据确认 GM、Writer、Checker 各一次调用，三次终态调用均有真实 Provider 和 Context Policy 回执，运行终态为 completed。

## Correct Fail-Closed Evidence

- 玩家声称“现在退潮”但当前状态未确认时，GM 返回 blocked（阻塞），没有写入回合。
- 正史明确入口后区域未知时，GM 拒绝替玩家探索未知区域，没有编造内容。
- GM 偶发引用 evidence 内容中的内部来源 ID 时，运行时以 `GM_EVIDENCE_MISMATCH` 阻止写入；修复通过减少可见内部 ID，而不是放宽校验。

## Not Completed

- 尚未生成和验证本阶段 Windows 安装包及升级包。
- 导入 Change Set 来源关联仍需要一致性 Doctor（检查器）覆盖极端数据库故障。

## Evidence

- GM report（GM 报告）：`notes/evidence/novax-gm-prompt-evals/gm-prompt-eval-2026-07-11T07-19-46-737Z.json`
- Report SHA-256：`c94a84e4150340f07b9e699e5a60a1b2f67d706b630cdb07b12a7ae3860a376f`
- Prompt SHA-256：`e5e6189fc52ba18d2e2f4b81a567f5905d02451576f3685df8844db814b7c23f`
- Real Player E2E（真实玩家端到端测试）：通过，20.9 秒。
