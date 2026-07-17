# Continuous Growth Diagnosis and Repair Standard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Use `tdd`, `winzhong`, and `zhongyan` for every repair candidate.

**Goal:** 建立并执行一套无全局轮数上限、按独立错误指纹持续推进的 Growth 自诊断修复标准，直到真实交互 Growth 完整验收通过，或命中必须由产品负责人决定的硬停止条件。

**Architecture:** 每次真实失败先保存安全证据，再按 owner、boundary、code、side-effect state 形成错误指纹。聚合错误不是停止理由：先在唯一可信边界补 allowlisted Safe Diagnostic（安全诊断），构造不依赖 Provider 的确定性复现，再以 TDD（测试驱动开发）修复。每个候选通过全量冻结后只运行一次真实 Live；若出现新的独立指纹，则自动回到诊断入口继续，而不是设置全局 R3/R4 上限。

**Tech Stack:** Windows 11、PowerShell、TypeScript、Electron、React、SQLite、Vitest、Playwright、Zod/TypeBox、真实 `openai-compatible / gpt-5.4` 与 `openai-compatible-image / gpt-image-2`。

---

## 0. 权威事实与边界

- 分支：`codex/hackathon-10day`。
- 起始 HEAD：`60b097ed9a94be938837ab55008292b8b1372d99`。
- 工作树是混合未提交状态；不得 reset、checkout、clean、自动暂存、提交或推送。
- 当前最高交互证据：`notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T20-01-50-985Z.json`。
- 当前事实：Cycle 1/Cycle 2 committed；2 个 Change Set；2 次 checkpoint 前移；Cycle 3=`planned`、无 Run/Receipt/Change Set；`growth.get` 返回 `Growth Run bridge failed`；本次没有 Safe Diagnostic。
- 当前冻结基线：focused 105/105；full 136 files / 872 tests；typecheck、Prompt gate、build、diff check 通过；Electron residue=0。
- 已证明的修复：合法 Revision 同批文档证据不再被误判为 Greenfield。
- 未证明：Cycle 3 planned 恢复/启动、Closure、Repair、Longform、后续插图、reopen、research 的同一交互 Live。

## 1. 标准循环状态表

| 阶段 | 状态 | 当前证据 | 完成条件 |
| --- | --- | --- | --- |
| S0 基线冻结 | [x] | 872/872、typecheck/build | 无并发修改、staged=0 |
| D1 planned-Cycle bridge 复现 | [ ] | `20-01-50-985Z` | 无 Provider 的确定性红灯 |
| D2 bridge 安全诊断 | [ ] | 当前缺失 | 精确 owner/boundary/code/effect |
| R1 bridge 根因修复 | [ ] | 未开始 | 红→绿且不重复 Run/Change Set |
| F1 候选冻结 | [ ] | 未开始 | focused/full/typecheck/build 全绿 |
| L1 单次真实复验 | [ ] | 未运行 | 一次、无 retry、证据可解析 |
| N1 后续指纹循环 | [ ] | 未到达 | 新指纹回到 Task 2 |
| A1 完整交互验收 | [ ] | 未完成 | Task 8 全部成立 |
| E1 证据/状态收口 | [ ] | 未完成 | 状态、索引、恢复入口一致 |

## 2. 持续循环规则

### 2.1 错误指纹

每个失败用下列字段形成稳定指纹：

```text
owner / boundary / code / sideEffectState / operationKind / toolName
```

不得把 E2E 汇总码、UI 文案或原始异常消息作为唯一指纹。

### 2.2 自动继续条件

同时满足下列条件时，不等待用户确认，自动进入修复：

- `sideEffectState=none`；
- code 或确定性复现唯一定位一个 owner 模块；
- 修复不改变产品定义、公开协议、Schema、迁移、权限、Canon、Lens 或数据兼容性；
- 能先写稳定失败测试；
- 不降低现有验收门槛；
- 该精确指纹没有在同一候选上修过后原样复发。

### 2.3 聚合错误处理

若只有 `Growth Run bridge failed`、`AGENT_TOOL_FAILED` 等聚合错误：

1. 不猜根因。
2. 找到最窄可信 catch/return 边界。
3. 增加模块本地 allowlisted code。
4. 公开错误保持安全聚合；后台持久化精确 code。
5. 写 strict-schema、未知码收敛、无 raw message/args/content/credential 回归。
6. 再执行确定性复现；不得直接消耗 Provider Live。

### 2.4 硬停止条件

只有以下情况停止并请求产品负责人：

- `request_sent`、`committed` 或 `outcome_unknown` 且自动重试可能重复副作用；
- 两种合理修法会产生不同用户体验或领域语义；
- 需要公开协议、Schema、迁移、权限、Canon、Lens 或 A2.2 变化；
- 需要删除、重写或迁移用户数据；
- Provider 认证、额度、模型不可用或外部服务持续故障；
- 同一精确指纹经过一次最小修复和一次真实复验后原样复发；
- 补齐诊断后仍无法唯一定位责任模块；
- 继续必须降低现有验收门槛或伪造 Live。

硬停止只终止当前错误指纹，不得把已通过能力描述为失败，也不得把局部成功描述为完整闭环。

---

### Task 1: 冻结工作树和当前证据

**Files:**
- Read: `CONTEXT.md`
- Read: `docs/project/current-state-and-routes.md`
- Read: `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`
- Read: `notes/evidence/novax-desktop-growth/growth-guidance-live-2026-07-16T20-01-50-985Z.json`
- Modify: this plan only for checkbox/ledger updates

**Step 1: 检查分支、HEAD、暂存区和并发进程**

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
git diff --cached --name-only
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'"
```

Expected: branch/head match；staged=0；无本工作树 Electron；不得因 dirty 工作树停止。

**Step 2: 验证 evidence**

使用 PowerShell UTF-8 `ConvertFrom-Json`、Node `JSON.parse`、SHA-256 和既有 leak scan 字段。不得输出正文、Prompt、工具参数或凭据。

**Step 3: 更新状态表**

只记录事实；不修改生产代码。

---

### Task 2: 确定性复现 `C3 planned → growth.get bridge failed`

**Files:**
- Inspect: `src/main/growthCoordinator.ts`
- Inspect: `src/main/growthRunLifecycle.ts`
- Inspect: `src/main/workspaceIpc.ts`
- Inspect: `src/main/registerDesktopIpc.ts`
- Inspect: `src/domain/growth/growthRepository.ts`
- Test: `tests/unit/growth-coordinator.test.ts`
- Test: `tests/unit/growth-run-bridge.test.ts`
- Test: `tests/unit/workspace-ipc.test.ts`

**Step 1: 找到 `growth.get` 完整调用链**

记录 Renderer IPC（进程间通信）入口、Main Coordinator、planned Cycle 恢复、Run attach 和快照投影的实际函数。不得先改 catch。

**Step 2: 写最小失败测试**

用真实 SQLite Repository 构造：

```text
Goal active
C1 committed with output checkpoint
C2 committed with output checkpoint
C3 planned, input=C2 output, no runId
new/recovered Coordinator
growth.get(projectId, sessionId, goalId)
```

断言：当前实现稳定抛出聚合错误或进入错误分支；没有 Worker spawn、Run、Receipt、Change Set 或 checkpoint 增量。

**Step 3: 运行红灯**

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-coordinator.test.ts tests/unit/growth-run-bridge.test.ts tests/unit/workspace-ipc.test.ts
```

Expected: 新用例失败，既有用例通过。若无法复现，转 Task 3 补只读诊断，不得猜修。

---

### Task 3: 为 planned-Cycle bridge 增加精确安全诊断

**Files:**
- Modify only the unique boundary found in Task 2
- Prefer: `src/main/growthCoordinator.ts` or a new capability-local diagnostic catalog under `src/main/growth/`
- Modify if needed: `src/main/diagnostics/mainToolDiagnostics.ts`
- Test: matching coordinator/IPC/safe-diagnostic tests
- Modify: `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`

**Step 1: 定义模块本地 code**

只为实际边界定义，例如：

```text
GROWTH_PLANNED_CYCLE_RECOVERY_INVALID
GROWTH_PLANNED_CYCLE_BINDING_INVALID
GROWTH_PLANNED_CYCLE_START_FAILED
GROWTH_SNAPSHOT_PROJECTION_FAILED
```

不得预先全部加入；只加入代码证实的谓词。

**Step 2: 写安全回归**

覆盖：精确 code、owner、boundary、`sideEffectState=none`；未知异常收敛；公开 IPC 不含 raw message、stack、IDs、内容、路径、凭据。

**Step 3: 最小实现**

公开用户文案保持聚合；后台 SafeDiagnosticRepository 保存精确 code。不得新增公共协议字段或迁移。

**Step 4: 运行定向测试和 typecheck**

Expected: 新诊断用例通过，未改变 Growth 正常路径。

---

### Task 4: 修复唯一根因

**Files:**
- Only: Task 3 确认的 owner 模块、直接测试和状态文档
- Forbidden: Prompt tuning、Renderer workaround、Gateway/Policy 放宽、Schema/迁移、无关阶段

**Step 1: 写产品不变量测试**

至少覆盖：

- 多次 `growth.get` 幂等；
- planned Cycle 恢复最多启动一个 Run；
- Run attach 前失败不产生 Receipt/Change Set；
- attach 后失败按既有 reconciliation 语义处理；
- 重开后不重复 Run；
- C2 output checkpoint 必须是 C3 input checkpoint；
- 未授权项目/session 仍失败关闭。

**Step 2: 验证红灯**

只运行最小文件，确认与 Task 3 精确指纹一致。

**Step 3: 最小实现**

修复现有不变量漂移；不得加永久兼容垫片或 catch-and-ignore。

**Step 4: 绿灯**

运行 owner 模块及相邻状态机/仓储测试。

---

### Task 5: 冻结每个修复候选

**Step 1: 定向测试**

运行本指纹 owner、相邻边界、Safe Diagnostic、Coordinator、Lifecycle、IPC 测试。

**Step 2: 类型与完整测试**

```powershell
npm run typecheck
npm test
npm run verify:prompt-publication
npm run build
git diff --check
git diff --cached --check
```

Expected: 0 failed、0 unexpected skipped；active Prompt identity 不变；build 通过；staged=0。

**Step 3: 进程卫生**

确认本工作树 Electron/Node 测试残留为 0；不得误杀用户正式安装的软件。

**Step 4: 冻结候选**

在状态文档记录精确文件、测试数量、未运行项和 Live 授权。没有用户提交授权，不 stage/commit/push。

---

### Task 6: 每个候选只运行一次真实 Live

**Files:**
- Use: `tests/e2e/real-provider-interactive-growth.spec.ts`
- Write: sanitized evidence under `notes/evidence/novax-desktop-growth/`
- Modify: current status document

**Step 1: 运行前门禁**

- frozen tests/build 已通过；
- Provider 公开身份匹配；
- encrypted stores/Local State 一致；
- staged=0；
- Electron residue=0。

**Step 2: 单次运行**

```powershell
$env:NODE_USE_ENV_PROXY = "1"
npx --no-install playwright test tests/e2e/real-provider-interactive-growth.spec.ts --workers=1
```

Playwright retry 必须为 0；禁止同候选原样重跑。

**Step 3: 后验取证**

无论成功失败，记录：Cycle/Run/Receipt/Change Set/checkpoint、diagnostics、图片 Job/Asset、side-effect state、JSON parse、SHA-256、leak scan、Electron residue。

**Step 4: 分流**

- 完整成功：进入 Task 8。
- 新独立指纹且允许自动修复：登记后回到 Task 2。
- 聚合错误：回到 Task 2/3，先补诊断。
- 硬停止：进入 Task 9 并请求用户决策。
- 同指纹复发：停止当前指纹，禁止第二次修复猜测。

---

### Task 7: 后续错误的持续处理

每次新指纹在下表追加一行；不设全局轮数上限：

| # | Candidate | Live | Fingerprint | Side effect | Decision | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | planned-Cycle start diagnostics | deterministic | startup/checkpoint characterization | none | instrument | exact pre-Run stage codes added; original additive-Revision hypothesis disproved |
| 2 | bounded Growth Inquiry correction | real failed | worker_schema/STEWARD_GROWTH_INQUIRY_REQUIRED/unbounded | none | repair | bounded to 3 attempts; full freeze passed |
| 3 | Inquiry schema reason classifier | real partial | main_gateway/GROWTH_REVISION_POLICY_ASSERTION_SOURCE_INVALID/none | none | repair | Inquiry passed; pinned document alias bug exposed |
| 4 | pinned assertion-source correction | real partial | lifecycle/GROWTH_AGENT_TERMINAL_PROJECTION_TIMEOUT/creator_choice | none | product decision | Main-authoritative blocked termination implemented; deterministic audit/late-message regression passed; Live pending |
| 5 | bounded Longform correction composition | real partial | growth_phase/STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_GM_RESOLUTION/request_sent | request_sent | repair | persistent Creator-authoring correction preserved across later length corrections; full freeze passed |
| 6 | Closure continuation planner | real partial | coordinator/continue_growing-without-successor/committed | committed prior cycles | repair | missing facets now route to one bounded revision; identical gap fingerprint twice records no-progress stop; full freeze 899/899 |
| 7 | final bounded Longform output | real failed | cycle9/GROWTH_LONGFORM_SECTION_LENGTH_INVALID/none | prior cycles committed, C9 none | stop candidate | accumulated third section missed the length range after 3 corrections; no threshold/retry change and no unchanged rerun |

规则：

- 不重复读取全仓；只读 owner 模块、稳定合同和相邻测试。
- 不重复全量测试；每个冻结候选一次。
- 不重复真实 Live；每个候选一次。
- 图片 item 失败允许文字继续，但 request-sent/outcome-unknown 不自动重发。
- 新错误不是旧修复失败时，自动进入下一指纹。

---

### Task 8: 完整交互 Growth 验收

只有同一次真实 Live 同时证明以下内容，才标记 A1 完成：

- 初始世界/故事/OC 或当前测试规定的正式创作 Cycle committed；
- 用户指导持久化为递增 Rule Revision；
- 下一 Cycle 固定上一 output checkpoint 并重新检索；
- Revision Change Set committed；
- 图谱/文档/右栏显示真实修改；
- Closure 自询和独立 Checker 具有真实终态；
- 必要 Repair 提交后重新检索并复查；
- Longform outline/sections 达到当前确定性门槛；
- 图片成功绑定真实来源，单项失败只留下 false 占位、不回滚文字；
- reopen 后规则、正式对象、诊断和图片状态可读；
- research-only Run 只检索、不修改；
- leak scan 通过；
- 无残留进程。

局部通过不得称为完整 NovelX、Player 或安装包闭环。

---

### Task 9: 状态同步和停止报告

**Files:**
- Modify: `docs/project/current-state-and-routes.md`
- Modify: `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`
- Modify: this plan table/ledger
- Preserve: all evidence unless separately authorized to curate

**Step 1: 同步事实**

区分 deterministic、no-Provider E2E、real Provider Live、partial boundary、full-project incomplete。

**Step 2: 记录恢复入口**

写明唯一 owner、指纹、side effect、已跑测试、未跑场景和下一条最小命令。

**Step 3: Git 边界**

只审查 dirty/staged 状态；没有显式授权不提交、不推送、不清理混合工作树。

---

## 3. 完成定义

本标准计划在以下任一条件成立时完成：

1. Task 8 的同一次真实交互 Live 全部通过；或
2. 当前精确指纹命中 2.4 硬停止条件，并已提供可解析证据与唯一恢复入口。

“出现新错误”本身不构成完成或停止；聚合错误本身也不构成停止。

## 4. 当前执行入口

产品负责人已授权由 Worktree Head 作出决定。当前采用 Main-authoritative 语义：`creator_choice_required` 落盘并完成工具审计后，Supervisor 原子收口开放 invocation/Run 为 blocked，发布一次 blocked Agent terminal，释放 lease 并终止 Worker；用户回答通过新 Cycle/Run 继续。确定性测试已证明迟到消息不重复终态且不会产生 Change Set/图片副作用；下一入口是完整冻结后的一次真实交互 Live。
