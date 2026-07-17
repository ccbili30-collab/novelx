# Safe Diagnostic Pipeline v1 执行计划

**日期：** 2026-07-17
**分支：** `codex/hackathon-10day`
**状态：** implementation and authorized verification complete / review pending
**目标：** 让所有跨可信边界的失败都能精准回答“谁失败、在哪一步、为什么、尝试几次、是否产生副作用、下一步怎么恢复”，同时不泄露正文、Prompt、工具参数、凭证、路径、原始异常或思维链。

---

## 0. 产品决定与完成口径

产品负责人已授权：

- 新增加法数据库 Schema v27；
- 新增版本化 Worker→Main 内部安全诊断消息；
- 新增 Main→Renderer 安全诊断投影；
- 不覆盖旧审计，不伪造旧诊断；
- 不改变 Canon（正史）、Creator/Player Lens（创作者/玩家视角）、权限、Change Set（变更集）原子性或 A2.2 Runtime 冻结语义。

“每一处报错精准可查”的工程口径：

1. 所有 Provider（模型服务）、Worker、Phase（阶段）、Tool Bridge（工具桥）、Main/Gateway（主进程/网关）、Domain（领域层）、Persistence（持久化）、Reconciliation（结果核对）和 Projection（投影）边界的失败都必须生成安全诊断。
2. 已知错误保留唯一稳定错误码；未知异常必须保留责任模块和阶段，并映射到该边界的 `*_UNEXPECTED`，不得统一成无归属的 `tool_failed`。
3. 在首次磁盘写入前进程被强杀或机器断电，无法保证原始错误事件已经落盘；重开后必须依据权威运行状态追加 `PROCESS_INTERRUPTED` 或 `RECONCILIATION_REQUIRED`，不得声称知道未落盘的具体原因。
4. UI 可以显示安全摘要，但不得展示原始异常、模型正文、工具参数、Prompt、凭证、URL query、磁盘路径或思维链。
5. 模型不能自行创造错误码或诊断事实；诊断只能由可信 Runtime/Domain 边界签发。

### 总进度

- [x] 0. 产品授权与执行计划
- [x] 1. 当前行为冻结与错误丢失点刻画
- [x] 2. 通用合同、错误目录与模块边界
- [x] 3. Schema v27 与不可变诊断仓储
- [x] 4. Worker/Provider/Tool/Main/Domain 全链接入
- [x] 5. Growth、AI 纠正与 Renderer 安全投影
- [x] 6. 全量、重开、失败关闭 UI 与冻结验收（真实 Live 未授权，未运行）

当前：**7/7 个已授权阶段完成｜真实 Provider Live、安装包、暂存和提交不在本次授权内，均未运行**

---

## 1. 当前问题基线

现有代码已经具备部分安全基础：

- `src/shared/publicErrors.ts` 将未知公开错误收敛为固定消息；
- Provider、Image Provider、Change Set、Agent Audit、Player Audit 和 Image Job 已保存部分 allowlisted error code；
- `agent_audit_events` 可以保存工具和 Run 终态错误码；
- Image Job 已保存 `status`、`request_sent_at` 和 `error_code`；
- Growth Cycle 保存终态 `failureCode`；
- UI 不显示原始 Provider 错误和思维链。

当前丢失点：

```text
Phase 私有错误
  → Worker catch
  → tool_failed
  → Growth Change Set not committed
  → UI “已阻塞”
```

已确认实例：

- Revision Cycle 已完成 retrieve 和 Inquiry；
- `propose_change_set` 没有进入 Main audit；
- Worker 终态只有 `tool_failed`；
- 现有证据不能区分 Fragment Schema、编译 authority、引用、纠正耗尽或 Bridge 前失败。

这不是缺少更多日志文本，而是缺少可持久、可关联、可重放的结构化安全诊断。

---

## 2. 不变量

### 2.1 安全不变量

- 诊断结构不得包含任意 `message`、stack、raw cause 或自由 JSON。
- 用户文案和模型纠正指令必须由本地 code catalog 派生。
- code、owner、boundary、tool、disposition、retryability 和 side-effect state 均为严格枚举或模块 allowlist。
- `diagnosticId`、`runId`、`cycleId`、`toolInvocationId` 只用于关联；Renderer 不得由这些 ID 读取未授权内容。
- Secret marker、Authorization header、URL query、Provider payload、数据库绝对路径不得持久化。
- Player Lens 不得通过诊断暴露隐藏事实、Creator scope 或内部资源标题。

### 2.2 权威不变量

- 第一个识别错误的可信模块创建诊断；下游只引用它，不覆盖根因。
- 下游自身失败时创建子诊断并绑定 `parentDiagnosticId`。
- 模型只能接收 Runtime 投影的纠正指令，不能提交诊断码。
- UI 只投影 Main 验证且已持久化的诊断。
- `sideEffectState=none` 才允许模型结构纠正重试。
- `request_sent` 或 `outcome_unknown` 不得自动重试。
- `committed` 后的展示或图片失败不能回滚或伪装已经提交的 Change Set。

### 2.3 可维护性不变量

- 通用 Envelope（信封）稳定；具体错误码归所属模块定义。
- Revision 错误目录位于 Revision 目录，Image 错误目录位于 Image 模块，不把所有错误枚举继续堆入 `agentWorkerProtocol.ts`。
- 顶层状态机只接收 `SafeDiagnosticEmitter` seam，不理解每个阶段的具体错误。
- 新增一个 Phase 错误只修改该 Phase catalog 和对应测试，不修改所有跨层核心文件。

---

## 3. 通用安全诊断合同

计划新增：

- `src/shared/diagnostics/safeDiagnosticContract.ts`
- `src/shared/diagnostics/safeDiagnosticCatalog.ts`
- `src/shared/diagnostics/README.md`
- `tests/unit/safe-diagnostic-contract.test.ts`

Envelope v1：

```ts
interface SafeDiagnosticEnvelopeV1 {
  schemaVersion: 1;
  diagnosticId: string;
  operationKind: "agent_run" | "growth_cycle" | "tool_call" | "image_job" | "provider_test" | "projection";
  operationId: string;
  runId: string | null;
  cycleId: string | null;
  toolInvocationId: string | null;
  parentDiagnosticId: string | null;
  sequence: number;
  owner: SafeDiagnosticOwner;
  boundary: SafeDiagnosticBoundary;
  code: string;
  toolName: string | null;
  attempt: number | null;
  maxAttempts: number | null;
  sideEffectState: "none" | "request_sent" | "outcome_unknown" | "committed";
  disposition: "observed" | "correctable" | "corrected" | "terminal" | "reconciliation_required";
  retryability: "model_correction" | "safe_retry" | "user_action" | "restart_reconcile" | "do_not_retry";
  occurredAt: string;
}
```

合同不得新增：

- `message`；
- `details: unknown`；
- `metadata: Record<string, unknown>`；
- 模型、工具或 Renderer 可写的 arbitrary context。

### Owner 分类

- `provider`
- `worker_schema`
- `growth_phase`
- `tool_bridge`
- `main_gateway`
- `domain_policy`
- `persistence`
- `reconciliation`
- `projection`

### Boundary 分类

- `provider_connect`
- `provider_inference`
- `provider_protocol`
- `tool_arguments`
- `phase_compile`
- `phase_correction`
- `worker_to_main`
- `tool_authorization`
- `tool_execution`
- `change_set_policy`
- `change_set_apply`
- `database_commit`
- `asset_commit`
- `recovery`
- `renderer_projection`

---

## 4. 错误目录规则

每个模块提供本地 catalog：

```ts
interface SafeDiagnosticDefinition {
  code: string;
  owner: SafeDiagnosticOwner;
  boundary: SafeDiagnosticBoundary;
  defaultRetryability: SafeDiagnosticRetryability;
  userSummaryKey: string;
  modelCorrectionKey: string | null;
}
```

目录示例：

- `src/agent-worker/growth/phases/revision/growthRevisionDiagnostics.ts`
- `src/agent-worker/pi/providerDiagnostics.ts`
- `src/agent-worker/tools/toolBridgeDiagnostics.ts`
- `src/main/diagnostics/mainGatewayDiagnostics.ts`
- `src/domain/changeSet/changeSetDiagnostics.ts`
- `src/domain/asset/imageDiagnostics.ts`
- `src/domain/audit/persistenceDiagnostics.ts`

错误码前缀：

- `PROVIDER_*`
- `WORKER_SCHEMA_*`
- `GROWTH_<PHASE>_*`
- `TOOL_PROTOCOL_*`
- `GATEWAY_*`
- `DOMAIN_*`
- `PERSISTENCE_*`
- `RECONCILIATION_*`
- `PROJECTION_*`

禁止新增无责任归属的 `UNKNOWN_FAILED`、`TOOL_FAILED` 或复用 `AGENT_RUN_FAILED` 作为内部根因。公开边界仍可使用概括码，但必须绑定根诊断 ID。

---

## 5. Schema v27 与仓储

计划修改：

- `src/domain/workspace/workspaceRepository.ts`
- `src/domain/audit/safeDiagnosticRepository.ts`
- `tests/unit/safe-diagnostic-repository.test.ts`
- `tests/unit/workspace-persistence.test.ts`
- `docs/adr/2026-07-17-safe-diagnostic-pipeline-v1.md`

新增 append-only（仅追加）表 `safe_diagnostic_events`：

```sql
CREATE TABLE safe_diagnostic_events (
  id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  run_id TEXT,
  cycle_id TEXT,
  tool_invocation_id TEXT,
  parent_diagnostic_id TEXT,
  sequence INTEGER NOT NULL,
  owner TEXT NOT NULL,
  boundary TEXT NOT NULL,
  code TEXT NOT NULL,
  tool_name TEXT,
  attempt INTEGER,
  max_attempts INTEGER,
  side_effect_state TEXT NOT NULL,
  disposition TEXT NOT NULL,
  retryability TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE(operation_kind, operation_id, sequence),
  FOREIGN KEY(parent_diagnostic_id) REFERENCES safe_diagnostic_events(id)
);
```

索引：

- `(run_id, sequence)`
- `(cycle_id, sequence)`
- `(tool_invocation_id, sequence)`
- `(operation_kind, operation_id, sequence)`
- `(owner, boundary, code)`

仓储要求：

- 严格 Schema parse 后写入；
- 同一 idempotency identity 精确重放；
- 不同 payload 复用 ID 必须拒绝；
- sequence 单调；
- parent 必须已存在且同 workspace；
- 不提供 update/delete；
- 诊断持久化自身失败时不得递归创建无限诊断；只允许现有 Agent Audit 写入固定 `DIAGNOSTIC_PERSISTENCE_FAILED` 并终止。

迁移要求：

- v26→v27 只新增表、索引和 schema version；
- 不改写旧 Agent、Growth、Change Set、Document、Assertion、Image 行；
- 旧运行没有诊断属于事实，不补造历史；
- 中途失败整个迁移回滚；
- 重开幂等。

---

## 6. Worker 与模型纠正接入

计划新增/修改：

- `src/agent-worker/diagnostics/safeDiagnosticEmitter.ts`
- `src/agent-worker/growth/phases/revision/growthRevisionDiagnostics.ts`
- `src/agent-worker/growth/phases/revision/growthRevisionPhase.ts`
- `src/agent-worker/stewardExecutionStateMachine.ts`（仅增加通用 emitter seam）
- `src/agent-worker/stewardRuntime.ts`
- `src/shared/agentWorkerProtocol.ts`（只引用版本化 Envelope，不内嵌 Phase 枚举）
- `tests/unit/growth-revision-phase.test.ts`
- `tests/unit/steward-execution-state-machine.test.ts`
- `tests/unit/agent-worker-contract.test.ts`

执行规则：

1. Phase 编译失败前记录 `observed/correctable`，`sideEffectState=none`。
2. 固定纠正指令由 code catalog 派生并返回模型。
3. 每次纠正使用相同根诊断并追加新的 attempt 事件。
4. 纠正成功追加 `corrected`。
5. 达到上限追加 `terminal`，最终 Steward 输出只能引用 Runtime 注入的 `diagnosticId`。
6. Tool request 发出后更新为新边界事件，不得回写旧事件。
7. Worker 原始异常不得通过 process message、stderr 或 audit details 传播。

Revision 首个目标用例：

```text
retrieve succeeded
→ inquiry selected
→ Revision impact mismatch attempt 1/2
→ model correction
→ impact mismatch attempt 2/2
→ terminal
→ no Main tool request
→ sideEffectState=none
```

必须能够直接从持久化诊断重放上述事实。

---

## 7. Provider、Tool、Main、Domain 与图片接入

### 7.1 Provider

- `PROVIDER_CONNECTION_FAILED`
- `PROVIDER_TIMEOUT`
- `PROVIDER_RATE_LIMITED`
- `PROVIDER_AUTH_FAILED`
- `PROVIDER_MODEL_UNAVAILABLE`
- `PROVIDER_PROTOCOL_FAILED`
- `PROVIDER_OUTCOME_UNKNOWN`
- `PROVIDER_UNEXPECTED`

要求：已有 Provider 脱敏逻辑继续生效；HTTP body、URL、header 和上游 message 不持久化。

### 7.2 Tool Bridge

- 参数 Schema 失败必须区分 `tool_arguments`；
- Worker request 未发出与 Main 已接收必须可区分；
- timeout、cancel、response pairing、duplicate terminal 分开；
- `request_sent` 后失败不能标为无副作用。

### 7.3 Main/Gateway

- 权限、scope、checkpoint、tool policy、idempotency、executor 分开；
- Main 审计必须引用 Worker 根诊断；
- 未进入 Main 的错误不得伪造 Tool Invocation；
- 已进入 Main 的调用必须有真实 invocation identity。

### 7.4 Domain/Change Set

- input、policy、major conflict、apply、commit、outcome unknown 分开；
- Free 直接提交产品决定保持不变；
- elevated 只审计，不产生 review；
- major conflict 和非法 Domain 操作仍失败关闭。

### 7.5 Image

- 复用现有 Image Job `error_code`；
- Job 诊断关联 `imageJobId`，不得复制 prompt；
- connection、generation、protocol、asset commit、outcome unknown 分开；
- Job succeeded 必须对应 Asset；Asset 缺失创建独立持久化诊断。

### 7.6 Persistence/Reconciliation

- SQLite transaction、file asset commit、audit commit 分开；
- `outcome_unknown` 与普通失败分开；
- 重开恢复不得猜测原错误；只追加 recovery 诊断并引用已存在的根诊断。

---

## 8. Growth 与 Renderer 投影

计划修改：

- `src/shared/growthContract.ts`
- `src/main/growthRunLifecycle.ts`
- `src/main/growth/growthPresentationProjector.ts`
- `src/shared/ipcContract.ts`
- `src/preload/desktopApi.ts`
- `src/renderer/src/features/agent/growthPresentation.ts`
- `src/renderer/src/features/agent/RunActivityTimeline.tsx`
- `src/renderer/src/features/activity/RunWorkTargetPane.tsx`
- `tests/unit/growth-run-bridge.test.ts`
- `tests/unit/ipc-contract.test.ts`
- `tests/unit/growth-presentation.test.ts`

Growth snapshot 新增只读安全诊断投影：

```ts
interface GrowthDiagnosticProjection {
  diagnosticId: string;
  cycleId: string;
  owner: SafeDiagnosticOwner;
  boundary: SafeDiagnosticBoundary;
  code: string;
  attempt: number | null;
  maxAttempts: number | null;
  sideEffectState: SafeSideEffectState;
  disposition: SafeDiagnosticDisposition;
  userSummary: string;
}
```

`userSummary` 由 Main 本地 catalog 生成，Renderer 不拼接任意字符串。

UI 行为：

- 中央时间线显示阶段和安全摘要；
- 可展开查看 owner、code、attempt、side effect、recovery；
- 正在纠正显示 `第 1/2 次`；
- `sideEffectState=none` 显示“项目未修改”；
- `outcome_unknown` 显示“结果需要核对”，禁止显示失败后可立即重试；
- committed 后图片失败仍显示文本已提交；
- Player Lens 不显示 Creator-only target。

---

## 9. 实施阶段与勾选表

### 阶段 1：Characterization Tests（行为刻画测试）

- [x] 固定 Revision pre-executor 错误当前会被压成 `tool_failed`。
- [x] 固定 Main tool error 已有 audit code。
- [x] 固定 Image Job 已有安全 error code。
- [x] 固定 unknown public error 会变成概括码。
- [x] 固定 restart 会产生 interrupted/reconciliation，而不是猜根因。
- [x] 记录当前测试数量和失败基线：5 files / 86 passed / 0 skipped。

停止条件：测试无法稳定区分边界，先补测试 seam，不改产品逻辑。

### 阶段 2：合同与目录

- [x] 新增严格 Envelope v1。
- [x] 新增 owner/boundary/effect/disposition/retryability 枚举。
- [x] 新增 module-local catalog 接口。
- [x] Revision catalog 首个落地。
- [x] raw message/details/metadata 负例全部拒绝。
- [x] 编写 AI 最短阅读 `README.md`。

停止条件：必须把 Phase 私有错误重新塞回巨型共享枚举时，重新调整边界。

### 阶段 3：Schema v27 与 Repository

- [x] 实现加法迁移。
- [x] 实现 append/replay/list。
- [x] 覆盖 ID 重放冲突、sequence、parent、跨 Run/Cycle 拒绝。
- [x] 覆盖迁移中途回滚与旧库兼容。
- [x] 覆盖诊断持久化失败不递归。
- [x] ADR 与 Schema 版本一致。

停止条件：迁移需要重写旧内容、伪造历史或双写权威。

### 阶段 4：全边界接入

- [ ] Revision Phase。
- [ ] Worker Schema。
- [ ] Provider adapter。
- [ ] Tool Bridge。
- [ ] Main Supervisor/Gateway。
- [ ] Domain/Change Set。
- [ ] Image Job/Asset。
- [ ] Persistence/Reconciliation。
- [ ] 每个边界至少一个成功、失败、未知错误测试。

停止条件：一个错误被多个模块重复签发，或下游覆盖根 code。

### 阶段 5：Growth 与 UI

- [ ] Growth Cycle 关联根诊断。
- [ ] safe snapshot 只投影 allowlisted 字段。
- [ ] 模型收到固定纠正指令。
- [ ] 用户看到安全错误摘要和副作用状态。
- [ ] blocked/failed/reconciliation/committed+image-failed 都真实展示。
- [ ] Player Lens 隔离回归。
- [ ] Renderer 不从自然语言猜测错误阶段。

停止条件：需要暴露原始日志、Prompt、args 或隐藏事实才能解释错误。

### 阶段 6：冻结验收

- [ ] 定向错误矩阵全通过。
- [ ] `npm run typecheck`。
- [ ] 三组 Prompt publication gate。
- [ ] `npm test`，0 unexpected skips。
- [ ] `npm run build`。
- [ ] 无 Provider fail-closed Electron E2E。
- [ ] 强杀/重开/幂等恢复测试。
- [ ] 一次真实交互 Growth Live。
- [ ] 若 Live 失败，证据必须直接给出 owner/boundary/code/attempt/effect。
- [ ] 若 Live 成功，必须证明纠正事件或完整成功路径，不能因成功而跳过错误链验收。
- [ ] 更新 current-state、状态索引、ADR 和计划勾选。
- [ ] 精确审查 staged files 后提交；不推送，除非另有授权。

---

## 10. 验收矩阵

| 边界 | 确定性故障 | 必须持久化 | 模型可见 | 用户可见 | 副作用要求 |
|---|---|---|---|---|---|
| Provider | timeout | owner/stage/code | 停止或固定重试指令 | 模型超时 | request_sent/outcome_unknown 正确 |
| Worker Schema | invalid args | schema code/attempt | 具体字段修正方向 | 正在修正工具输入 | none |
| Revision | impact mismatch | Phase code 1/2、2/2 | 固定 impact 指令 | 修订证据不一致 | none |
| Tool Bridge | pairing failure | protocol code | 不继续依赖步骤 | 工具协议失败 | none 或 request_sent |
| Gateway | stale checkpoint | gateway code | 重新检索 | 项目已变化，需重检 | none |
| Domain | invalid relation | domain code | 修正关系类型 | 关系不合法 | transaction rolled back |
| Persistence | SQLite commit fail | persistence code | 不重试写入 | 保存失败 | rolled back/unknown 精确 |
| Image | provider protocol fail | job+diagnostic code | 不伪造 ready | 图片生成失败 | Job failed、Asset 0 |
| Reconciliation | sent then crash | outcome unknown | 禁止自动重试 | 需要核对 | no duplicate effect |
| Projection | hidden fact | projection code | 不适用 | 安全内容不可显示 | domain unchanged |

---

## 11. 验收命令

定向合同与仓储：

```powershell
npx --no-install vitest run --config vitest.config.ts `
  tests/unit/safe-diagnostic-contract.test.ts `
  tests/unit/safe-diagnostic-repository.test.ts `
  tests/unit/workspace-persistence.test.ts
```

Worker/Main/Domain：

```powershell
npx --no-install vitest run --config vitest.config.ts `
  tests/unit/agent-worker-contract.test.ts `
  tests/unit/steward-execution-state-machine.test.ts `
  tests/unit/agent-process-supervisor.test.ts `
  tests/unit/growth-run-bridge.test.ts `
  tests/unit/change-set-service.test.ts `
  tests/unit/image-generation-service.test.ts
```

IPC/UI：

```powershell
npx --no-install vitest run --config vitest.config.ts `
  tests/unit/ipc-contract.test.ts `
  tests/unit/growth-presentation.test.ts
```

冻结：

```powershell
npm run typecheck
npm run verify:prompt-publication
npm run verify:decomposer-prompt-publication
npm run verify:gm-prompt-publication
npm test
npm run build
git diff --check
```

真实 Live 必须单独获得授权，不得自动重跑。

---

## 12. 风险与反讨好检查

### 风险 1：把诊断系统做成新的巨型协议

控制：共享层只保存 Envelope；错误目录归模块；顶层不理解 Phase code。

### 风险 2：为了“精准”泄露内容

控制：无自由 message/details；文案由 catalog 派生；严格 leak scan；敏感字段负例。

### 风险 3：诊断失败导致递归写错

控制：诊断仓储禁止在自身 catch 中再写诊断，只向已有 Agent Audit 写固定终态。

### 风险 4：把模型当错误权威

控制：模型只接收纠正投影；diagnosticId/code 由 Runtime 注入并校验。

### 风险 5：有诊断就误称功能成功

控制：诊断只是可观测性；真实 Growth、Change Set、图片、重开仍按原验收完成。

### 风险 6：承诺物理上每个错误绝不丢失

控制：只承诺可信边界已观察的错误；进程在首次写入前消失时，恢复只能记录 interrupted，不能伪造具体原因。

---

## 13. 提交策略

建议按语义拆为四个提交：

1. `test(diagnostics): characterize error loss boundaries`
2. `feat(diagnostics): persist safe diagnostic envelopes`
3. `feat(diagnostics): connect runtime and growth projections`
4. `test(diagnostics): verify recovery and real error evidence`

任何提交前必须：

- typecheck 通过；
- 对应定向测试通过；
- 文档勾选与真实代码一致；
- staged names 精确；
- 不包含 Provider profile、构建产物、trace、截图或未授权 evidence；
- 五份现有 Player failure evidence 不修改、不删除、不暂存。

---

## 14. 下一执行入口

从阶段 1 开始，只写 Characterization Tests：

1. 固定 Revision pre-executor 错误丢失；
2. 固定 Main tool error 已持久化；
3. 固定 Image Job error 已持久化；
4. 固定 restart 只能声明 interrupted/reconciliation；
5. 红灯成立后再进入 Envelope 合同。

在阶段 1 完成前，不修改 Schema、Runtime 或 Renderer。
