# World Director Task 1 脏基线盘点

日期：2026-07-18
分支：`codex/hackathon-10day`
HEAD：`60b097ed9a94be938837ab55008292b8b1372d99`
状态：Task 1 盘点证据；不代表现有生产代码已经验收或可提交。

## 1. 冻结边界

- 实时 `git status --short --untracked-files=all` 共 187 条：81 个已跟踪修改、106 个未跟踪、暂存区 0。
- 规范化状态清单 SHA-256：`C1E0B6792E8E42F2C5F0E885F06CF240788C3CCC2246B3CE92B42C9C8B5686EC`。
- 协作树仅有主 Agent；进程检查未发现命令行指向本 worktree 的 Node、Electron、npm、npx、pnpm、yarn、PowerShell 或 cmd 进程。
- 前后两次状态哈希一致，盘点期间未观察到外部修改。
- 所有无法确认归属或证据价值的文件均保留；本任务没有删除、恢复、暂存或清理生产文件。

## 2. 最高有效 Live（真实运行）边界

- 当前时间顺序最新的真实双 Provider（模型服务）证据是 `notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T19-37-29-443Z.json`。
- 它使用 `openai-compatible / gpt-5.4` 与 `openai-compatible-image / gpt-image-2`，`providerStarted=true`，最终 `outcome=failed_after_provider_start`，失败码为 `GROWTH_COORDINATOR_TERMINAL_NOT_COMPLETED`，`leakScan=passed`。
- 对应状态记录证明 C1–C4、C6–C9、C11 已提交，导出含 10 个资源、10 份稳定文档、6 个断言、13 条关系和 1 张真实地图，但 Closure（闭合验收）未接受，因此导出明确标记为 `incomplete`。
- 后续 Closure 来源修复只有 192/192 定向测试、typecheck、Prompt publication 与 diff checks 证据；尚未重新运行双 Provider Live，不能把修复后的代码称为 Live 可用。
- 更早失败证据继续作为诊断历史保留，不删除，也不用于证明当前 HEAD 整体通过。

## 3. 验收证据

- `git diff --check`：exit 0。
- `notes/evidence/novax-desktop-growth/*.json`：75/75 通过严格 UTF-8 解码和 JSON 解析。
- 明文凭据标记扫描：0 个文件命中已知 `api_key`、Authorization、access/refresh token、password、client secret、`sk-` 或 Bearer 凭据形式。
- 本任务未运行测试、typecheck、build、Electron 或 Provider；这些属于 Task 2 及后续验收。

## 4. 完整路径主分类

以下为单一主分类，目的是冻结所有权，不表示跨模块文件只服务一个能力。“无法确定归属”在完成逐 hunk（差异片段）审查前不得暂存或删除。

### 安全诊断系统（23）

- `?? docs/adr/2026-07-17-safe-diagnostic-pipeline-v1.md`
- `?? docs/plans/2026-07-17-safe-diagnostic-pipeline-v1.md`
- `?? notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`
- `?? src/agent-worker/diagnostics/safeDiagnosticEmitter.ts`
- `?? src/agent-worker/diagnostics/stewardDiagnostics.ts`
- `?? src/agent-worker/growth/phases/longform/growthLongformDiagnostics.ts`
- `?? src/agent-worker/growth/phases/revision/growthRevisionDiagnostics.ts`
- `?? src/agent-worker/pi/providerDiagnostics.ts`
- `?? src/domain/audit/safeDiagnosticRepository.ts`
- `?? src/main/diagnostics/changeSetPolicyDiagnostics.ts`
- `?? src/main/diagnostics/growthCycleDiagnostics.ts`
- `?? src/main/diagnostics/mainToolDiagnostics.ts`
- `?? src/main/growth/phases/revision/growthRevisionProposalDiagnostics.ts`
- `?? src/shared/diagnostics/growthInquiryDiagnostics.ts`
- `?? src/shared/diagnostics/README.md`
- `?? src/shared/diagnostics/safeDiagnosticCatalog.ts`
- `?? src/shared/diagnostics/safeDiagnosticContract.ts`
- `?? tests/unit/growth-cycle-diagnostics.test.ts`
- `?? tests/unit/main-tool-diagnostics.test.ts`
- `?? tests/unit/provider-diagnostics.test.ts`
- `?? tests/unit/safe-diagnostic-contract.test.ts`
- `?? tests/unit/safe-diagnostic-emitter.test.ts`
- `?? tests/unit/safe-diagnostic-repository.test.ts`

### Guidance / Revision（11）

- ` M src/agent-worker/growth/growthInquiryBrief.ts`
- ` M src/agent-worker/growth/phases/revision/growthImpactBrief.ts`
- ` M src/agent-worker/growth/phases/revision/growthRevisionFragment.ts`
- ` M src/agent-worker/growth/phases/revision/growthRevisionPhase.ts`
- `?? src/agent-worker/growth/phases/revision/growthRevisionReferences.ts`
- ` M src/main/growth/phases/revision/growthRevisionAuthorityResolver.ts`
- ` M src/main/growth/phases/revision/growthRevisionProposalPolicy.ts`
- ` M tests/unit/growth-revision-authority.test.ts`
- ` M tests/unit/growth-revision-fragment.test.ts`
- ` M tests/unit/growth-revision-phase.test.ts`
- `?? tests/unit/growth-revision-proposal-policy.test.ts`

### Closure continuation（10）

- ` M src/domain/growth/growthClosureEvaluator.ts`
- `?? src/main/growth/phases/closure/growthClosureContinuationAuthority.ts`
- `?? src/main/growth/phases/closure/growthClosureContinuationPlanner.ts`
- ` M src/main/growth/phases/revision/growthRevisionClosureSync.ts`
- `?? tests/e2e/support/growthClosureSafeEvidence.ts`
- `?? tests/unit/growth-closure-continuation-authority.test.ts`
- `?? tests/unit/growth-closure-continuation-planner.test.ts`
- ` M tests/unit/growth-closure-evaluator.test.ts`
- `?? tests/unit/growth-closure-safe-evidence.test.ts`
- `?? tests/unit/growth-revision-closure-sync.test.ts`

### Longform（10）

- ` M src/agent-worker/growth/growthLongformOutline.ts`
- ` M src/agent-worker/growth/growthLongformSection.ts`
- ` M src/agent-worker/growth/phases/longform/growthLongformPhase.ts`
- ` M src/domain/growth/growthLongformProgress.ts`
- ` M src/main/growth/phases/longform/growthLongformCoordinator.ts`
- `?? src/shared/growthLongformPolicy.ts`
- ` M tests/unit/growth-longform-authoring.test.ts`
- ` M tests/unit/growth-longform-coordinator.test.ts`
- ` M tests/unit/growth-longform-phase.test.ts`
- ` M tests/unit/growth-longform-progress.test.ts`

### 图片失败占位（8）

- `?? docs/adr/2026-07-17-failed-image-placeholder-semantics.md`
- ` M src/domain/asset/imageGenerationService.ts`
- ` M src/domain/asset/responsesImageProviderClient.ts`
- `?? src/renderer/src/assets/image-generation-failed.jpg`
- `?? src/renderer/src/features/assets/FailedImagePlaceholder.tsx`
- ` M src/renderer/src/features/assets/ImageAssetCard.tsx`
- `?? tests/unit/failed-image-placeholder.test.tsx`
- ` M tests/unit/image-provider-connection-test.test.ts`

### 世界包导出（2）

- `?? tests/e2e/support/growthWorldPackageExport.ts`
- `?? tests/unit/growth-world-package-export.test.ts`

### Renderer（10）

- ` M src/renderer/src/features/activity/RunWorkTargetPane.tsx`
- ` M src/renderer/src/features/agent/AgentArtifactList.tsx`
- ` M src/renderer/src/features/agent/growthPresentation.ts`
- ` M src/renderer/src/features/agent/RunActivityTimeline.tsx`
- ` M src/renderer/src/features/agent/StewardRuntimePanel.tsx`
- ` M src/renderer/src/features/growth/GrowthIllustrationGallery.tsx`
- ` M src/renderer/src/features/showcase/CreativeShowcase.tsx`
- ` M src/renderer/src/styles/base.css`
- ` M tests/e2e/growth-presentation-ui.spec.ts`
- ` M tests/unit/growth-presentation.test.ts`

### E2E / 真实证据（66）

- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T14-17-18-079Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T15-07-02-921Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T15-41-18-710Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T16-08-36-144Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T16-41-44-817Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T17-52-03-491Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T18-48-26-415Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T19-12-22-796Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T19-47-14-090Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T20-01-50-985Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T02-54-33-090Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T03-06-20-560Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T03-16-52-289Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T03-22-19-617Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T03-43-54-285Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T03-56-29-947Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T04-09-09-346Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T04-22-12-063Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T04-35-56-513Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T05-07-38-117Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T05-22-06-046Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T05-44-11-862Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T06-01-15-840Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T06-18-37-614Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T06-32-33-254Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T06-41-50-486Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T07-04-59-308Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T07-29-24-508Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T07-50-38-406Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T08-01-28-727Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T08-15-42-194Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T08-23-04-953Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T08-43-34-484Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T09-06-09-585Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T09-28-48-870Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T09-49-53-055Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T10-12-07-593Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T10-35-56-007Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T10-43-39-064Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T11-02-03-939Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T11-28-03-430Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T11-42-33-300Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T11-57-20-413Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T12-22-35-110Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T12-46-43-034Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T13-12-11-923Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T13-44-50-092Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T14-48-38-494Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T15-07-03-169Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T16-04-32-440Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T16-32-30-478Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T16-50-37-639Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T17-20-52-830Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T18-00-18-133Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T18-27-58-053Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T18-58-06-850Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-17T19-37-29-443Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-player-live-2026-07-15T13-40-53-343Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-player-live-2026-07-15T13-57-40-107Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-player-live-2026-07-15T14-16-45-125Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-player-live-2026-07-15T14-35-00-582Z.json`
- `?? notes/evidence/novax-desktop-growth/growth-player-live-2026-07-15T14-57-08-758Z.json`
- `?? notes/status/2026-07-16-hackathon-interactive-growth-final.md`
- ` M tests/e2e/real-provider-interactive-growth.spec.ts`
- ` M tests/e2e/support/growthWatcher.test.ts`
- ` M tests/e2e/support/growthWatcher.ts`

### 无法确定归属（47）

- ` M .gitignore`
- ` M docs/adr/2026-07-11-project-file-agent-gateway.md`
- ` M docs/adr/2026-07-15-hackathon-growth-run-bridge.md`
- ` M docs/adr/2026-07-16-hackathon-interactive-growth-and-illustration.md`
- ` M docs/plans/2026-07-16-hackathon-interactive-growth-completion.md`
- ` M docs/plans/2026-07-16-interactive-growth-illustration-p0.md`
- `?? docs/plans/2026-07-17-bounded-growth-self-diagnosis-repair-loop.md`
- `?? docs/plans/2026-07-17-continuous-growth-diagnosis-repair-standard.md`
- `?? docs/plans/2026-07-18-world-director-causal-growth-p0.md`
- ` M docs/product/novelx-desktop-product-requirements.md`
- ` M docs/project/current-state-and-routes.md`
- ` M src/agent-worker/growth/README.md`
- ` M src/agent-worker/stewardExecutionStateMachine.ts`
- ` M src/agent-worker/stewardRuntime.ts`
- ` M src/agent-worker/tools/createAgentTools.ts`
- ` M src/agent-worker/workerController.ts`
- ` M src/domain/audit/agentAuditRepository.ts`
- ` M src/domain/changeSet/changeSetService.ts`
- ` M src/domain/changeSet/workspaceChangeSetPolicy.ts`
- `?? src/domain/workspace/creativeDocumentPolicy.ts`
- ` M src/domain/workspace/creativeDocumentRepository.ts`
- ` M src/domain/workspace/workspaceRepository.ts`
- ` M src/main/agentProcessSupervisor.ts`
- ` M src/main/growth/README.md`
- ` M src/main/growthCoordinator.ts`
- ` M src/main/growthRunLifecycle.ts`
- ` M src/main/playerProcessSupervisor.ts`
- ` M src/main/workspaceAgentToolGateway.ts`
- ` M src/shared/agentWorkerProtocol.ts`
- ` M src/shared/ipcContract.ts`
- ` M tests/unit/agent-process-supervisor.test.ts`
- ` M tests/unit/agent-worker-contract.test.ts`
- ` M tests/unit/agent-worker-tool-bridge.test.ts`
- ` M tests/unit/artifact-provenance.test.ts`
- ` M tests/unit/change-set-service.test.ts`
- ` M tests/unit/decomposition-candidate-repository.test.ts`
- ` M tests/unit/growth-coordinator.test.ts`
- ` M tests/unit/growth-impact-brief.test.ts`
- ` M tests/unit/growth-inquiry-brief.test.ts`
- ` M tests/unit/growth-run-bridge.test.ts`
- ` M tests/unit/image-asset-repository.test.ts`
- ` M tests/unit/image-generation-service.test.ts`
- ` M tests/unit/ipc-contract.test.ts`
- ` M tests/unit/steward-execution-state-machine.test.ts`
- ` M tests/unit/workspace-agent-tool-gateway.test.ts`
- ` M tests/unit/workspace-change-set-policy.test.ts`
- ` M tests/unit/workspace-persistence.test.ts`

## 5. 下一入口

Task 2 只能先按 `src/agent-worker/growth/README.md` 与 `src/main/growth/README.md` 路由运行定向测试和 typecheck，重新验证旧错误是否仍存在。若失败涉及 `volume/story` 关系政策、公开协议、Schema、权限或产品语义，立即停止并请求产品决策。
