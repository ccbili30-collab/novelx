# Bounded Growth Self-Diagnosis and Repair Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

**Goal:** 建立一套面向 Codex 执行的有界自排查与修复循环，使每次真实 Growth Live（真实运行）失败后能够从安全证据定位唯一责任边界，在不改变产品语义的白名单内自动补回归、最小修复、冻结验收并只重跑一次。

**Architecture:** 循环以已经持久化的 Safe Diagnostic Envelope（安全诊断信封）为唯一错误事实，不读取或保存 Prompt、模型正文、工具参数、凭据和原始异常。每个候选先通过确定性门槛，再执行一次 Provider（模型服务）Live；失败后依据 `owner + boundary + code + sideEffectState + fingerprint` 决定自动修复或停止。自动修复只发生在唯一责任模块，产品定义、公开协议、Schema（数据结构）、权限、Canon（正史）和结果未知边界必须返回用户决策。

**Tech Stack:** Windows PowerShell、TypeScript、Vitest、Playwright、Electron、SQLite、现有 Growth Goal/Cycle、Safe Diagnostic Pipeline v1、Git。

---

## 0. 执行原则

本计划是 Codex 的开发执行循环，不是让 NovelX 应用在用户电脑上自行改源码。

一个迭代定义为：

```text
冻结候选 Rn
  → 确定性验收
  → 一次 Live Ln
  → 安全证据分类
  → 允许自动修则进入 Rn+1
  → 不允许则停止并请求产品决策
```

不变量：

1. 一个候选最多一次 Live，不允许原样重跑。
2. 同一失败指纹最多自动修复一次。
3. 每个任务最多三次 `repair → Live`；第三次仍未完成则停止。
4. 每次只修最先阻断的错误，不顺手修后续猜测。
5. Change Set（变更集）执行器、图片请求或其他外部副作用一旦可能已发送，不自动重试。
6. 任何门槛都不能为了通过 Live 而降低。
7. 任何兼容垫片、Mock（模拟）或本地模板都不能冒充 Live。
8. 全量测试只在候选冻结后运行一次。

## 1. 当前迭代账本

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 确定性基线 | [x] | `npm test`：135 files / 858 tests / 0 failed / 0 skipped；typecheck、Prompt gate、build、diff check 通过 |
| L0：Revision 旧引用失败 | [x] | `18-48-26-415Z`：impact/owner/relation endpoint 三次 Fragment 纠正失败 |
| R1：Revision 短引用目录 | [x] | `@resourceN/@documentN/@assertionN/@relationN`；删除重复 `impact.additions` |
| L1：短引用修复后 Live | [x] | `19-12-22-796Z`：C1 committed；C2 到达 Main proposal authorization 后 `GROWTH_BINDING_INVALID` |
| R2：Main Revision Policy 精确错误 | [x] | 十类本地 policy code；136 files / 872 tests；typecheck/build 通过 |
| L2：精确错误后的单次 Live | [x] | `19-47-14-090Z`：C1 committed；C2 编译纠正后被 `GREENFIELD_CREATE_EXPLICIT_FREE_REQUIRED` 误拒绝 |
| R3：根据 L2 的唯一错误最小修复 | [x] | Main 验证后的 Revision 获得同批文档证据内部 authority；105 focused、872 full、typecheck/build 通过 |
| L3：最终单次 Live | [x] | `20-01-50-985Z`：C1/C2 committed；C3 planned 后 `growth.get` bridge 失败，循环按上限终止 |
| 交互 Growth 完整验收 | [ ] | Revision committed → Closure → Longform → illustrations → reopen → research |

当前恢复入口：R3 已冻结。L2 证明第一次关系引用错误被有界纠正；第二次提案通过 Revision Main policy 后，因为同批新文档证据沿用了 Greenfield 占位符而被 Gateway 误判。R3 只向已通过 pinned authority 校验的 Revision 调用传递内部同批证据权限；普通 Free、Renderer、模型和公开协议均未获得该权限。

---

### Task 1: 冻结并审查当前混合工作树

**Files:**
- Read: `docs/project/current-state-and-routes.md`
- Read: `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`
- Read: `src/agent-worker/growth/README.md`
- Read: `src/main/growth/README.md`
- Modify after verification: `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`

**Step 1: 记录只读基线**

Run:

```powershell
git branch --show-current
git rev-parse HEAD
git status --short
git diff --cached --name-only
```

Expected: branch 为 `codex/hackathon-10day`；暂存区为空；所有脏文件可归属到已有 Growth/diagnostics/placeholder 批次。

**Step 2: 验证当前确定性基线**

Run:

```powershell
npm run typecheck
npm test
npm run verify:prompt-publication
npm run build
git diff --check
```

Expected: 135 files / 858 tests / 0 unexpected skips；所有命令成功。

**Step 3: 停止条件**

- 存在未知归属修改。
- staged files 非空。
- typecheck 或全量测试失败且不属于当前候选。
- Electron 测试进程残留。

上述任一成立时不得进入 Live 或自动修复。

**Step 4: 提交规则**

当前 88-entry 混合工作树未经语义拆分前不得自动暂存或提交。先完成 reviewed hunk ownership；禁止用 reset/checkout/clean 伪造干净状态。

---

### Task 2: 为 Main Revision Proposal Policy 建立行为刻画测试

**Files:**
- Modify: `tests/unit/growth-revision-fragment.test.ts`
- Create: `tests/unit/growth-revision-proposal-policy.test.ts`
- Read only: `src/main/growth/phases/revision/growthRevisionProposalPolicy.ts`
- Read only: `src/agent-worker/growth/phases/revision/growthRevisionFragment.ts`

**Step 1: 为每个拒绝谓词写失败用例**

测试必须分别固定：

- duplicate item identity；
- dependency outside proposal；
- impact target outside pinned authority；
- revised/preserved/stale set 冲突；
- forged existing resource/document/assertion/relation identity；
- created resource/document namespace 越界；
- owner/parent/scope/source/endpoint 越界；
- assertion evidence outside pinned documents or same Change Set document outputs；
- forbidden project-file/constraint-profile mutation；
- declared revised set 与实际 mutated set 不一致。

每个测试只破坏一个谓词，并断言一个不同的本地错误码。错误对象不得包含被拒绝 ID、标题、正文或原始参数。

建议代码形状：

```ts
expect(() => assertGrowthRevisionProposalAllowed(input)).toThrowError(
  expect.objectContaining({
    code: "GROWTH_REVISION_POLICY_MUTATION_SET_MISMATCH",
  }),
);
```

**Step 2: 运行红灯**

Run:

```powershell
npx --no-install vitest run --config vitest.config.ts `
  tests/unit/growth-revision-proposal-policy.test.ts `
  tests/unit/growth-revision-fragment.test.ts
```

Expected: 新用例因为当前统一返回 `GROWTH_BINDING_INVALID` 而失败；旧合法编译→Main policy 用例继续通过。

**Step 3: 停止条件**

若无法在不读取模型正文或真实 ID 的情况下区分谓词，先重新设计本地 policy API，不得扩大共享协议。

---

### Task 3: 实现模块本地的 Revision Policy 错误目录

**Files:**
- Create: `src/main/growth/phases/revision/growthRevisionProposalDiagnostics.ts`
- Modify: `src/main/growth/phases/revision/growthRevisionProposalPolicy.ts`
- Modify: `src/main/diagnostics/mainToolDiagnostics.ts`
- Modify: `tests/unit/growth-revision-proposal-policy.test.ts`
- Modify: `tests/unit/main-tool-diagnostics.test.ts`
- Modify: `tests/unit/safe-diagnostic-contract.test.ts`

**Step 1: 定义本地 allowlist**

错误码按责任而不是模型字段命名，例如：

```ts
export const growthRevisionProposalPolicyCodes = [
  "GROWTH_REVISION_POLICY_ITEM_GRAPH_INVALID",
  "GROWTH_REVISION_POLICY_IMPACT_AUTHORITY_INVALID",
  "GROWTH_REVISION_POLICY_IMPACT_SET_CONFLICT",
  "GROWTH_REVISION_POLICY_EXISTING_TARGET_INVALID",
  "GROWTH_REVISION_POLICY_CREATED_ID_INVALID",
  "GROWTH_REVISION_POLICY_OWNER_INVALID",
  "GROWTH_REVISION_POLICY_ASSERTION_SOURCE_INVALID",
  "GROWTH_REVISION_POLICY_RELATION_ENDPOINT_INVALID",
  "GROWTH_REVISION_POLICY_FORBIDDEN_MUTATION",
  "GROWTH_REVISION_POLICY_MUTATION_SET_MISMATCH",
] as const;
```

所有定义应固定为：

- owner: `main_gateway`
- boundary: `tool_authorization`
- side effect: `none`
- disposition: `terminal`
- retryability: `do_not_retry`

不得携带动态 message/details/IDs。

**Step 2: 逐谓词替换统一错误**

`assertGrowthRevisionProposalAllowed` 每个分支抛出唯一 typed code。不得改变任何布尔条件、授权范围、Change Set 结构或提交行为。

**Step 3: Main 安全持久化**

`mainToolDiagnostics.ts` 只接受上述 allowlist，并映射固定本地摘要；未知 code 继续回落为现有安全概括码，不回显异常文本。

**Step 4: 运行绿灯**

Run:

```powershell
npx --no-install vitest run --config vitest.config.ts `
  tests/unit/growth-revision-proposal-policy.test.ts `
  tests/unit/growth-revision-fragment.test.ts `
  tests/unit/main-tool-diagnostics.test.ts `
  tests/unit/safe-diagnostic-contract.test.ts
```

Expected: 每个谓词唯一错误码；合法 proposal 继续通过；敏感值不存在于诊断 JSON。

---

### Task 4: 防止 Worker 编译器与 Main Policy 再次漂移

**Files:**
- Modify: `tests/unit/growth-revision-fragment.test.ts`
- Modify: `tests/unit/growth-revision-proposal-policy.test.ts`
- Optional create only if duplication remains: `tests/fixtures/growthRevisionProposalFixture.ts`

**Step 1: 建立端到端确定性契约**

对每个合法 Fragment：

```text
Fragment schema accepts
→ compiler succeeds
→ ProposeChangeSetArgs schema accepts
→ Main Revision Policy accepts
```

覆盖：

- 只更新现有文档；
- 新增资源和文档；
- 新增 Assertion（断言）并引用同 Change Set 文档；
- 删除已有 relation；
- 新增跨 world/story/oc 的合法 relation；
- preserve/stale/revise 组合。

**Step 2: 反向越权测试**

Main Policy 必须拒绝手工伪造的低层 proposal，即使它没有经过 Fragment compiler。

**Step 3: 影响半径检查**

本任务不得修改：

- `src/shared/agentWorkerProtocol.ts`
- 数据库 migration；
- Renderer；
- Domain relation policy；
- Prompt。

若必须修改上述文件，停止并请求架构决策。

---

### Task 5: 冻结候选 R2

**Files:**
- Modify: `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`
- Modify if route changed: `src/main/growth/README.md`

**Step 1: 定向测试**

Run:

```powershell
npx --no-install vitest run --config vitest.config.ts `
  tests/unit/growth-revision-proposal-policy.test.ts `
  tests/unit/growth-revision-fragment.test.ts `
  tests/unit/growth-revision-authority.test.ts `
  tests/unit/main-tool-diagnostics.test.ts `
  tests/unit/safe-diagnostic-contract.test.ts `
  tests/unit/growth-run-bridge.test.ts
```

**Step 2: 全量冻结门槛**

Run once:

```powershell
npm run typecheck
npm run verify:prompt-publication
npm test
npm run build
git diff --check
```

Expected: 0 failed / 0 unexpected skips；active Prompt identity 不变；Electron residue 0。

**Step 3: 记录候选指纹**

记录：HEAD、dirty file ownership、测试总数、未提交状态、允许的一次 Live 命令。不得预先声称 R2 修复了真实失败。

---

### Task 6: 执行一次真实 Live L2

**Files:**
- Execute only: `tests/e2e/real-provider-interactive-growth.spec.ts`
- Create by harness: `notes/evidence/novax-desktop-growth/growth-guidance-live-*.json`
- Modify after inspection: `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`

**Step 1: 预检**

- 确认无 worktree Electron 残留。
- 确认文本和图片 Provider 的公开 identity 与 E2E 要求一致。
- 不读取、解密或输出凭据。
- Playwright retries 必须为 0，workers 必须为 1。

**Step 2: 运行一次**

```powershell
$env:NODE_USE_ENV_PROXY='1'
npx --no-install playwright test `
  tests/e2e/real-provider-interactive-growth.spec.ts `
  --workers=1
```

**Step 3: 只读取安全证据**

验证：

- PowerShell UTF-8 `ConvertFrom-Json`；
- Node `JSON.parse`；
- harness `leakScan=passed`；
- SHA-256；
- Electron residue 0；
- Cycle/Run/Receipt/Change Set/checkpoint 真实计数；
- 最先出现的非 rollup diagnostic。

**Step 4: 禁止行为**

- 不原样重跑。
- 不从 trace 提取 Prompt、工具参数或正文。
- 不根据 `GROWTH_COORDINATOR_TERMINAL_NOT_COMPLETED` 聚合断言猜根因。
- 不在 Live 后立即顺手改代码；先完成 Task 7 分类。

---

### Task 7: 自动分类与修复许可判定

**Files:**
- Read: L2 safe evidence
- Modify: `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`
- Optional after repeated manual use: create `scripts/inspect-growth-safe-evidence.mjs`

**Step 1: 形成失败指纹**

```text
fingerprint = cycleSequence / owner / boundary / code / sideEffectState
```

rollup code（例如 `GROWTH_CHANGE_SET_NOT_COMMITTED`）不能覆盖更早的根诊断。

**Step 2: 自动修复白名单**

可以继续 Task 8：

- `sideEffectState=none`；
- code 唯一定位到一个模块；
- 修复不改变产品语义、公开协议、Schema、权限和数据兼容；
- 能先写确定性失败测试；
- 当前指纹尚未修过。

**Step 3: 自动停止清单**

必须停止并报告：

- `request_sent`、`committed` 或 `outcome_unknown`；
- Provider auth/rate-limit/quota/model unavailable；
- 数据迁移、公开协议、Canon、Lens 或权限变化；
- 有两个产品结果明显不同的修法；
- code 仍是聚合码，无法定位唯一谓词；
- 同一指纹已经修复过一次；
- 需要降低现有门槛；
- 第三个候选仍未完成。

---

### Task 8: 执行一次白名单内最小修复 R3

**Files:**
- 只允许 Task 7 定位到的 owner 模块、其直接测试和状态文档。
- 禁止顺手修改其他失败边界。

**Step 1: 写失败回归**

测试名直接表达产品不变量，例如：

```text
compiled revision proposal with pinned aliases passes Main authorization
revision policy rejects a forged document owner without exposing its identity
```

**Step 2: 验证红灯**

只运行最小测试文件，确认错误指纹一致。

**Step 3: 最小实现**

只消除 Worker/Main 对同一已确认规则的漂移；不得放宽 authority、scope、checkpoint、relation 或 transaction 门禁。

**Step 4: 绿灯和冻结**

依次运行定向测试、typecheck、全量测试、Prompt gate、build、diff check。

**Step 5: L3**

仅在全部冻结门槛通过后执行最后一次 Live。L3 后无论成功或失败，本计划循环终止，不自动进入第四轮。

---

### Task 9: 成功路径验收

L2 或 L3 只有同时满足下列条件才算交互 Growth Live 通过：

- 初始 Cycle 提交世界/故事/OC 或当前测试要求的正式对象；
- 用户指导形成递增 Rule Revision；
- 下一 Cycle 固定新规则和上一 output checkpoint；
- 重新检索并产生 Receipt；
- Revision Change Set committed；
- Closure 自检与独立 Checker 有真实终态；
- 必要 Repair 形成新 Change Set，并重新检索；
- Longform outline/sections 达到当前确定性门槛；
- 图片失败不回滚文字，图片成功绑定真实来源；
- reopen 后规则、正式对象、图片和诊断可读取；
- research-only Run 只检索、不修改；
- leak scan 通过；
- 无 Electron 残留。

任何局部成功不得称为完整 NovelX 或 Player 闭环。

---

### Task 10: 证据整理、状态同步与提交审查

**Files:**
- Modify: `docs/project/current-state-and-routes.md`
- Modify: `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`
- Modify: this plan checkbox table
- Preserve: five pre-existing Player failure evidence files

**Step 1: 证据索引**

只保留具有决策价值的最高成功边界和不同根因失败证据。未经授权不删除历史 evidence。

**Step 2: 修正文档事实**

文档必须区分：

- deterministic tests；
- no-Provider E2E；
- real Provider Live；
- partial/failed boundary；
- full project incomplete items。

**Step 3: 语义拆分暂存**

当前混合工作树只能在 reviewed ownership 后按语义拆分。每个 staged batch 执行：

```powershell
git diff --cached --name-only
git diff --cached --stat
git diff --cached --check
```

没有明确提交授权时不得 commit/push。

---

## 2. 每轮可视进度模板

后续对话只更新这张表，避免重复长报告：

| 阶段 | 状态 | 最近证据 | 下一动作 |
| --- | --- | --- | --- |
| 基线冻结 | ✅/🔄/⛔ | tests/build/HEAD | — |
| 候选 Rn | ✅/🔄/⛔ | 修改模块 | freeze |
| Live Ln | ✅/❌/未运行 | evidence + SHA | classify |
| 根诊断 | code | owner/boundary/effect | repair/stop |
| 修复许可 | auto/user/stop | 规则依据 | 下一 Task |
| 总循环 | n/3 | fingerprint history | continue/terminal |

状态含义：

- ✅：有当前候选证据。
- 🔄：正在执行，不代表成功。
- ❌：已完成但验收失败。
- ⛔：按安全或产品边界停止。
- 未运行：不能用历史结果替代。

---

## 3. 完成定义

本计划完成不是“所有错误都能自动修”，而是证明：

1. 每个可信边界的错误能定位到唯一模块或明确声明信息不足。
2. 白名单内错误可以由 Codex 自动完成红灯、最小修复和冻结验收。
3. 有外部副作用、产品歧义或架构变化时能够自动停止。
4. 不原样重跑、不降低规则、不泄露原始内容。
5. 三次候选上限能够终止循环。
6. 成功 Live 或最终阻塞均有可解析、可哈希、可恢复的仓库证据。

## 4. 当前停止点

Task 1–10 已完成，自动循环终止。R3 真实消除了 L2 的 Revision/Greenfield 误判：L3 的 Cycle 2 已 committed，并产生第二个 Change Set/checkpoint。随后 Cycle 3 持久化为 planned，但在 Run 绑定前 `growth.get` 以公开聚合错误 `Growth Run bridge failed` 终止；本次没有安全诊断，不能继续定位唯一谓词。按三候选上限，不生成 R4、不原样重跑。最终 evidence 为 `growth-guidance-live-2026-07-16T20-01-50-985Z.json`，SHA-256 `69173911C171120B2628334E50A6326D55ADD60BEBFF4F8CD5F1AEA98B8987C2`，`leakScan=passed`。
