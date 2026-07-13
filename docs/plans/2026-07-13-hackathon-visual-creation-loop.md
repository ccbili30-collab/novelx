# NovelX Hackathon Visual Creation Loop Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** 在 10 天内用真实文本与图像 Provider（模型服务）打通“大管家讨论世界/OC → 结构化记录 → 生成故事 → 生成角色或场景图片 → 正文、图片、角色与事件图谱联合展示 → 玩家继续行动”的唯一演示主路径。

**Architecture:** 保持 Rust Runtime V2（第二版运行时）与 A2.2 Harness（智能体运行框架）冻结。复用现有 Steward、Change Set（变更集）、创作对象、Semantic Graph（语义图谱）和真实 GM/Writer 链；新增的图片能力位于 NovelX Domain Runtime（小说领域运行时），通过独立图像 Provider、持久化资产任务和结构化 Artifact（产物）接入。桌面端只显示已持久化状态，不用占位图、固定剧情或本地模板冒充 Live（真实运行）。

**Tech Stack:** Electron 43、React 19、TypeScript 6、Node.js SQLite、OpenAI-compatible Responses API（兼容响应接口）的 `image_generation` 工具、现有 Pi Agent、Playwright、Vitest、Windows PowerShell。

---

## 冻结边界

- 不继续 Hub、Coordinator、oh-my-pi、底层权限或 Rust Runtime V2 重构。
- 不实现市场、插件、协作群聊、完整地图系统、动画战斗或 Android 同步。
- 只修阻塞这条演示链的 P0；其余问题写入黑客松技术债清单。
- 文本 Provider 与图片 Provider 分开配置、测试与清除凭证。
- 图片 Provider 未配置或调用失败时必须 Fail Closed（失败关闭），显示真实错误和重试入口。

## 真实演示验收

1. 从已初始化的空工作区开始，在 Agent 模式用自然语言讨论一个世界和一个 OC。
2. 大管家产生来源可审计的世界、OC、故事、正文和断言变更；Assist 模式经用户确认后提交，Free 模式由现有策略提交。
3. 提交后无需重启，资源树、故事内容和图谱立即刷新。
4. 真实图片 Provider 生成至少一张角色立绘或场景图，文件、哈希、Prompt、模型、来源对象版本和状态持久化。
5. 联合展台同时显示正文、图片、角色卡和事件图谱；点击对象可回到真实文档或图谱节点。
6. 玩家模式使用同一故事配置继续一回合，GM/Writer 必须读取已提交世界和 OC 事实。
7. 文本或图片 Provider 缺失、网络失败、超时和非法响应均不得生成假结果。
8. Windows 安装构建可启动；同一演示脚本连续执行三次，不遗留 Electron 测试窗口或临时项目。

## Task 1: 提交后工作区即时刷新

**Files:**
- Modify: `src/renderer/src/features/agent/StewardRuntimePanel.tsx`
- Modify: `src/renderer/src/features/change-set/ChangeSetWorkbench.tsx`
- Modify: `src/renderer/src/App.tsx`
- Test: `tests/e2e/change-set-ui.spec.ts`
- Test: `tests/e2e/real-provider-world-to-story.spec.ts`

**Steps:**

1. 在 `StewardRuntimePanel` 增加 `onCommittedChangeSet` 回调，仅当 `run.completed` 携带 `committed` Change Set Artifact 时调用。
2. `ChangeSetWorkbench` 仅在 Assist 最终确认返回 `committed` 时触发同一个回调；接受、草稿和拒绝单项决策不刷新工作区。
3. 在 `App` 中复用 `refreshCreativeWorkspace()`，刷新 `workspace`、图谱选择状态和活动面板；不得在普通聊天完成时无意义刷新。
4. 扩展可见工作台 E2E 和真实 Provider E2E：Free 提交或 Assist 最终确认后，不重启 Electron 即能在 `workspace.getCurrent()` 与资源树看到新版本。
5. Run: `npx playwright test tests/e2e/change-set-ui.spec.ts`
6. 有 `NOVAX_REAL_E2E_API_KEY` 时 Run: `npx playwright test tests/e2e/real-provider-world-to-story.spec.ts`

## Task 2: 一次共创世界、OC、故事与事件

**Files:**
- Modify: `src/agent-worker/prompts/steward/<next-version>.md`
- Modify: `src/agent-worker/prompts/manifest.ts`
- Modify: `src/agent-worker/evals/adversarialCases.ts`
- Modify: `tests/e2e/real-provider-world-to-story.spec.ts`
- Create: `notes/evidence/novax-hackathon-world-oc-story/<real-eval>.json`

**Steps:**

1. 添加失败 Eval：要求 Steward 在一次有界任务内建立 `world`、`oc`、`story`，创建对应创作文档与 `uses_world`、`uses_oc` 关系，并以带来源的 `assertion.put` 记录关键规则和开场事件。
2. 运行 Eval，确认当前 Prompt 无法稳定满足多对象依赖或来源要求。
3. 发布新 Prompt 版本；明确“讨论不等于提交”，只有用户要求记录/创作时才提出 Change Set。
4. 要求模型使用 `dependsOn` 形成资源 → 文档 → 内容 → 关系/断言的拓扑顺序，禁止使用项目文件冒充创作对象。
5. 使用真实文本 Provider 运行 Eval 与 E2E，保存实际模型、Prompt 哈希、结构化工具调用和失败阻塞证据。
6. Run: `npm run eval:prompts:saved-provider`
7. Run: `npx playwright test tests/e2e/real-provider-world-to-story.spec.ts`

## Task 3: 独立图像 Provider 配置与真实连接测试

**Files:**
- Create: `src/shared/imageProviderContract.ts`
- Create: `src/main/imageProviderSecureStore.ts`
- Create: `src/main/imageProviderConnectionTest.ts`
- Create: `src/main/imageProviderIpc.ts`
- Modify: `src/shared/ipcContract.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/desktopApi.ts`
- Modify: `src/renderer/src/features/provider/ProviderSettingsDialog.tsx`
- Test: `tests/unit/image-provider-secure-store.test.ts`
- Test: `tests/unit/image-provider-connection-test.test.ts`
- Test: `tests/e2e/image-provider-settings-ui.spec.ts`

**Contract:**

```ts
interface ImageProviderConfig {
  providerId: string;
  displayName: string;
  baseUrl: string;
  modelId: string;
  endpoint: "responses";
  defaultSize: string; // 256–4096 像素范围内的 WIDTHxHEIGHT
  defaultQuality: "auto" | "low" | "medium" | "high";
  defaultBackground: "auto" | "transparent" | "opaque";
}
```

**Steps:**

1. 先写配置校验、HTTPS/本地回环约束、凭证不落日志和连接失败分类测试。
2. 图片连接测试发送最小真实生成请求；成功结果只保留模型、延迟、格式与内容哈希，立即清理测试图片。
3. 使用 Electron `safeStorage` 独立保存图片凭证，不复用或泄漏文本 Provider Key。
4. 设置页增加“图片模型”区域：状态、模型、尺寸、质量、连接测试、保存和清除凭证。
5. Run: `npx vitest run --config vitest.config.ts tests/unit/image-provider-secure-store.test.ts tests/unit/image-provider-connection-test.test.ts`
6. Run: `npx playwright test tests/e2e/image-provider-settings-ui.spec.ts`

## Task 4: 持久化图片任务与资产存储

**Files:**
- Modify: `src/domain/workspace/workspaceRepository.ts`
- Create: `src/domain/asset/imageAssetRepository.ts`
- Create: `src/domain/asset/imageAssetStore.ts`
- Create: `src/domain/asset/imageGenerationService.ts`
- Test: `tests/unit/image-asset-repository.test.ts`
- Test: `tests/unit/image-asset-store.test.ts`
- Test: `tests/unit/image-generation-service.test.ts`

**Data invariants:**

- `image_generation_jobs` 记录 queued/running/succeeded/failed、幂等键、Provider/模型、Prompt 哈希、来源对象与来源版本。
- `image_assets` 记录 MIME、宽高、文件哈希、相对路径和生成 Job；文件保存到 `.novax/assets/images/<sha256>.<ext>`。
- 临时文件先写 `.novax/assets/tmp`，校验 MIME、像素限制和哈希后原子移动；数据库提交失败则清理新文件。
- 相同幂等键不得重复收费或生成两个资产；不确定的 Provider 响应进入明确的 `reconciliation_required`，不能自动重试。

**Steps:**

1. 写 schema v21 迁移与旧工作区升级测试。
2. 写路径逃逸、超大响应、伪 MIME、重复幂等键和崩溃遗留临时文件测试。
3. 实现仓储、原子文件写入和真实 HTTP 生成服务。
4. 仅对明确未发送请求的连接错误自动重试；已接受的请求不盲目重发。
5. Run: `npx vitest run --config vitest.config.ts tests/unit/image-asset-repository.test.ts tests/unit/image-asset-store.test.ts tests/unit/image-generation-service.test.ts`

## Task 5: 将图片生成接入大管家领域工具

**Files:**
- Modify: `src/shared/agentWorkerProtocol.ts`
- Modify: `src/agent-worker/tools/createAgentTools.ts`
- Modify: `src/agent-worker/stewardExecutionStateMachine.ts`
- Modify: `src/main/workspaceAgentToolGateway.ts`
- Modify: `src/main/agentProcessSupervisor.ts`
- Modify: `src/agent-worker/workerController.ts`
- Modify: `src/shared/ipcContract.ts`
- Test: `tests/unit/steward-execution-state-machine.test.ts`
- Test: `tests/unit/agent-worker-contract.test.ts`
- Test: `tests/e2e/real-provider-visual-creation.spec.ts`

**Tool contract:**

```ts
generate_image({
  title: string,
  purpose: "character_portrait" | "scene",
  prompt: string,
  sourceResourceIds: string[],
  sourceVersionIds: string[],
  idempotencyKey: string
})
```

**Steps:**

1. 写状态机失败测试：未配置图片 Provider、来源版本缺失、越权资源、取消和调用失败必须返回结构化阻塞。
2. 工具执行前由 Main Process（主进程）复核工作区租约、资源范围与稳定来源版本。
3. 工具只调用领域图片服务，不修改 Harness 核心，不直接把图片升级为 Canon（正史）。
4. 成功后返回 `image` Artifact，包含 `assetId`、真实状态、来源和受管 URL；失败时不得返回 ready。
5. 用真实文本 Provider 触发工具，再用真实图片 Provider 生成资产，保存完整审计但清除 Key。
6. Run: `npx vitest run --config vitest.config.ts tests/unit/steward-execution-state-machine.test.ts tests/unit/agent-worker-contract.test.ts`
7. Run: `npx playwright test tests/e2e/real-provider-visual-creation.spec.ts`

## Task 6: 联合创作展台

**Files:**
- Create: `src/renderer/src/features/showcase/CreativeShowcase.tsx`
- Create: `src/renderer/src/features/showcase/CreativeShowcase.css`
- Create: `src/renderer/src/features/assets/ImageAssetCard.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/features/graph/SemanticGraphView.tsx`
- Modify: `src/shared/ipcContract.ts`
- Modify: `src/preload/desktopApi.ts`
- Modify: `src/main/workspaceIpc.ts`
- Test: `tests/e2e/creative-showcase.spec.ts`

**Steps:**

1. 增加只读的联合查询，返回选中故事的正文、关联世界、关联 OC、ready 图片和范围化图谱；不得复制或合并 Canon 数据。
2. Agent 模式完成创作后自动打开展台；IDE 模式仍可回到每个真实对象和文档。
3. 视觉布局以正文为主，角色卡和立绘在侧栏，事件图谱作为可展开区域；图片 loading/failed/stale 均有真实状态。
4. 点击正文来源、OC 或图谱节点跳回原始文档或检查器。
5. Run: `npx playwright test tests/e2e/creative-showcase.spec.ts`

## Task 7: 从展台进入玩家续写

**Files:**
- Modify: `src/renderer/src/features/showcase/CreativeShowcase.tsx`
- Modify: `src/renderer/src/features/player/PlayerWorkbench.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/domain/play/playerTurnContextService.ts`
- Test: `tests/unit/player-turn-context-service.test.ts`
- Test: `tests/e2e/real-provider-player.spec.ts`

**Steps:**

1. 从故事、世界和 OC 关系建立或选择现有 Story Profile（故事配置），不制造隐式默认世界。
2. 玩家提交一个行动，真实 GM 读取固定 Canon、OC 绑定、最近事件和状态，Writer 只润色 `gmResolution`。
3. 回合卡优先展示已绑定场景图；没有匹配图片时显示纯正文，不使用占位图。
4. 验证 GM 输出引用已提交世界规则和 OC 特征，且不泄漏内部字段。
5. Run: `npx vitest run --config vitest.config.ts tests/unit/player-turn-context-service.test.ts`
6. Run: `npx playwright test tests/e2e/real-provider-player.spec.ts`

## Task 8: 冻结、故障验收与安装包

**Files:**
- Create: `notes/status/2026-07-<day>-hackathon-demo-freeze.md`
- Create: `notes/engineering/hackathon-debt-register.md`
- Modify: `README.md`

**Steps:**

1. 冻结功能，只处理阻塞演示的 P0。
2. 集中运行一次全量测试：`npm test`、`npm run typecheck`、`npm run build`。
3. 使用真实文本和图片 Provider 连续执行三次完整脚本，保存脱敏事件、哈希、模型、耗时和结果截图。
4. 执行断网、文本 Provider 缺失、图片 Provider 缺失、图片超时和应用重启场景；确认没有假 Live。
5. Run: `npm run package:update`
6. Run: `npm run verify:installer`
7. 检查 Electron 测试进程与窗口，只清理本批测试创建且 PID/路径/用户数据目录均匹配的进程。
8. 登记未完成架构问题，不在最后一天顺手重构。

## 10 天停止条件

- 任一工作如果不能直接证明上述 8 条演示验收之一，停止并登记技术债。
- 图片 Provider 协议不兼容时，只增加一个明确适配器，不建立通用多 Provider 框架。
- 图谱只展示已确认断言和本次故事事件，不扩展完整时间线推理。
- 玩家模式只要求一个稳定回合，不追求完整数值战斗系统。
- 第 8 天结束后不再新增功能；第 9–10 天只修 P0、真实验收和打包。
