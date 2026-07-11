# Stage 5-6 Final Acceptance

Date: 2026-07-11
Release: `v0.2.0`

## Decision

Stage 5（第五阶段）和 Stage 6（第六阶段）的明确产品范围已形成真实闭环。Live（正式运行）路径没有本地 GM、Writer 或 Decomposer 回退；缺少 Provider（模型提供方）时失败关闭，导入候选不会绕过 Assist Change Set（协助变更集）直接写入 Canon（正史）。

## Stage 5 Evidence

| Requirement | Result | Authoritative evidence |
| --- | --- | --- |
| World Base（世界基底）、Story Project（故事项目）、OC Variant（角色变体）和版本化关系 | Complete | `tests/e2e/creative-object-lifecycle.spec.ts`; `src/domain/creative/` |
| Story-scoped Canon（故事范围正史）与不可变基线 | Complete | `src/domain/commit/creativeCommitRepository.ts`; `src/domain/story/storyProfileRepository.ts`; `tests/unit/story-playthrough-repositories.test.ts` |
| 不可变 Playthrough（游玩存档）和回合 | Complete | `src/domain/play/playthroughRepository.ts`; SQLite mutation triggers; `tests/unit/story-playthrough-repositories.test.ts` |
| 正史变化后的明确冲突处理 | Complete | 只允许 `continue_pinned` 或 `fork_from_current`; `src/domain/play/playthroughReconciliationService.ts`; `tests/unit/playthrough-reconciliation-service.test.ts` |
| 真实 GM -> Writer -> Checker -> TurnValidator | Complete | `src/agent-worker/play/playerTurnPipeline.ts`; `src/main/playerProcessSupervisor.ts`; `docs/stage5-gm-prompt-publication-status.md` |
| Provider 缺失时失败关闭 | Complete | `REAL_GM_PROVIDER_REQUIRED`; `tests/e2e/player-workbench.spec.ts`; `tests/e2e/provider-blocked.spec.ts` |
| 玩家卡片、行动输入、阻塞状态和冲突弹窗 | Complete | `src/renderer/src/features/player/PlayerWorkbench.tsx`; `tests/e2e/player-workbench.spec.ts` |
| 固定旧正史的上下文读取和审计 | Complete | `src/domain/retrieval/contextPacketService.ts`; `src/domain/audit/playerAuditRepository.ts`; `docs/stage5-player-audit-pinned-context-status.md` |

## Stage 6 Evidence

| Requirement | Result | Authoritative evidence |
| --- | --- | --- |
| TXT / Markdown / DOCX / EPUB / image（图片）来源注册和解析 | Complete | `src/domain/import/textSourceParserService.ts`; `src/domain/import/structuredSourceParserService.ts`; `tests/unit/text-source-parser-service.test.ts`; `tests/unit/structured-source-parser-service.test.ts` |
| 不可变 Source Library（来源库）和来源定位 | Complete | `src/domain/import/sourceLibraryRepository.ts`; source chunk hashes and structured locators |
| 真实 Decomposer（拆解器）与发布门 | Complete | `novax.decomposer@1.1.0`; `src/main/decomposerProcessSupervisor.ts`; `docs/stage6-decomposer-prompt-publication-status.md` |
| 人物、规则、地点、势力、事件、风格和歧义候选 | Complete | `src/shared/decomposerContracts.ts`; Decomposer publication eval cases |
| 人工修改、接受、拒绝和来源回查 | Complete | `src/domain/import/decompositionCandidateRepository.ts`; `src/renderer/src/features/import/ImportWorkbench.tsx`; `tests/e2e/import-workbench.spec.ts` |
| 多个 Start Profile（起始模板）和原著未来隔离 | Complete | `src/domain/play/startProfileRepository.ts`; candidate `seed` / `future` / `omit` policy; `tests/unit/start-profile-playthrough.test.ts` |
| 导入候选进入目标明确的 Assist Change Set | Complete | `src/domain/import/importCandidateChangeSetService.ts`; `docs/stage6-import-change-set-status.md` |
| 候选不能无来源写入正史 | Complete | immutable candidate revision links; Change Set source validation; `import_candidate` provenance |

## Verification

- TypeScript typecheck（类型检查）：通过。
- Vitest：73 个测试文件、277 个测试通过。
- Production build（生产构建）：通过；三个 Prompt publication gate（提示词发布门）全部通过。
- Electron Playwright：32 个通过，3 个真实 Provider 测试在无运行时凭据的标准套件中按设计跳过。
- Real Provider evidence（真实模型证据）：Decomposer Prompt 三项 DeepSeek 用例通过；GM Prompt 三项 DeepSeek 用例通过；可见 Player E2E 完成真实 GM、Writer、Checker 调用并持久化不可变审计。
- Windows installer（Windows 安装器）：NSIS 安装、重启、卸载和用户数据保留验证通过。
- Auto update（自动更新）：真实安装 `0.1.0` 后发现公开 `0.2.0`，状态为 `available` 且可下载；命令为 `npm run verify:update-from-old-client`。
- GitHub Release：`https://github.com/ccbili30-collab/novelx/releases/tag/v0.2.0`。

## Explicit Non-Goals And Residual Risks

- Image import（图片导入）在本阶段只证明文件身份、格式和尺寸；OCR（光学字符识别）、视觉理解和图像生成属于 Stage 7（第七阶段），没有伪装成已完成。
- 大型 EPUB / DOCX 的可见分块进度、暂停恢复和后台续跑仍未实现；当前解析是完整事务，失败不会留下部分正史。
- Player public state（玩家公开状态）只展示允许列表中的基础字段；通用数值系统仍属于后续增强。
- Windows Authenticode（Windows 代码签名）仍为 `NotSigned`，SmartScreen 可能提示未知发布者。没有证书时不能宣称完成签名。
- 标准 E2E 不持有或保存用户 Provider credential；真实 Provider 回归需要显式注入临时凭据。
