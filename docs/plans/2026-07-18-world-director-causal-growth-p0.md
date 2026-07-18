# World Director Causal Growth P0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task.

> **当前状态（2026-07-18）：** 计划已展开，产品决策已确认，实施任务 `4 / 32`。Phase A–B 已冻结；Task 4 的严格内部编辑合同通过定向测试和类型检查，但尚未接入运行链。当前执行入口为 Phase C / Task 5：添加纯加法 SQLite v28。任何任务只有在代码、测试和规定证据均满足后才可由 `[ ]` 改为 `[x]`。

这份计划回答三个问题：为什么 NovelX 不能继续依赖一个模型包办所有工作；为什么“因果关系”必须成为图谱和调度的核心；最终用户、评委和后续编码 Agent 分别会得到什么。代码优化的首要目标不是方便人类阅读，而是降低 AI 修改所需上下文、缩小变更影响半径并让每个失败直接定位到唯一责任模块。

> **AI 续接阅读规则：** 新会话不应每次重读本文件全部 900 余行。先读顶部状态、Section 17 的任务索引和当前 Task 对应的小节；只有涉及架构边界时再读 Sections A–C。完成任务后只更新对应 checkbox、证据和下一任务入口。

**Goal:** Build a hackathon-scoped World Director（世界总编）that delegates source-bound creative work to a fixed roster of specialist Agents, persists assignment/review ownership, grows a versioned causal world graph, serializes Canon writes, and incrementally queues source-bound illustrations while text Growth continues.

**Architecture:** Keep Steward（大管家）as the operational Harness and make World Director the user-facing editorial authority only inside Growth mode. The Director, specialists, Graph Curator（图谱书记官）and Checker are tool-light model invocations that return strict candidates; Main owns retrieval, scheduling, persistence, recovery and Change Set（变更集）submission. Read-only candidate work may run concurrently from a pinned checkpoint, but every accepted mutation is rebased, checked and committed through one serialized Change Set lane.

**Tech Stack:** Electron, React, TypeScript, Zod, TypeBox, SQLite, Pi/OpenAI-compatible Provider adapters, Vitest, Playwright.

---

## A. Why This Product Must Be Built This Way

### A.1 The problem is not “generate more text”

The current proven Growth path can generate a world, a story, OCs and a map, but a large world package becomes thin when one model must simultaneously:

- understand the entire world;
- decide what is missing;
- retrieve evidence;
- invent details;
- maintain cross-node consistency;
- call tools correctly;
- construct Change Sets;
- extract image briefs;
- review its own result.

The predictable failure is not only weaker prose. The model spends reasoning capacity on protocol work, loses causal context, creates isolated setting lists and produces shallow nodes. Therefore the P0 goal is to separate editorial judgment, specialist creation, graph extraction, factual checking and operational tool work while retaining one editorial authority.

### A.2 The world must grow through causes, not through unrelated setting cards

The graph is not an ornamental relationship view. It is the memory and reasoning substrate for development:

```text
mountain enclosure
  -> expensive transport
  -> weak external trade
  -> slow diffusion of tools
  -> local guild monopoly
  -> conservative succession politics

childhood poverty
  -> repeated status humiliation
  -> fear of being exposed as inferior
  -> over-preparation and avoidance
  -> conflict with a privileged companion
  -> a later betrayal decision
```

This is necessary because the same cause must remain discoverable when another Agent writes a nation, an OC, a historical event or a story chapter. If causes live only inside prose, later models must reread large documents and will still miss contradictions. If causes are versioned, sourced graph facts, the Director can retrieve a bounded causal neighborhood in seconds and delegate work with the relevant mechanism already attached.

Correlation must not be silently promoted to causation. Every accepted causal edge therefore answers:

- What changed because of what?
- Through which mechanism?
- Under which conditions?
- During which period?
- Which document/assertion supports it?
- Is it confirmed, disputed, inferred or intentionally unknown?

### A.3 One World Director is required

Specialist Agents should not independently decide the whole product direction. World Director exists to:

- read the current graph, rules, closure gaps and latest committed results;
- choose the next highest-value growth frontier;
- assign bounded Work Orders to fixed employee profiles;
- compare results against the world-wide causal structure;
- return weak work to the original employee profile;
- decide which accepted candidate enters the serialized commit lane;
- discuss creator choices with the user.

It does not write the final prose and does not execute project tools. This prevents editorial judgment from being diluted by schema construction and tool recovery.

### A.4 Steward, Checker and Graph Curator remain separate

- Steward owns operational execution: tool calls, Provider calls, persistence, cancellation, recovery and image queues.
- Checker independently identifies contradictions, unsupported claims and unmet acceptance facets. It does not replace the creative author.
- Graph Curator extracts sourced facts and causal candidates from a specialist result. It does not decide Canon and does not invent missing prose.
- Domain code validates types, endpoints, sources, versions and atomicity before any formal write.

This separation is intentional. World Director asks “is this the right world development?”, Checker asks “is this supported and self-consistent?”, Graph Curator asks “what formal facts and causes are present?”, and Steward asks “how is the authorized work executed safely?”.

### A.5 Long generation time must be reduced without sacrificing dependency order

Independent candidate generation may run concurrently from one pinned checkpoint, for example two unrelated countries or a culture and a mountain system. Dependent work must wait: an OC whose identity is caused by a country cannot be finalized before that country is accepted. Canon writes remain serialized so later work can rebase and retrieve the exact new checkpoint.

Images are asynchronous followers of committed text. When a nation, character, scene or map target becomes stable, the text pipeline summarizes a source-bound visual brief and enqueues it. Text Growth continues immediately. The total user wait approaches `max(text time, image queue time)` rather than `text time + every image time`.

## B. What the Finished Product Must Look Like

### B.1 User experience

The user enters Growth mode with any seed: a sentence, an OC, a story, a novel or an existing world. The central conversation is with World Director. The user can add a rule or correction at any Cycle boundary, see an immediate safe acknowledgement, and observe the next editorial round retrieve the new checkpoint and apply the new rule.

The center timeline shows concise expandable activity such as:

- “正在检查世界尺度与因果空白”;
- “已将北方文明与南部海权国家分配给两名设定作者”;
- “正在核验：寒流变化如何影响贸易、宗教与战争”;
- “角色作者正在依据贫民区与继承制度创建主要 OC”;
- “Checker 要求补足该政变与王位合法性的证据”;
- “国家设定已提交；场景图已进入队列”.

It never displays raw chain-of-thought, Prompt text, credentials or tool arguments.

The right pane shows the authoritative object currently being created or revised: world document, nation dossier, character dossier, story section, causal graph neighborhood or image queue item. Stable content can appear with a staged animation, but UI animation may not claim a commit before Main reports it.

### B.2 Final world package

The latest exported package is overwritten atomically in `artifacts/latest-growth-world-package`. It contains a readable presentation and machine-traceable provenance:

```text
latest-growth-world-package/
  README.md                         package overview and generation boundary
  world/
    world-overview.md               cosmos/planet/continent-scale structure
    geography-and-astronomy.md      astronomy, climate, hydrology, terrain, resources
    history.md                      eras, turning points, wars and regime changes
    systems.md                      magic/technology/faith/economy/institutions
  regions/                          multiple macro regions
  polities/                         detailed nations/civilization groups
  organizations/                   factions, institutions and power networks
  cultures-and-species/             biological/cultural/history dossiers
  characters/                       deep OC dossiers and personal causal histories
  stories/                          cross-region main story and long-form character stories
  graph/
    causal-graph.json               versioned causal nodes/edges and provenance
    causal-graph.md                 human-readable causal chains and unresolved gaps
  images/
    maps/                           world -> region -> nation/city maps
    scenes/                         nation, geography and story atmosphere
    characters/                     OC illustrations/cards
    details/                        user-requested node-level illustrations
    manifest.json                   source version, status, provider and actualContent
  evidence/
    package-manifest.json           checkpoints, Change Sets and source identities
```

Default output is large-world scale rather than one small harbor: world/cosmos origin, multiple macro regions and polities, physical geography, historical eras, interacting systems, a story spanning regions and OCs rooted in different societies/classes/events.

### B.3 Node depth

Core and major nodes must reach a maturity profile instead of receiving one short paragraph:

- World: origin, astronomy, geography, eras, global systems, civilizations, unresolved tensions and cross-system causes.
- Nation/civilization: territory, population, institutions, economy, class, culture, faith, technology/magic, military, diplomacy, history, internal conflicts, resources, daily life, symbols and causal dependencies.
- Organization: purpose, legitimacy, hierarchy, recruitment, resources, operations, factions, allies/enemies, public image, secrets, history and failure pressure.
- Geography: formation, terrain, climate, hydrology, ecology, resources, hazards, settlement, transport, strategic meaning, cultural meaning and historical effects.
- Species/culture: origin, biology, lifecycle, diversity, environment, subsistence, family, law, faith, language, aesthetics, conflict, history and relations.
- OC: identity, origin, family/class, formative events, abilities/limits, desires/fears, contradiction, worldview, habits, relationships, secrets, arc, world impact and personal causal history.
- Story: historical preconditions, inciting cause, actors with prior histories, regional movement, escalating consequences, reversals, resolution pressure and changes fed back into the world.

These are coverage requirements, not rigid prose forms. Supporting/background nodes may be shallower until promoted by the user or Director.

### B.4 Visual result

By default the package contains a world map, regional/national/city detail maps as needed, nation/civilization atmosphere art, story backgrounds, character illustrations/cards and selected details. Any text node may request one or more images. Generation failure leaves an explicit false placeholder with `actualContent=false`; it never pretends that an image exists and never blocks text Growth.

The default visual language is colored expressive pen-and-ink drawing with angular/broken contours, cross-hatching, hand-drawn texture and restrained watercolor/gouache color. It avoids photorealism, cinematic 3D rendering, generic glossy game posters, monochrome-only manga and stereotypical cute/moe anime unless the user explicitly requests them.

## C. AI-Maintainability Is a Product Acceptance Requirement

The code is not optimized for human aesthetic preference. It is optimized so a future coding Agent can safely understand and modify one capability without reconstructing the entire repository or damaging proven Live paths.

### C.1 Required module shape

```text
src/domain/growth/editorial/
  contracts/                       private editorial types
  repository/                      Work Order persistence and replay
  causal/                          one authority for causal policy/persistence
  closure/                         maturity and completion profiles

src/main/growth/editorial/
  director/                        packet, runtime adapter and review compiler
  scheduler/                       dependency DAG and serialized commit lane
  specialists/                     fixed capability registry and invocation adapter
  graph-curator/                   extraction packet and candidate compiler
  illustration/                    post-commit asynchronous visual planning

src/agent-worker/growth/phases/
  <phase>/                          model-visible schema and local phase behavior only
```

The exact folder names may change after code inspection, but responsibility boundaries may not collapse back into `growthRunLifecycle.ts`, `stewardExecutionStateMachine.ts` or `agentWorkerProtocol.ts`.

### C.2 Context locality rules

- A specialist capability change should require reading its module README, stable internal interface and focused tests, not the whole Growth runtime.
- Each capability directory must include a short routing README: responsibility, non-responsibility, authoritative inputs/outputs, invariants, allowed neighbors, focused test command and frozen debt.
- A file approaching 800 lines triggers review; a file over 1000 lines or mixing multiple capabilities blocks further feature additions until responsibility is extracted.
- No new phase-specific `if binding.kind ...` branch may be added to the top-level Steward state machine when a registered phase handler can own it.
- No Domain rule may be independently restated in a Prompt, compiler, repository and test fixture. Code-owned policy is authoritative; model instructions describe it but cannot implement it.
- Shared IPC/worker contracts contain only data that genuinely crosses the boundary. Phase-private authority remains in a versioned internal binding or local module.
- Fixtures use valid Domain objects and minimal dependencies. A fixture setup failure must not mask the behavior being tested.

### C.3 Locality of change gates

For every feature task, record its touched files. The implementation fails review if a normal specialist/phase change requires unrelated edits across state machine, lifecycle, shared protocol, Gateway, Coordinator and Renderer.

Target impact radii:

- Add a specialist role: registry + prompt asset + specialist tests; no scheduler rewrite.
- Add a causal relation kind: causal policy + migration/Domain tests + projection mapping; no Prompt-specific validation fork.
- Change OC depth: OC maturity profile + OC author contract/tests; no world-map code.
- Change default image style: one visual style policy + purpose adapters/tests; no text phase changes.
- Add a test-only phase: phase module + registry/test; no edit to the top-level state-machine body.

### C.4 Stable interfaces

The implementation must converge on small interfaces equivalent to:

```ts
interface GrowthPhaseHandler<State, Input, Candidate> {
  readonly id: GrowthPhaseId;
  createInitialState(input: Input): State;
  allowedNextTools(state: State): readonly GrowthToolKind[];
  acceptToolOutcome(state: State, outcome: GrowthToolOutcome): PhaseTransition<State>;
  compileCandidate(state: State): Candidate | PhaseBlocked;
}

interface EditorialCapability {
  readonly id: EditorialCapabilityId;
  readonly promptIdentity: PromptIdentity;
  readonly inputSchema: Schema;
  readonly outputSchema: Schema;
  buildPacket(authority: SpecialistAuthority): SpecialistPacket;
}
```

These are design contracts, not permission to prematurely create generic abstraction layers. They are accepted only when at least two real consumers eliminate duplicated branching.

### C.5 AI-oriented verification

In addition to behavior tests, the frozen candidate must prove:

- changing the Longform module does not require reading or changing world-map implementation;
- adding a test capability does not modify the top-level state-machine body;
- every causal validation failure maps to the causal Domain module;
- every Work Order state failure maps to the editorial repository/scheduler;
- a new Agent can route from `CONTEXT.md` to the responsible module without reading historical chat or all ADRs;
- current-state documentation names the highest Live evidence and exact recovery entry point.

---

## 0. Product Decisions Already Approved

- [x] Growth-mode user conversation is with World Director; Steward remains the operational shell.
- [x] World Director plans, delegates and performs editorial review; it does not write prose or call project tools.
- [x] Fixed hackathon employee roster is acceptable; arbitrary dynamic roles are post-hackathon work.
- [x] The original employee profile owns revisions of its own Work Order（创作工单）.
- [x] Independent candidates may be generated concurrently; dependent work waits for predecessor results.
- [x] Formal Canon/Domain writes remain serialized and atomic.
- [x] Graph Curator proposes graph structure; deterministic Domain code validates and persists it.
- [x] The graph's primary purpose is causal development, not generic co-occurrence.
- [x] Stable world facts and development causality enter the graph; purely literary phrasing remains in documents.
- [x] A causal edge records direction, mechanism, conditions, temporal scope, provenance and epistemic status.
- [x] Additive hackathon SQLite migration for editorial Work Orders is authorized.
- [x] Runtime V2 A2.2, Canon authority, permissions and Player Lens remain unchanged.
- [x] Text nodes enqueue images only after a stable Change Set commit; image work never blocks text Growth.
- [x] Default visual style is colored expressive pen-and-ink fantasy illustration, not photorealism, 3D rendering, monochrome manga or moe/chibi anime.
- [x] The next text Live run must publicly identify model `5.6luna` before any Provider side effect.

## 1. Completion Definition

This plan is complete only when all of the following are proven on the same frozen candidate:

- [ ] A user starts one Growth Goal and communicates with World Director.
- [ ] Director reads a pinned graph/editorial packet and persists a bounded Editorial Round.
- [ ] Director assigns fixed specialist profiles with explicit dependencies and acceptance facets.
- [ ] At least two independent specialist candidates execute concurrently without concurrent Canon writes.
- [ ] A dependent Work Order waits for its predecessor's committed output.
- [ ] Each candidate receives Graph Curator extraction, deterministic causal validation, Checker review and Director review.
- [ ] A rejected candidate returns to the same owner profile and records a new attempt rather than creating an unrelated task.
- [ ] Accepted text, assertions and causal relations commit atomically through one Change Set.
- [ ] The next task retrieves from the new checkpoint and can follow a causal path created by the prior task.
- [ ] World package reaches the approved large-world hierarchy and per-node content closure.
- [ ] Every committed visual target incrementally creates an illustration queue item while text work continues.
- [ ] Image failure leaves `actualContent=false` and does not fail text closure.
- [ ] Renderer shows safe editorial summaries, Work Order progress, graph growth and image queue state without exposing raw thought, Prompt, credentials or tool arguments.
- [ ] Restart recovers Director rounds, Work Orders, attempts, reviews, causal graph and illustration queue without duplicate Provider calls or Change Sets.
- [ ] Full tests, typecheck, build and packaging gates pass.
- [ ] One real dual-Provider interactive Live uses text `5.6luna`, produces a causal large-world package, exports it to the fixed latest package folder and survives reopen/research retrieval.

## 2. Non-Goals and Stop Conditions

### Non-goals

- Dynamic creation of arbitrary new Agent professions.
- Replacing frozen Runtime V2 Assignment or merging hackathon state into A2.2.
- Multi-writer Canon commits or automatic semantic merge.
- Player Lens causal disclosure.
- Treating model confidence, vector similarity or unsourced inference as Canon.
- Displaying private chain-of-thought.
- Requiring all images to finish before text becomes usable.

### Stop conditions

Stop and return for a product decision if implementation requires:

- destructive or non-additive migration of existing world data;
- changing Creator/Player Lens semantics;
- allowing Director or specialists to bypass Change Set/Domain policy;
- accepting an inferred causal edge without a source and explicit epistemic state;
- retrying a Change Set after an unknown side-effect outcome;
- making Free mode bypass hard Domain or permission checks;
- widening Runtime V2 A2.2 contracts;
- silently lowering the approved world, OC, story or causal closure requirements.

## 3. Fixed Hackathon Employee Roster

| Capability ID | Role | Primary output | Tools |
| --- | --- | --- | --- |
| `world_director` | World Director | Editorial plan/review | structured submit only |
| `world_system_author` | World systems | cosmology, world causes, global rules | structured submit only |
| `geography_ecology_author` | Geography/ecology | terrain, climate, hydrology, resources | structured submit only |
| `civilization_author` | Nation/civilization | state, society, economy, history | structured submit only |
| `organization_author` | Organization/faction | hierarchy, incentives, operations | structured submit only |
| `species_culture_author` | Species/culture | biology, diversity, culture, history | structured submit only |
| `character_author` | OC author | character dossier and personal causal history | structured submit only |
| `story_architect` | Story architecture | cross-region story structure and arcs | structured submit only |
| `writer` | Prose Writer | approved long-form prose | existing structured submit only |
| `general_setting_author` | Tactical fallback | magic, technology, language, items and unusual setting types | structured submit only |
| `graph_curator` | Graph Curator | sourced assertions and causal candidates | structured submit only |
| `visual_director` | Visual Director | source-bound image briefs | structured submit only |
| `checker` | Checker | source-bound findings; no rewrite | existing structured submit only |
| `gm` | Player GM | player adjudication | existing independent runtime |
| `decomposer` | Source decomposer | extracted source candidates | existing independent runtime |

The registry is code-owned and versioned. Director may select a capability and write a bounded objective, but may not supply Prompt text, Provider credentials, arbitrary tools or a new capability ID.

## 4. Target Runtime Flow

```text
User guidance
  -> World Director packet (pinned checkpoint + rules + closure + causal frontier)
  -> Editorial Round + dependency DAG
  -> ready Work Orders dispatched to fixed specialist profiles
  -> candidate Artifact only (zero Domain side effect)
  -> Graph Curator: assertions + causal candidates + source spans
  -> deterministic graph/domain validation
  -> Checker factual/continuity review
  -> World Director editorial review
       -> revise: same Work Order owner, next attempt
       -> accept: enter serialized commit queue
  -> rebase/retrieve latest checkpoint
  -> one atomic Change Set containing text + assertions + causal relations
  -> new checkpoint
  -> incremental Visual Brief + persisted image queue item
  -> Director receives graph/diff summary and schedules next frontier
```

## 5. Phase A — Freeze the Existing Dirty Baseline

### Task 1: Inventory and ownership freeze

**Files:**
- Inspect: `git status --short`
- Inspect: `docs/project/current-state-and-routes.md`
- Inspect: `notes/status/2026-07-17-safe-diagnostic-pipeline-v1.md`
- Modify only after review: existing task-owned status/plan files

**Steps:**

- [x] Record current branch, HEAD, staged state and exact modified/untracked paths.
- [x] Confirm no other live Agent owns overlapping files.
- [x] Classify current changes into diagnostic, Guidance/Revision, Closure continuation, Longform, placeholder, exporter, Renderer, E2E/evidence and uncertain batches.
- [x] Remove no file whose ownership or evidence value is uncertain.
- [x] Update the current-state route with the highest valid Live evidence and explicit incomplete boundary.

**Task 1 evidence (2026-07-18):** `codex/hackathon-10day` @ `60b097ed9a94be938837ab55008292b8b1372d99`; staged 0; 81 tracked modifications + 106 untracked paths before the Task 1 status note was added. Status snapshot SHA-256 `C1E0B6792E8E42F2C5F0E885F06CF240788C3CCC2246B3CE92B42C9C8B5686EC`. `git diff --check` passed; 75/75 retained Growth JSON files parsed as strict UTF-8 JSON; plaintext credential marker scan found 0; no overlapping Agent or worktree-bound execution process was observed. Live remains incomplete after the latest `gpt-5.4` + `gpt-image-2` run, and post-run Closure repair has deterministic evidence only.

**Acceptance:** `git diff --check`; all retained JSON evidence parses as UTF-8 JSON and contains no plaintext credential marker.

**Stop:** Any file is actively edited by another execution session.

### Task 2: Restore a green pre-feature baseline

**Files:** current dirty batch only; no World Director code yet.

**Steps:**

- [x] Run the existing focused suites routed by `src/agent-worker/growth/README.md` and `src/main/growth/README.md`.
- [x] Run `npm run typecheck`.
- [x] Fix only already-authorized regressions without changing product semantics.
- [x] Run `npm test` after focused tests pass; after the single discovered stale expectation was fixed, rerun the frozen suite once for final evidence.
- [x] Run `npm run build`.
- [x] Check Electron residue and terminate only processes launched from this worktree.
- [x] Review and semantically commit the existing batch before starting schema v28.

**Task 2 evidence (2026-07-18):** 18 unique focused files / 190 tests passed; final full freeze 141 files / 915 tests passed with zero skips; typecheck, three Agent Prompt gates, Decomposer/GM Prompt gates, production build and diff checks passed; worktree-bound process residue was zero. One stale Safe Diagnostic catalog expectation was corrected without changing production behavior. Code freeze commit: `ce8378e9deb9ad86dbbacc6eefe1bd2afbb8e4d5`. No Provider was run.

**Acceptance:** zero failed/skipped required tests; typecheck/build pass; clean worktree at a reviewed commit.

**Stop:** Any failure reveals a product/Domain semantic contradiction rather than a local regression.

## 6. Phase B — Architecture Records and Executable Contracts

### Task 3: Record World Director architecture

**Files:**
- Create: `docs/adr/2026-07-18-hackathon-world-director-work-orders.md`
- Modify: `docs/product/novelx-desktop-product-requirements.md`
- Modify: `docs/project/current-state-and-routes.md`

**Steps:**

- [x] Write the role boundary: Director editorial, Steward operational, Checker factual, Graph Curator structural.
- [x] Record fixed roster and post-hackathon migration debt.
- [x] Record candidate concurrency versus serialized Canon commits.
- [x] Record same-owner revision semantics.
- [x] Record failure, cancellation, outcome-unknown and recovery behavior.
- [x] State that the ADR is design evidence, not implementation completion.

**Task 3 evidence (2026-07-18):** `docs/adr/2026-07-18-hackathon-world-director-work-orders.md` records requirements, authority, fixed capabilities, Work Order ownership, dependency/concurrency semantics, serialized Change Sets, failure/recovery behavior, trade-offs and rejected alternatives. The PRD resolves World Director as a Growth-only editorial facade under Steward rather than a product-wide authority replacement. No runtime code, schema, Provider or Live state changed.

**Acceptance:** documentation diff matches this plan and does not claim Live.

### Task 4: Define internal editorial contracts

**Files:**
- Create: `src/shared/growthEditorialContract.ts`
- Create: `tests/unit/growth-editorial-contract.test.ts`

**Required contracts:**

- [x] `AgentCapabilityId` fixed registry identifiers.
- [x] `EditorialRoundPlan`: 1–20 Work Orders, canonical dependency ordering, no cycle.
- [x] `WorkOrderDefinition`: objective, source checkpoint, scope refs, capability, acceptance facets, dependencies.
- [x] `SpecialistCandidate`: content Artifact refs, evidence refs, declared coverage and `needs_more_evidence` alternative.
- [x] `GraphCuratorCandidate`: assertions, causal links and exact source locators.
- [x] `CheckerReview`: passed/findings/blocked with cited evidence.
- [x] `DirectorReview`: accept/revise/ask_user with bounded editorial reasons.
- [x] Strict rejection of Prompt, API key, Provider URL, tool list, raw DB IDs supplied by model-facing fields.

**Task 4 evidence (2026-07-18):** `growth-editorial-contract.test.ts` passed 7/7 with zero skips; typecheck and diff check passed. Zod owns cross-field DAG/checkpoint/source semantics; TypeBox owns strict model-tool structure and unknown-field rejection. No schema, runtime, Provider or UI was changed.

**Test command:**

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/growth-editorial-contract.test.ts
```

## 7. Phase C — Additive Persistence and Recovery

### Task 5: Add SQLite schema v28

**Files:**
- Modify: `src/domain/workspace/workspaceRepository.ts`
- Modify: `tests/unit/workspace-persistence.test.ts`
- Create: `docs/adr/2026-07-18-hackathon-editorial-schema-v28.md`

**Additive tables:**

- [x] `growth_editorial_rounds`
- [x] `growth_work_orders`
- [x] `growth_work_order_dependencies`
- [x] `growth_work_order_attempts`
- [x] `growth_editorial_reviews`
- [x] `growth_work_order_artifacts`

**Invariants:**

- [x] One active Editorial Round per Goal.
- [x] One active attempt per Work Order.
- [x] Dependency edges are same Goal/Round and acyclic.
- [x] Attempt pins checkpoint, rule revision, capability profile, Prompt version/hash and model identity.
- [x] Candidate Artifact uses content-addressed storage; DB stores reference/hash, not raw Prompt or credentials.
- [x] Accepted Work Order cannot be edited; revision creates a new attempt.
- [x] Unknown commit outcome enters `reconciliation_required` and blocks successors.
- [x] v27 data remains byte/row equivalent after v28 migration.

**Task 5 evidence (2026-07-18):** SQLite v28 is a six-table additive migration with one-open-Round and one-active-attempt partial indexes, composite ownership/checkpoint/rule constraints, strict decreasing dependency ordinals, immutable Work Order definitions, a reconciliation readiness barrier and content-addressed Artifact references. The migration runs in one `BEGIN IMMEDIATE` transaction and rolls back completely on collision. The persistence suite passed 14/14 with zero skips, including type+byte snapshots of all stable v27 tables before/after migration and reopen; the pre-existing `retrieval_index_capability.checked_at` open-time probe is explicitly excluded and documented because it changes after the migration transaction. `npm run typecheck` and `git diff --check` passed. No Provider was run; Task 6 lifecycle repository remains unimplemented.

**Test command:**

```powershell
npx --no-install vitest run --config vitest.config.ts tests/unit/workspace-persistence.test.ts
```

### Task 6: Implement Growth Editorial Repository

**Files:**
- Create: `src/domain/growth/editorial/growthEditorialRepository.ts`
- Create: `src/domain/growth/editorial/growthEditorialTypes.ts`
- Create: `tests/unit/growth-editorial-repository.test.ts`

**State machine:**

```text
planned -> ready -> running -> candidate_ready -> reviewing
reviewing -> revision_requested -> running
reviewing -> accepted -> commit_queued -> committed
any pre-side-effect state -> cancelled/failed
unknown side effect -> reconciliation_required
```

**Tests:** exact replay, conflicting replay, dependency unlock, same-owner attempt, restart recovery, cancellation and reconciliation barrier.

**Task 6 evidence (2026-07-18):** `GrowthEditorialRepository` now implements the approved state machine with transactional expected-state updates; exact/conflicting Round, Attempt and Review replay; fixed-capability revisions; dependency unlock only after serialized commit; complete restart snapshots; pre-side-effect cancellation/failure; and a persisted reconciliation barrier. `commit_queued` remains zero-side-effect until `markCommitRequested` is durably recorded, preventing a queued-only crash from being misclassified while failing closed before an external Change Set call. The Task 6 suite passed 7/7 and the combined repository+persistence gate passed 21/21 with zero skips; `npm run typecheck` and `git diff --check` passed. No Provider or Canon mutation path was run. Task 7 causal policy remains unimplemented.

## 8. Phase D — Causal Domain Graph

### Task 7: Define causal relation policy

**Files:**
- Create: `src/domain/graph/causalRelationPolicy.ts`
- Create: `src/domain/graph/causalRelationTypes.ts`
- Create: `tests/unit/causal-relation-policy.test.ts`
- Modify: `src/domain/graph/README.md`

**Causal endpoint:** assertion identity, not raw prose and not a vague entity-only edge.

**Kinds:**

- [x] `causes`
- [x] `enables`
- [x] `constrains`
- [x] `prevents`
- [x] `amplifies`
- [x] `mitigates`
- [x] `depends_on`

**Required fields:** cause assertion, effect assertion, mechanism, conditions, temporal scope, polarity/strength summary, epistemic status (`confirmed`, `inferred`, `disputed`), source references.

**Examples to encode as tests:**

- [x] geographic isolation -> transport cost -> slow diffusion -> slower national development;
- [x] childhood poverty -> deprivation/social stigma -> defensive behavior -> insecurity;
- [x] feedback loops are multiple directed edges, not a self-edge;
- [x] correlation without mechanism/source is rejected;
- [x] descriptive prose without development impact does not require an edge.

**Task 7 evidence (2026-07-18):** the internal causal policy fixes seven relation kinds, assertion-identity endpoints, mechanism/conditions/time/polarity-strength fields, `confirmed|inferred|disputed` epistemic status and exact source references. It rejects self-edges, raw-prose endpoints, correlation without mechanism/source, duplicate edges, unknown epistemic state and model-confidence fields; feedback is represented by independent directed edges. The policy suite passed 7/7 with zero skips and `npm run typecheck` passed. This is policy evidence only: Task 8 persistence, Change Set support and graph projection remain unimplemented, and no Provider was run.

### Task 8: Persist versioned causal relations

**Files:**
- Modify: `src/domain/workspace/workspaceRepository.ts`
- Create: `src/domain/graph/causalRelationRepository.ts`
- Create: `tests/unit/causal-relation-repository.test.ts`
- Modify: `tests/unit/workspace-persistence.test.ts`

**Additive tables:**

- [x] `causal_relations`
- [x] `causal_relation_versions`
- [x] `causal_relation_sources`

**Invariants:** checkpoint ancestry, immutable identity, current/conflict/deleted projection, source visibility, endpoint assertion visibility, branch isolation and exact replay.

**Task 8 evidence (2026-07-18):** additive SQLite v29 stores immutable causal identities, checkpointed versions and exact source links. `CausalRelationRepository` validates both assertion endpoints and every source against the target checkpoint ancestry, preserves branch isolation, projects the nearest `current|conflict` version, applies `deleted` tombstones without rewriting history and rejects identity/idempotency conflicts. The v28→v29 migration is transactional, additive, byte-preserves stable v28 rows, reopens idempotently and rolls back fully on collision. Repository + persistence suites passed 21/21 with zero skips; `npm run typecheck` passed. No Provider was run. Change Set integration was deferred to Task 9; product graph projection remains Task 10 work.

### Task 9: Extend atomic Change Set support

**Files:**
- Modify: `src/shared/agentWorkerProtocol.ts`
- Modify: `src/domain/changeSet/changeSetService.ts`
- Modify: `src/domain/changeSet/workspaceChangeSetPolicy.ts`
- Modify: `src/main/workspaceAgentToolGateway.ts`
- Modify: `src/domain/changeSet/changeSetRepository.ts`
- Modify: `src/domain/audit/agentAuditRepository.ts`
- Modify: `src/domain/graph/causalRelationRepository.ts`
- Modify: `src/domain/workspace/workspaceRepository.ts`
- Modify: corresponding contract, Change Set, policy and Gateway tests

**Steps:**

- [x] Add one versioned `causal_relation.put` item.
- [x] Make its assertion endpoints depend on assertion output items in the same Change Set or visible pinned assertions.
- [x] Require evidence/source binding for the causal edge itself.
- [x] Roll back text, assertions and causal relations together on failure.
- [x] Emit a distinct `DOMAIN_CAUSAL_*` diagnostic family without raw content.

**Task 9 evidence (2026-07-18):** `causal_relation.put` is a strict Agent proposal and internal Change Set item. Policy accepts only matching same-Change-Set assertion outputs or visible pinned assertions, and only active document versions or explicitly authorized same-Change-Set document outputs as edge sources. The workspace applier commits document text, assertions, causal relation versions, source records, output provenance and audit links under the existing outer Change Set transaction; injected post-edge failure rolls every formal mutation and the checkpoint back. SQLite v30 was explicitly authorized because the existing `change_set_outputs.output_kind` and `agent_audit_links.link_kind` CHECK constraints could not be extended additively; the copy-and-swap migration byte-preserves existing rows, reopens idempotently and fully rolls back when the second table collides. Safe review/error projections expose relation kind and `DOMAIN_CAUSAL_*` codes without mechanism text, source locators or raw payloads. Fourteen targeted protocol, policy, Change Set, Gateway, causal repository/policy, provenance, persistence, audit and affected legacy-migration files passed 115/115 tests with zero skips; `npm run typecheck` and `git diff --check` passed. No Provider was run and no full suite/build was run at this non-freeze batch. Task 10 graph projection/retrieval and Player Lens exposure remain unimplemented.

**Stop:** A compatibility shim is required to accept invalid old causal payloads.

### Task 10: Project and retrieve causal paths

**Files:**
- Modify: `src/domain/graph/semanticGraphService.ts`
- Modify: `src/domain/retrieval/graphRetrievalTypes.ts`
- Modify: `src/domain/retrieval/graphRetrievalService.ts`
- Modify: `src/renderer/src/features/graph/SemanticGraphView.tsx`
- Create/modify: causal graph and retrieval tests

**Acceptance:**

- [x] Creator Lens can query bounded upstream/downstream causal paths.
- [x] Every edge exposes safe mechanism summary, status and source reference.
- [x] Inferred/disputed edges are visually distinct.
- [x] Player Lens remains fail-closed until separately authorized.
- [x] Query caching keys include checkpoint, scope, Lens, query and budgets.

**Task 10 evidence (2026-07-18):** the Creator Lens semantic graph now projects current checkpointed causal relations onto assertion fact nodes and exposes bounded upstream/downstream retrieval from assertion seeds. Safe edge evidence contains relation kind, bounded mechanism summary, epistemic status and source kind/version/locator only; internal source identity and hashes do not cross the IPC or Worker contract. Confirmed, inferred and disputed edges have distinct stable visual styles, with conflict taking the strongest warning style. Retrieval fails closed for Player Lens, out-of-scope endpoints and future checkpoint versions, and uses an identity-free bounded in-memory cache keyed by checkpoint, authorized scope, Lens, query, resource/assertion seeds, direction and all budgets; truncated results are not cached. Ten targeted graph, retrieval, IPC, Worker/Growth and workspace files passed 166/166 tests with zero skips; `npm run typecheck`, `npm run build`, `git diff --check` and the real Electron semantic-graph E2E passed 1/1 after building current production output. The E2E used a local SQLite Fixture and is UI/runtime wiring evidence, not Provider Live. No Provider or full test suite was run. Player Lens causal disclosure remains separately frozen, and Task 11 fixed capability registry remains unimplemented.

## 9. Phase E — Fixed Agent Registry and Tool-Light Runtimes

### Task 11: Implement fixed capability registry

**Files:**
- Create: `src/agent-worker/editorial/agentCapabilityRegistry.ts`
- Create: `src/agent-worker/editorial/specialistContracts.ts`
- Create: `tests/unit/agent-capability-registry.test.ts`

**Registry fields:** capability ID, profile/version/hash, input/output schema, Prompt asset identity, maximum context class, concurrency group and terminal submission tool.

**Acceptance:** unknown capability, mismatched Prompt hash, arbitrary tools and capability/contract mismatch fail closed.

**Task 11 evidence (2026-07-18):** the code-owned registry covers exactly the 15 Task 4 capability IDs and gives each one a versioned profile/hash, capability-bound invocation schema, strict output schema, Prompt asset ID/version, maximum context class, concurrency group and one terminal submission tool. Authorization rejects unknown capabilities, profile drift, missing/duplicate trusted Prompt identities, Prompt identity/hash mismatch, arbitrary or multiple tools, input/output contract mismatch and strict-output violations. Existing Writer, Checker, GM and Decomposer identities remain separate registered capabilities; the new editorial roles reserve only the Task 13 Prompt asset ID/version and cannot be treated as published. The new registry plus Task 4 contract regression passed 12/12 tests with zero skips; `npm run typecheck` and `git diff --check` passed. No Provider, build, E2E or full suite was run. Task 12 runtime and Task 13 Prompt assets/publication remain unimplemented.

### Task 12: Implement generic specialist runtime

**Files:**
- Create: `src/agent-worker/editorial/specialistRuntime.ts`
- Create: `src/agent-worker/editorial/specialistWorkerController.ts`
- Create: `src/shared/growthEditorialWorkerProtocol.ts`
- Modify: `src/agent-worker/index.ts`
- Create: `tests/unit/growth-specialist-runtime.test.ts`

**Runtime rule:** each specialist receives one prepared packet and only `submit_specialist_candidate`; `needs_more_evidence` terminates without mutation and requests a new prepared invocation.

### Task 13: Add versioned specialist Prompt assets

**Files:**
- Create: `src/agent-worker/prompts/editorial/world-director/v1.md`
- Create: `src/agent-worker/prompts/editorial/world-system/v1.md`
- Create: `src/agent-worker/prompts/editorial/geography-ecology/v1.md`
- Create: `src/agent-worker/prompts/editorial/civilization/v1.md`
- Create: `src/agent-worker/prompts/editorial/organization/v1.md`
- Create: `src/agent-worker/prompts/editorial/species-culture/v1.md`
- Create: `src/agent-worker/prompts/editorial/character/v1.md`
- Create: `src/agent-worker/prompts/editorial/story-architect/v1.md`
- Create: `src/agent-worker/prompts/editorial/general-setting/v1.md`
- Create: `src/agent-worker/prompts/editorial/graph-curator/v1.md`
- Create: `src/agent-worker/prompts/editorial/visual-director/v1.md`
- Create: `src/agent-worker/editorial/editorialPromptRegistry.ts`
- Create: publication/evaluation tests

**Rules:** fixed role, no project tools, no raw reasoning exposure, source-bound claims, strict terminal result, model identity audited. Prompts are candidates until real publication evaluation passes.

## 10. Phase F — World Director and Work Order Scheduling

### Task 14: Compile Director editorial packets

**Files:**
- Create: `src/main/growth/editorial/worldDirectorPacketCompiler.ts`
- Create: `tests/unit/world-director-packet.test.ts`

**Packet contents:** user rules, editorial charter, Closure matrix, current causal frontier, recent Change Set diff, unresolved Checker findings, node maturity, source-bound graph summaries and image queue summary.

**Exclusions:** full database dump, raw Prompt, credentials, hidden Player facts, unrelated prose and unbounded graph.

### Task 15: Implement World Director runtime

**Files:**
- Create: `src/agent-worker/editorial/worldDirectorRuntime.ts`
- Create: `src/agent-worker/editorial/worldDirectorWorkerController.ts`
- Create: `tests/unit/world-director-runtime.test.ts`

**Output:** bounded Editorial Round plan or editorial review. No prose candidate, tool call or direct Change Set.

### Task 16: Implement Main editorial scheduler

**Files:**
- Create: `src/main/growth/editorial/growthEditorialScheduler.ts`
- Create: `src/main/growth/editorial/growthWorkOrderRunner.ts`
- Modify: `src/main/growthCoordinator.ts`
- Create: `tests/unit/growth-editorial-scheduler.test.ts`

**Scheduling:**

- [ ] Persist Director plan before spawning any specialist.
- [ ] Default creative concurrency 3; configurable and provider backpressure-aware.
- [ ] Only dependency-ready Work Orders run.
- [ ] Candidate generation is side-effect free.
- [ ] Commit queue concurrency is exactly 1.
- [ ] Later candidate rebases/rechecks against latest checkpoint before commit.
- [ ] Cancellation stops undispatched candidates and preserves completed evidence.
- [ ] Restart never duplicates an accepted candidate or committed Change Set.

### Task 17: Implement same-owner review and revision

**Files:**
- Create: `src/main/growth/editorial/growthEditorialReviewCoordinator.ts`
- Create: `tests/unit/growth-editorial-review.test.ts`

**Review order:** deterministic validation -> Graph Curator -> Checker -> Director.

**Rules:**

- [ ] Hard Domain/Checker finding blocks Director acceptance.
- [ ] Director may reject valid-but-shallow work with explicit acceptance facet gaps.
- [ ] Revision uses same capability/profile/Prompt version and original Work Order.
- [ ] Maximum two editorial revisions by default.
- [ ] Duplicate finding/no-progress escalates to user or recorded debt.

## 11. Phase G — Graph Curator and Atomic Candidate Compilation

### Task 18: Implement Graph Curator candidate extraction

**Files:**
- Create: `src/agent-worker/editorial/graphCuratorContracts.ts`
- Create: `src/agent-worker/editorial/graphCuratorRuntime.ts`
- Create: `tests/unit/graph-curator-runtime.test.ts`

**Acceptance:** every assertion and causal candidate cites exact supplied evidence; unsupported causality is returned as missing evidence, not invented.

### Task 19: Compile specialist + graph output into one Change Set

**Files:**
- Create: `src/main/growth/editorial/growthCandidateCompiler.ts`
- Create: `src/main/growth/editorial/growthCandidatePolicy.ts`
- Create: `tests/unit/growth-candidate-compiler.test.ts`
- Modify only through phase seams: `src/agent-worker/growth/core/growthPhaseRegistry.ts`

**Acceptance:** IDs, ownership, parent hierarchy, assertion sources, causal endpoints and dependencies are Harness-generated; model supplies creative content only.

**Stop:** implementation requires adding more phase-specific branches to `stewardExecutionStateMachine.ts` instead of using a handler seam.

## 12. Phase H — Large-World and Per-Node Closure

### Task 20: Encode hierarchical world skeleton requirements

**Files:**
- Modify: `src/agent-worker/growth/growthWorldFragment.ts`
- Create: `src/domain/growth/closure/worldScaleClosureProfile.ts`
- Modify: relevant World Fragment/Closure tests

**Minimum default:** one world; at least three macro regions; at least four polities/civilization groups across two regions; explicit mountains, seas, rivers, transport and resource distribution; four eras and three historical turning points; at least four cross-system causal mechanisms.

### Task 21: Encode node maturity profiles

**Files:**
- Create: `src/domain/growth/closure/nodeMaturityProfiles.ts`
- Create: `tests/unit/node-maturity-profiles.test.ts`

**Profiles:** OC (14 dimensions), nation (16), organization (12), geography (12), species (14), civilization (16), story and world. Profiles are coverage criteria, not rigid UI forms.

**Importance tiers:** core, major, supporting, background. Only core/major require full default depth; user may promote any node.

### Task 22: Integrate causal self-inquiry

**Files:**
- Modify through phase module: `src/agent-worker/growth/growthInquiryBrief.ts`
- Create: `src/domain/growth/editorial/causalInquirySelector.ts`
- Modify: Inquiry and Closure tests

**Rules:** 3–7 questions, choose one highest-value causal gap, deduplicate, detect no-progress, cite affected nodes and evidence, ask user only for genuine creator choice.

## 13. Phase I — Incremental Illustration Pipeline and Default Style

### Task 23: Trigger illustration planning after each committed node

**Files:**
- Modify: `src/main/growth/illustration/growthIllustrationApplicationService.ts`
- Create: `src/main/growth/illustration/growthIncrementalIllustrationPlanner.ts`
- Modify: `src/main/growthCoordinator.ts` only through a commit-event seam
- Create: `tests/unit/growth-incremental-illustration.test.ts`

**Rules:** enqueue after stable Change Set output; never wait for final Closure; idempotent per source version/variant; revised source marks old item stale and creates replacement; text scheduler never awaits image completion.

### Task 24: Apply one visual style policy to every image purpose

**Files:**
- Modify: `src/domain/growth/growthVisualStylePolicy.ts`
- Modify: `src/agent-worker/growth/growthWorldMapBrief.ts`
- Modify: `src/agent-worker/growth/growthIllustrationPlan.ts`
- Modify: visual style/map/illustration tests

**Default style:** colored expressive steel-pen/ink linework, broken angular contours, cross-hatching, visible hand-drawn texture, restrained watercolor/gouache color, mature fantasy concept illustration.

**Negative:** photorealism, cinematic photography, 3D/Unreal/CG render, glossy game poster, monochrome-only output, chibi, kawaii, generic moe, embedded paragraphs/fake map labels.

**Map adaptation:** world/region/nation/city scale-specific cartography using the same line language; authoritative labels are Renderer overlays from graph data.

### Task 25: Visual Director text-to-brief handoff

**Files:**
- Create: `src/main/growth/illustration/growthVisualBriefPacket.ts`
- Create: `tests/unit/growth-visual-brief-packet.test.ts`

**Flow:** committed text + graph evidence -> Visual Director brief -> deterministic style compiler -> persisted queue. Visual Director cannot invent facts or call image Provider.

## 14. Phase J — User Experience and Safe Projection

### Task 26: Route Growth conversation to World Director

**Files:**
- Modify: `src/shared/ipcContract.ts`
- Modify: Main/Preload Growth IPC registration
- Modify: `src/renderer/src/features/agent/StewardRuntimePanel.tsx`
- Create: contract and UI tests

**UX:** Growth mode identifies World Director as interlocutor; Steward remains visible only in expandable operational activity. Outside Growth, normal Steward conversation is unchanged.

### Task 27: Present editorial work and causal growth

**Files:**
- Modify: Growth presentation projector and contract
- Modify: `src/renderer/src/features/agent/RunActivityTimeline.tsx`
- Modify: `src/renderer/src/features/activity/RunWorkTargetPane.tsx`
- Modify: `src/renderer/src/features/graph/SemanticGraphView.tsx`
- Create/modify: projection, component and Electron E2E tests

**Safe events:** Director planning, employee assigned, candidate ready, checking, revision requested, committed, image queued/ready/failed. No raw thoughts, Prompt, candidate JSON, credentials or hidden evidence.

## 15. Phase K — Failure, Recovery and Diagnostics

### Task 28: Classify editorial failures

**Files:**
- Extend existing safe diagnostic modules, not generic raw logging
- Create: editorial diagnostic tests

**Families:** `EDITORIAL_PLAN_*`, `WORK_ORDER_STATE_*`, `SPECIALIST_PROTOCOL_*`, `GRAPH_CAUSAL_*`, `EDITORIAL_REVIEW_*`, existing `PROVIDER_*`, `DOMAIN_*`, `PERSISTENCE_*`, `RECONCILIATION_*`.

### Task 29: Prove crash/restart recovery

**Tests:**

- [ ] restart with allocated Work Orders;
- [ ] restart with running candidate and no Provider receipt;
- [ ] restart after candidate Artifact persisted but before review event;
- [ ] restart after accepted review but before Change Set;
- [ ] restart after committed Change Set but before image enqueue;
- [ ] outcome-unknown commit blocks duplication;
- [ ] image failure does not block text Director loop.

## 16. Phase L — Central Freeze and Real Acceptance

### Task 30: Deterministic freeze

**Commands:**

```powershell
git diff --check
npm run typecheck
npm run verify:prompt-publication
npm test
npm run build
npm run package
```

- [ ] Run focused tests during implementation.
- [ ] Run the full suite only after code freeze.
- [ ] Run one build/package process at a time.
- [ ] Check and clean only this worktree's Electron processes.
- [ ] Update current-state, ADRs and evidence index.
- [ ] Review exact staged files before semantic commits.

### Task 31: Verify Provider profiles

- [ ] Public text profile is `openai-compatible / 5.6luna` exactly.
- [ ] Public image profile is the configured image-capable model.
- [ ] Local State and encrypted profile copies match before isolated E2E.
- [ ] No credential is decrypted, printed or copied into evidence.
- [ ] If identity mismatches, fail before any Provider call.

### Task 32: One real interactive dual-Provider Live

**Scenario:**

1. User gives one arbitrary seed.
2. World Director creates a world-scale editorial plan.
3. At least two independent country/region candidates execute concurrently.
4. Director reviews one result, assigns a dependent OC and returns one weak candidate to its original owner.
5. Graph Curator creates sourced causal chains.
6. Checker approves repaired content.
7. Text commits serialize across checkpoints.
8. User adds one rule mid-run; next boundary re-retrieves and repairs affected nodes.
9. Image tasks enqueue as each target commits; text continues.
10. World, story and OC closures reach accepted or a truthful product blocker.
11. Reopen proves persistence.
12. Research-only run retrieves a causal path and creates no mutation.
13. Export atomically overwrites `artifacts/latest-growth-world-package`.

**Required evidence:** Provider/model identities, Director rounds, Work Orders/attempts/dependencies, review lineage, receipts, Change Sets, checkpoint chain, causal path, illustration queue states, safe UI states, reopen and research-only audit. No raw prose, Prompt, tool args, locator, error text or credentials in evidence JSON.

## 17. Task Intent, Expected Effect and Exit Evidence

This matrix is the execution index. The detailed phase sections define files and mechanics; this index defines why each task exists and what observable result justifies checking it off.

| Done | Task | Why it is necessary | Expected effect | Exit evidence |
| --- | ---: | --- | --- | --- |
| [x] | 1 | The current worktree contains many overlapping unfinished batches and evidence files. Starting new architecture without ownership classification risks deleting evidence or mixing unrelated regressions. | Every dirty path has an owner/category and the highest valid Live boundary is indexed. | Exact status inventory, evidence parse/leak check and no overlapping live editor. |
| [x] | 2 | New capability work on a failing baseline makes every later failure ambiguous. | Existing behavior becomes a green, reviewed checkpoint before schema or scheduler work. | Focused tests, typecheck, one repaired full freeze, build and reviewed semantic commits. |
| [x] | 3 | Director/Steward/Checker/Curator boundaries are product semantics and must not be rediscovered differently in each file. | One ADR records authority, concurrency, commit serialization and post-hackathon debt. | ADR review plus current-state/product documents aligned with code intent. |
| [x] | 4 | Ad-hoc objects would leak phase-private state into the shared protocol and recreate a giant contract. | Strict versioned internal contracts define rounds, orders, attempts, reviews and artifacts. | Zod/TypeBox parity, strict unknown-field rejection and lifecycle transition tests. |
| [x] | 5 | Assignment and review must survive restart; in-memory coordination cannot prove ownership or avoid duplicate work. | SQLite v28 stores additive editorial metadata without rewriting Canon content. | v27→v28 migration, reopen, unique constraints, replay and preservation tests. |
| [x] | 6 | Multiple callers must not implement Work Order transitions differently. | One repository owns legal transitions, idempotency, sequencing and replay. | Success, invalid transition, duplicate request, outcome-unknown and restart tests. |
| [x] | 7 | “related_to” cannot express development logic and model prose cannot be the causal authority. | One executable policy defines allowed causal kinds, endpoints, evidence and epistemic states. | Table-driven policy tests including unsupported/correlation-only rejection. |
| [x] | 8 | Causality must be checkpointed and historical, not overwritten in place. | Causal relation versions and sources can be replayed at any checkpoint. | Migration/repository tests for current, superseded, disputed and branch-isolated edges. |
| [x] | 9 | Text and its causal interpretation must not commit separately and drift. | One Change Set atomically applies documents, assertions and causal edge versions. | Rollback/no-partial-write, idempotency, invalid-source and checkpoint tests. |
| [x] | 10 | The Director and specialists need bounded causal memory rather than whole-project context. | Retrieval returns sourced causal paths, gaps, conflicts and truncation receipts from a pinned checkpoint. | Deterministic path/rank/budget/Lens/checkpoint tests. |
| [x] | 11 | Fixed roles are needed for the demo, but Director must not invent arbitrary prompts, tools or capabilities. | A code-owned registry exposes a closed roster with stable prompt identity and schemas. | Unknown capability/tool/Prompt injection rejection tests. |
| [ ] | 12 | Specialists should spend tokens on creation, not tool orchestration. | A generic runtime invokes one profile with one evidence packet and receives one strict candidate. | Provider fail-closed, schema correction bound, cancellation and redaction tests. |
| [ ] | 13 | Role quality and responsibility need explicit, versioned instructions without encoding Domain truth in Prompt text. | Each employee has a narrow Prompt asset, acceptance facets and prohibited authority. | Prompt registry/hash/publication tests; active identities remain unchanged until accepted. |
| [ ] | 14 | Director cannot safely plan from raw database rows or entire documents. | A compact packet provides rules, causal frontier, closure gaps, recent diffs and available capabilities. | Budget, provenance, checkpoint, hidden-data and deterministic ordering tests. |
| [ ] | 15 | The user needs one editorial intelligence that chooses what grows next and evaluates the whole. | Director emits a bounded dependency DAG and structured editorial decisions, not prose or tools. | Strict plan/review schemas, no raw tool authority and unsupported capability rejection. |
| [ ] | 16 | Concurrent candidates and serialized Canon commits require durable scheduling, not a Prompt convention. | Ready independent orders run concurrently; dependent orders wait; accepted commits use one lane and rebase. | Concurrency, dependency, lease, stale checkpoint, cancellation and idempotency tests. |
| [ ] | 17 | Creating a fresh task on rejection loses accountability and feedback lineage. | A rejected result returns to the same capability/Work Order as a new attempt with bounded feedback. | Same-owner identity, attempt lineage, retry cap and no-progress termination tests. |
| [ ] | 18 | Specialist prose does not automatically become trustworthy graph structure. | Graph Curator returns sourced assertions and causal candidates with no Domain side effect. | Source-span, mechanism, condition, uncertainty and unsupported-inference tests. |
| [ ] | 19 | Curator output, Checker findings and specialist content must converge before writing. | A deterministic compiler produces one authorized Change Set or one precise blocker. | Atomic compiled-output integration tests and zero-write rejection tests. |
| [ ] | 20 | Previous output was too small because “world” had no enforced scale. | Default Growth creates world/cosmos, multiple macro regions/polities, physical systems, eras and interacting rules. | World-scale closure tests and a package skeleton fixture satisfying only real Domain rules. |
| [ ] | 21 | Short cards look complete to a model unless depth is executable. | Importance-aware maturity profiles expose missing OC/nation/organization/geography/species/story dimensions. | Boundary tests for core/major/supporting/background nodes and promotion. |
| [ ] | 22 | Self-inquiry is useful only when it selects causal gaps from evidence and stops looping. | Each round proposes 3–7 deduplicated questions, chooses one valuable gap and records affected nodes. | Evidence, ranking, dedupe, no-progress and genuine-user-choice tests. |
| [ ] | 23 | Waiting until all text ends serializes image time and hides incremental growth. | Every eligible committed version creates an idempotent image queue item while text work continues. | Post-commit enqueue, revision-stale replacement, nonblocking failure and concurrency tests. |
| [ ] | 24 | Separate image paths currently drift in style and maps can become photorealistic. | One default colored hand-drawn ink policy applies to maps, characters, scenes and details. | Purpose-specific prompt compilation and prohibited-style regression tests. |
| [ ] | 25 | Image models need concise visual briefs derived from stable text, not raw drafts or invented facts. | Visual Director converts committed text/graph evidence into a source-bound brief; deterministic code adds style. | Provenance, no-invention, source-version and strict-output tests. |
| [ ] | 26 | Growth currently appears as Steward operation rather than editorial collaboration. | User talks to World Director in Growth; Steward activity remains expandable operational detail. | IPC contract, route restoration, fail-closed and non-Growth regression tests. |
| [ ] | 27 | Judges and users must see real nodes and edits growing, not only terminal files. | Timeline, right editor, graph and image queue project authoritative safe events and committed objects. | Reducer/component/Electron tests for ordering, failure, scope switch and no premature completion. |
| [ ] | 28 | Generic failures force whole-repository searches and make AI repair unsafe. | Error families identify Provider, specialist protocol, Work Order state, causal Domain, review, persistence or reconciliation ownership. | Allowlisted diagnostic mapping, redaction and unknown-error containment tests. |
| [ ] | 29 | Long runs will be interrupted; replay bugs can duplicate Provider calls or Canon writes. | Restart reconciles every editorial boundary and resumes or blocks truthfully. | Crash matrix covering allocated/running/candidate/review/commit/image boundaries. |
| [ ] | 30 | Focused tests cannot prove the integrated frozen candidate or release artifacts. | One frozen code state passes all deterministic, build and package gates with updated evidence index. | `git diff --check`, typecheck, Prompt gate, full tests, build and package. |
| [ ] | 31 | The requested literary quality test is invalid if the saved model is not exactly `5.6luna`. | Live fails before side effects unless both public Provider identities match approved profiles. | Public identity evidence and encrypted-profile/Local-State consistency checks. |
| [ ] | 32 | Mock and historical evidence do not prove the final Director/causal/image/user-guidance loop. | One real seed produces and revises a persistent causal large-world package, survives reopen and supports research retrieval. | One sanitized dual-Provider Live report, exported package and no-mutation research audit. |

## 18. Progress Reporting Format

After every completed task, update this document in place:

```text
[x] Task N — completed
    Commit: <hash or uncommitted review boundary>
    Tests: <command and count>
    Live: yes/no
    Remaining blocker: <none or exact boundary>
```

The chat progress view must report:

```text
Overall: completed tasks / 32
Current phase: A–L
Current task: N
Last verified command: ...
Next task: ...
Blocked product decision: none / exact question
```

Do not mark a phase complete from a design document, Fixture, Mock, historical Live or partial targeted test.
