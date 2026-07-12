# NovelX Desktop Runtime V2 Product Baseline

Status: product contract, not an implementation-complete claim  
Scope: NovelX Desktop only; Android synchronization and marketplace distribution are outside this baseline

## 1. Product position

Runtime V2 is the governed Agent kernel of NovelX Desktop. NovelX is a creation workbench for novels, worlds, original characters, story projects, imported sources and playable story branches. The Steward（大管家）is the user's primary Agent. It can discuss, inspect, plan, delegate, create candidate changes and coordinate specialist Agents, while the Harness（运行框架）enforces source access, permissions, versioning, review and audit.

Runtime V2 must feel like Codex applied to creative work, not like a code editor with renamed labels. The user sees projects, sessions, documents, creative objects, graph facts, Agent activity and reviewable results. Internal Prompt files, database tables, raw tool JSON and hidden runtime files are not the normal product surface.

Runtime V2 is not:

- a deterministic local chatbot pretending to be an Agent;
- an excuse for an Agent to write directly around Free / Assist, Change Set or source rules;
- a replacement for the GM -> Writer -> Checker player runtime;
- a general shell or arbitrary-code execution environment;
- a promise that every future collaboration, image or plugin feature already exists.

## 2. Layer boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Kernel capability | Runs, Goals, Plans, tool leases, cancellation, context admission, Provider calls, audit, session branches, Agent delegation and communication envelopes | Novel-specific truth interpretation, visual layout, hard-coded story outcomes |
| Domain module | Worlds, OC, stories, documents, graph assertions, timelines, imports, Change Sets, canon, playthroughs and checkpoints | Provider transport, raw process supervision, UI-only state |
| UI projection | Agent/IDE/Player views, activity, artifacts, comments, model selector, history drawer and domain editors | Canon decisions, permission decisions, hidden tool execution, fake completion |
| Future extension | Pet presentation, image generation, maps, collaboration, Mod/Plugin surfaces and Android synchronization | Silent access to the kernel, direct canon writes, unrestricted project code execution |

The kernel exposes typed capabilities. Domain modules register typed tools and artifacts. The UI renders allowlisted projections. Future extensions consume stable public events and commands instead of reading internal runtime state.

## 3. Core invariants

1. **Real Agent invariant.** Any operation presented as Agent work uses a configured real Provider. Missing Provider or invalid configuration blocks the run; no local prose fallback is labelled live.
2. **Project confinement invariant.** Every run is bound to one registered project and an explicit or backend-derived resource scope. Project tools cannot escape the project root or silently inspect another project.
3. **Source invariant.** Claims about existing project content must be supported by real file, document, graph, memory or version evidence. A missing guessed file is not an authorization failure.
4. **Write invariant.** Formal project mutations use Change Sets. Assist requires confirmation. Free may auto-commit only policy-allowed low-risk changes. Overwrite and deletion retain version and source evidence.
5. **Version invariant.** User edits and Agent edits share the same durable version chain. Reverting creates an auditable new head or branch; it does not erase history.
6. **Session invariant.** A session is an independent Agent conversation with private history, a project binding, a branch head and optional model override. It does not gain another session's private transcript implicitly.
7. **Communication invariant.** Inter-Agent communication is structured, source-linked and visible as a handoff or shared-memory artifact. It is not hidden prompt concatenation.
8. **Goal invariant.** Long work is represented by a durable Goal and an inspectable Plan. Completion is based on acceptance criteria and evidence, not on the model saying “done”.
9. **Audit invariant.** Tool execution, effective Prompt/runtime identity, Provider receipt, Change Set and terminal state remain auditable. The user-facing reply stays natural and does not expose raw internals.
10. **Fail-closed invariant.** Cancellation, Worker interruption, context overflow, source conflict, stale version, audit failure or validation rejection cannot produce a success artifact.
11. **Projection invariant.** UI panels display persisted or runtime-confirmed state only. Mock, fixture and placeholder results cannot be presented as live project state.
12. **Player separation invariant.** Player Mode shows accepted prose, player action, public state and explicit reconciliation. It never exposes GM resolution JSON, hidden Creator Lens facts or internal Agent traces.

## 4. Runtime entities

### 4.1 Run

A Run is one bounded Agent execution. It records session, project, branch head, Goal/Plan references, effective model profile, context budget, tool trace, result, artifacts and terminal status. Terminal states are `completed`, `awaiting_confirmation`, `blocked`, `cancelled` or `failed`.

### 4.2 Goal and Plan

A Goal is durable intent that may span multiple Runs. It contains:

- a user-readable objective;
- project and resource scope;
- acceptance criteria;
- constraints and permission mode;
- owner Agent and optional child Agents;
- status and evidence-backed completion record.

A Plan is a versioned execution proposal under a Goal. Each step declares its purpose, dependencies, assigned Agent, required capabilities, expected artifact and completion evidence. Plans may be revised after new evidence, but previous revisions remain inspectable.

The Steward may create a Goal automatically when work is clearly multi-step, long-running, delegated or resumable. A short question or one-file action remains a simple Run. Creating a Goal must not add ceremonial UI to ordinary chat.

Goal completion requires all mandatory steps, no unresolved blocking issue, and acceptance evidence. A child Agent cannot mark the parent Goal complete. The Steward consolidates child results and either continues, requests review or proposes completion.

### 4.3 Session

A Session owns its conversation history, private working memory, current Goal references, model override and current session branch. Multiple sessions may operate on one project. Project writes are serialized and use optimistic version checks so one session cannot silently overwrite another.

### 4.4 Session branch

Editing or retrying an earlier user message creates a new session branch when later messages or effects exist. The original branch remains available. The new branch inherits project references and history only up to the fork point.

Session branches and project versions are related but different:

- session branch: alternative conversation and reasoning route;
- project branch/checkpoint: alternative persisted creative state;
- playthrough branch: alternative player story history pinned to canon.

A session fork does not automatically revert project data. If the abandoned route created committed changes, the UI must offer an explicit project checkpoint action or continue from the current project head. No hidden rollback is allowed.

## 5. Automatic Agent allocation

The Steward is the default owner. It may allocate child Agents only when delegation has a concrete benefit: parallel independent research, specialist writing/checking, import decomposition, long-document partitioning or isolated review.

Allocation rules:

- each child receives one bounded assignment, source scope, permissions, expected output and parent Goal/Plan reference;
- child Agents default to read-only unless the Plan explicitly grants a Change Set proposal capability;
- parallel children cannot write concurrently to the same project target;
- the number of children is limited by configured concurrency, Provider budget and task independence;
- delegation is visible in activity and cancellable;
- the Steward remains accountable for synthesis and conflicts;
- repetitive child creation without independent work is rejected as waste.

The first Runtime V2 acceptance target is automatic bounded delegation, not an unrestricted Agent society or autonomous background swarm.

## 6. Session and Agent communication

Runtime V2 supports two explicit communication objects:

1. **Handoff（任务交接）**: one session/Agent asks another to perform bounded work. It contains sender, recipient, project, source checkpoint, scope, instructions, expected artifact and status.
2. **Shared Memory（共享记忆）**: a stable, source-linked fact or decision made available to selected project sessions. It is not a copied full transcript and cannot override canon by itself.

An Agent may reference another session only through accepted Handoffs or Shared Memory. Receiving Agents re-check current sources when the referenced checkpoint is stale. The UI shows origin, recipient, status and produced artifact.

Group chat is not a Runtime V2 baseline requirement. A future group view may project several structured Agent contributions into one room, but it must use the same communication objects rather than allowing uncontrolled cross-session transcript access.

## 7. Comments and annotations

Comments are first-class review objects, not Markdown inserted into the work. They may anchor to:

- document version plus character/text range;
- graph node or assertion version;
- OC/world/story resource version;
- Agent message or artifact;
- Change Set item.

A comment records author, body, anchor, created version, thread status and optional assigned Agent/session. Replies form a comment thread. Status is `open`, `resolved` or `outdated`.

When the target changes, NovelX attempts stable anchor relocation. If relocation is ambiguous, the comment becomes `outdated`; it must not jump silently to unrelated text. Users can ask the Steward to address selected comments, producing a Plan and reviewable Change Set. Resolving a comment does not itself mutate content.

## 8. Model switching in the lower-right corner

Agent and IDE workspaces expose a compact model control at the lower-right edge of the conversation composer. It shows Provider and model, with context capacity and reasoning mode in the menu. It is a selector, not a decorative status label.

Rules:

- switching applies to the next Run, never to an already running Run;
- the session can use the project default or a session override;
- child Agents inherit the parent setting unless the Plan selects an allowed specialist profile;
- unavailable or untested models show a clear blocked state;
- model capability metadata drives context and output budgets; no universal 12,800-token assumption;
- changing model does not change tool permissions, Prompt publication status, Free/Assist mode or source rules;
- every Run audits the effective Provider/model/profile without exposing credentials.

Player Mode may expose a separate GM profile setting in project settings, but it does not reuse a casual mid-turn model switch that would obscure playthrough reproducibility.

## 9. Right-side sliding history and rollback

The right-side History drawer is a project tool available from Agent and IDE modes. It slides over the existing right rail without replacing the current document or conversation.

The drawer shows a chronological stream of:

- user and Agent committed edits;
- Change Sets and review decisions;
- checkpoints and branches;
- affected creative objects/files;
- author/session/Agent;
- concise diff summary and restoration availability.

Selecting an entry opens its details and affected artifacts. “Restore” never destroys later history. The default action creates a new project head from the selected checkpoint. When branching support is unavailable for a specific object, the UI must state the reduced behavior before confirmation.

Rollback is disabled while an incompatible write lease is active. Session transcript rewind and Player playthrough reconciliation use their own controls and must not be disguised as project rollback.

## 10. UI projections

### Agent Mode

- Left: registered projects and independent sessions.
- Center: conversation, Goal/Plan progress, user messages and Agent replies.
- Right: `文件夹内容` opened by default; `活动与产物` independently collapsible; both may be open or closed.
- Composer: Free/Assist control and lower-right model selector.
- Secondary tools: comments and right-side History drawer.

### IDE Mode

- Left: domain-oriented project tree, not raw hidden runtime files.
- Center: document/resource editor, graph, timeline, image or map view.
- Right: Agent conversation and activity for the selected object.
- The same Goal/Plan, comment, model and history contracts apply.

### Player Mode

- Prose/card presentation remains separate from creation chat.
- Only accepted story content and allowlisted public state are shown.
- Changes made in Agent/IDE Mode require explicit playthrough reconciliation when they diverge from pinned canon.

## 11. Pet extension interface

The desktop pet is a future presentation extension, not an Agent authority and not executable code embedded in a novel. Runtime V2 reserves a capability-limited `PetExtension` interface with:

- read-only public events: Run started/completed/blocked, tool category, Goal progress, review waiting and user idle;
- presentation commands: play allowlisted animation, switch expression, show a short localized status and open an existing NovelX panel;
- packaged assets: sprites, animations, sounds and theme metadata;
- declared resource budgets and reduced-motion support.

The pet cannot read raw prompts, credentials, private transcripts, hidden Creator Lens facts or arbitrary project files. It cannot invoke tools, approve Change Sets, alter canon or execute arbitrary scripts. Future skill effects or OC animations belong to a separately permissioned visual extension system and are not part of the initial pet contract.

## 12. Codex-style capability tiers and dependency order

The following capabilities are confirmed product requirements. “Required” means the relevant Runtime V2 or desktop-workbench acceptance gate cannot pass without the defined behavior. “Enhancement” means the capability is part of the approved direction but does not block the first Runtime V2 kernel migration. Neither label means the feature is implemented today.

| Capability | Tier | Primary layer | Hard dependencies | Product boundary |
| --- | --- | --- | --- | --- |
| Goal | Required | Kernel capability | Durable Run journal, project/session identity, acceptance evidence | Created for multi-step or resumable work; ordinary chat is not forced into a Goal. |
| Plan | Required | Kernel capability + UI projection | Goal, versioned steps, tool ledger, Agent assignment | Inspectable and revisable; it is not hidden chain-of-thought and cannot mark itself complete without evidence. |
| Session branch | Required | Kernel capability + domain version link | Durable messages, fork point, project checkpoint identity | Forks conversation history only; committed project state changes only through an explicit restore/branch action. |
| Automatic Agent allocation | Required | Kernel capability | Goal, Plan, concurrency budget, child scope/permission lease, cancellation | Bounded delegation only; no unbounded autonomous swarm and no child self-authorizing writes. |
| Session/Agent communication | Required | Kernel capability + domain module | Session identity, Handoff, Shared Memory, source checkpoint, stale-source check | Structured exchange rather than implicit access to another private transcript. Group-chat presentation is not required. |
| Lower-right model adjustment | Required desktop projection | UI projection backed by kernel profile registry | Published model profile, capability metadata, session override, per-Run audit | Affects the next Run only and never changes permissions, Prompt publication or an active Run. |
| Right-side sliding history/rollback | Required desktop projection | UI projection + domain version module | Checkpoints, Change Sets, diff projection, write lease, branch/restore service | Restore creates an auditable new head or branch; it never deletes later history or rewinds a Player save implicitly. |
| Comments/annotations | Enhancement | Domain module + UI projection | Stable version anchors, thread status, Agent assignment, Change Set | Comments do not mutate content by themselves; failed anchor relocation becomes `outdated`. |
| Desktop pet | Future enhancement | Future extension | Allowlisted public event bus, presentation command API, resource budget, reduced-motion support | Presentation-only; no project-file access, tool invocation, approval, Prompt access or arbitrary scripts. |

### 12.1 Required dependency sequence

The implementation order is constrained by state ownership, not by visual convenience:

1. Durable Run events, protocol handshake, recovery and tool ledger.
2. Goal and versioned Plan persistence with evidence-backed terminal rules.
3. Session identity and session branching linked to explicit project checkpoints.
4. Bounded child-Agent allocation, cancellation and parent synthesis.
5. Handoff and Shared Memory communication with stale-checkpoint validation.
6. Model profile selection and per-Run effective-profile audit.
7. Checkpoint/diff projection and the right-side history/restore drawer.
8. Version-anchored comments and Agent comment-resolution workflow.
9. Allowlisted public extension events for the desktop pet.

UI mockups may be explored earlier, but they cannot be marked live before their authoritative kernel or domain dependency exists. In particular, a visual Plan without durable steps, a model selector without audited effective profiles, or a rollback drawer backed by fixture history fails this baseline.

### 12.2 Non-commitments

This baseline does not commit NovelX to:

- reproducing Codex source code, internal Prompt behavior or private implementation details;
- exposing raw filesystem/runtime internals as the default creative interface;
- unlimited Agents, unlimited parallel Provider cost or silent background work;
- automatic cross-session transcript sharing or baseline group chat;
- destructive Git-style reset semantics for project restoration;
- switching the model in the middle of an active Run or Player turn;
- executable pet scripts, novel-embedded code or a general plugin sandbox in Runtime V2;
- declaring any capability complete from schema, documentation or static UI alone.

## 13. Acceptance metrics

| Area | Acceptance criterion |
| --- | --- |
| Goal/Plan | A multi-step request creates one durable Goal; Plan revisions, step assignments, evidence and terminal reason survive restart; a one-step chat does not require a Goal. |
| Session branching | Editing a non-tail message creates a visible branch; both branches remain readable; no committed project change is silently reverted. |
| Automatic allocation | The Steward can allocate at least two independent bounded child tasks, show both in activity, cancel either, and synthesize only source-linked results. |
| Communication | A Handoff can be sent, accepted, completed and traced to its source checkpoint; stale handoff evidence triggers re-check or block. Shared Memory never imports a full private transcript. |
| Comments | Users can create, reply, resolve and reopen a version-anchored comment; content edits either preserve the anchor or mark it outdated; selected comments can feed an Agent Plan. |
| Model selector | The lower-right control changes the next Run only; restart preserves session override; the audit shows the effective model; unavailable models fail clearly. |
| History drawer | The drawer opens from Agent and IDE modes, lists real persisted changes, previews affected items and restores by creating an auditable new head without deleting later history. |
| File/project inspection | “Inspect this project” lists real paths first, reads existing files including Chinese names, and never maps `not found` to `not authorized`. |
| Concurrency | Two sessions cannot silently overwrite the same version; the loser receives a reviewable stale-version conflict. |
| Failure behavior | Missing Provider, cancellation, Worker interruption, audit failure and validation failure produce no success artifact or committed mutation. |
| UI projection | Raw tool JSON, Prompt text, credentials, internal IDs and hidden GM fields do not appear in normal player/creator views. |
| Pet boundary | A test extension can react to allowlisted public events and animate, while attempts to read project files or invoke tools are denied and audited. |

## 14. Explicit future extensions

The following may build on Runtime V2 but are not required to call the baseline complete:

- true multi-user collaboration and permissions;
- Agent group-chat presentation;
- image generation queues, visual identity anchors, maps and visual-book performance;
- marketplace, world-package publishing and Android synchronization;
- user-installable Mod/Plugin execution;
- animated OC combat cards and story-driven visual effects;
- unrestricted code workspace mode.

These extensions must reuse the kernel's project confinement, source, version, review, audit and fail-closed invariants. They may add capabilities; they may not bypass the baseline.

## 15. Confirmed Codex-style product baseline

The following direction was confirmed by the product owner on 2026-07-12. It is a committed product baseline, not evidence that the corresponding implementation is live:

1. **Right-side sliding History（右侧滑动式历史/回溯）**: inspect real project changes and restore through an auditable new head or branch.
2. **Automatic Agent allocation（智能体自动分配）**: the Steward（大管家）may create bounded child assignments under a durable Goal（目标）and Plan（计划）.
3. **Lower-right model selector（右下角模型切换）**: select the Provider（模型服务）and model profile for the next Run（运行）.
4. **Session branch（会话分支）**: editing or retrying earlier conversation creates an explicit alternative route without silently reverting committed project state.
5. **Desktop Pet（桌面宠物）**: an allowlisted presentation extension that reacts to public runtime events but has no Agent or project-write authority.
6. **Goal（目标）**: durable intent for long, delegated or resumable work, with acceptance criteria and evidence-backed completion.
7. **Plan（计划）**: a versioned, inspectable execution structure under a Goal, without exposing private Chain of Thought（思维链）.
8. **Handoff / Shared Memory（任务交接 / 共享记忆）**: explicit session-to-session and Agent-to-Agent communication with source identity and stale-source checks.
9. **Comments / Annotations（批注 / 注释）**: version-anchored review threads that can be assigned to an Agent and resolved through a reviewable Change Set（变更集）.

These capabilities are inspired by useful Codex product behavior, but NovelX does not commit to copying Codex internals or reproducing every Codex surface. NovelX owns the creative-domain semantics, permissions and presentation.

### 15.1 Feasibility and reduction rules

All nine capabilities are technically feasible within the accepted Rust Runtime V2（Rust 第二版运行时）+ Electron（桌面运行壳）architecture, but they do not have equal cost or dependency depth:

| Capability | Feasibility constraint | Permitted first complete scope | Unacceptable shortcut |
| --- | --- | --- | --- |
| Goal / Plan | Requires durable events, immutable revisions, evidence references and restart recovery | One owner Steward（大管家）, bounded child assignments and visible progress | Prompt（提示词）-only Goal/Plan text or UI（用户界面）-only progress |
| Automatic Agent allocation | Requires concurrency budget, cancellation, child scope, parent synthesis and write serialization | Independent bounded child Runs under one parent Goal | Unbounded swarm, hidden delegation or concurrent writes to one target |
| Handoff / Shared Memory | Requires stable session identity, source checkpoint and recipient policy | Direct one-to-one handoff and selected shared facts | Copying private transcripts into another Agent's Prompt（提示词） |
| Session branch | Requires immutable message ancestry and an explicit relation to project checkpoints | Conversation fork plus an explicit choice for already committed project effects | Destructive transcript rewrite or hidden project rollback |
| Model selector | Requires published model profiles, Provider（模型服务）capability metadata and per-Run audit | Project default plus session override applied to the next Run | Cosmetic selector, mid-Run switching or permission changes through model choice |
| History / rollback | Requires real checkpoints, diffs, leases and non-destructive restoration | Chronological committed-change drawer and restore-as-new-head | Fixture history, destructive reset or treating transcript rewind as project restore |
| Comments / annotations | Requires stable version anchors and relocation/outdated rules | Documents, artifacts and Change Set items first; other resource anchors may follow | Plain Markdown comments that silently move after edits |
| Desktop Pet | Requires a sanitized public event bus and resource limits | One packaged pet reacting to allowlisted status events | Raw Prompt（提示词）/file access, tool execution or arbitrary pet scripts |

“Can be reduced” means narrowing the first supported object types or presentation, never replacing the authoritative runtime contract with fake data, deterministic Agent behavior or non-durable state.

### 15.2 Implementation status at baseline freeze

Status date: 2026-07-12. This table is intentionally conservative and must be updated only from code, tests and real runtime evidence.

| Capability | Current evidence-backed status | Still required before product completion |
| --- | --- | --- |
| Goal / Plan | Rust workspace journal and aggregates exist; Runtime（运行时）commands and exact Run pin validation are in active integration and are not yet a complete desktop workflow | Finish compatibility/recovery gates, IPC（进程间通信）projection, desktop creation/inspection UI（用户界面）and real long-task acceptance |
| Automatic Agent allocation | Durable Assignment commands, exact child Run pins and a read-only structural recovery/quarantine barrier are live; missing child Runs are never guessed or recreated | Immutable ChildRunSpec, Provider-bind operational recovery, bounded concurrency, cancellation propagation, synthesis, cost controls and real multi-Agent cross-process acceptance |
| Handoff / Shared Memory | Legacy application records and the V2 contract exist | V2 authoritative communication objects, stale-source enforcement, recovery and UI |
| Session branch | Product semantics are defined | Durable branch aggregate, message ancestry, project-effect reconciliation and UI |
| Model selector | Legacy Provider（旧模型服务）settings exist and the V2 contract is defined | V2 profile registry, next-Run binding, effective-profile audit, lower-right UI（用户界面）and unavailable-model behavior |
| History / rollback | Existing project checkpoints/version services provide partial domain foundations | V2 event/diff projection, sliding drawer, lease-aware restore-as-new-head and end-to-end recovery evidence |
| Comments / annotations | Product and anchor contracts are defined | Durable annotation aggregate, relocation rules, Agent assignment, Change Set workflow and UI |
| Desktop Pet | Snow assets/background presentation exist separately from the Runtime V2 authority contract | Public sanitized event API, capability denial tests, resource/reduced-motion limits and packaged integration |

No row in this table is “fully complete”. The Runtime V2 Goal remains active until the conformance gates and the relevant desktop workflows pass.

## 16. Final Harness definition and staged connection boundary

### 16.1 Target definition

The NovelX Harness（运行框架）is the recoverable and auditable execution foundation between user intent and creative-domain side effects. Its final responsibility is to make real Provider（模型服务）-driven Agent（智能体）work controllable, resumable and verifiable across long tasks, multiple Agents and application restarts.

The foundation is complete only when it provides all of the following as authoritative runtime behavior:

- versioned Run, Goal, Plan, Step, ToolCall（工具调用）, Approval（批准）, Artifact（产物）and terminal-event identities;
- strict ToolCall/result pairing and local protocol validation before every Provider request;
- typed context compilation, real token budgeting, source receipts, compaction and retrieval without presenting partial reads as complete;
- deterministic orchestration for offsets, retries, timeouts, cancellation, recovery and side-effect scheduling, leaving semantic judgment to real Agents;
- Provider portability through published capability profiles and audited effective configuration;
- durable permission leases, Free / Assist policy, Change Set staging and exactly-once canonical commits;
- crash recovery from persisted events without replaying a completed external or project side effect;
- bounded child-Agent allocation, Handoff, Shared Memory and parent synthesis;
- structured errors and user-safe projections that preserve diagnostic evidence without exposing credentials, raw Prompt content, hidden GM facts or private reasoning;
- conformance evidence across real Provider tasks, long context, cancellation, crashes, malformed tools, stale versions and restart recovery.

Rust is the authoritative runtime implementation. Electron（桌面运行壳）+ React（用户界面框架）+ TypeScript（类型化脚本语言）remain the desktop host and presentation layer. Creative-domain modules remain responsible for worlds, OC（原创角色）, stories, documents, canon, graph facts, timelines, imports, playthroughs and checkpoints. The Harness coordinates those modules but does not invent or own their domain truth.

### 16.2 Connection sequence after the foundation

The product functions reconnect in dependency order. A later stage cannot compensate for an incomplete earlier contract:

1. **Kernel foundation（内核地基）**: protocol, event journal, state machine, Provider gateway, ToolCall ledger, context compiler, cancellation and startup recovery.
2. **Work control（工作控制）**: Goal, Plan, evidence, permissions, Free / Assist and Change Set transaction boundaries.
3. **Project inspection and editing（项目检索与编辑）**: real list/stat/glob/search/range-read tools, versioned writes and file/domain adapters.
4. **Long-term continuity（长期连续性）**: task memory, source receipts, project knowledge retrieval, Canonical Assertion（权威断言）, conflict detection and Checker（检查器）integration.
5. **Multi-Agent coordination（多智能体协调）**: bounded child Runs, Agent allocation, cancellation, Handoff, Shared Memory and serialized project writes.
6. **Desktop projections（桌面投影）**: Goal/Plan, model selector, activity/artifacts, session branches, comments and right-side History drawer backed only by authoritative state.
7. **Creative and player domain reconnection（创作与玩家领域重接）**: Steward, Writer（写手）, Checker, GM（游戏主持人）, world-to-story, import/decomposition and playthrough reconciliation through the same runtime gates.
8. **Extensions（扩展）**: Pet, images, maps, visual-book presentation, publishing, Android synchronization and later Mod/Plugin（模组/插件）work through allowlisted public capabilities.

The Legacy Pi Agent（旧版 Pi 智能体）path may remain during migration, but it cannot be treated as equivalent to Runtime V2（第二版运行时）unless it passes the same conformance contract. Product UI（用户界面）may be implemented in parallel for design validation, but it must remain labelled incomplete until the authoritative dependency is live.

### 16.3 Source and change control

This definition is constrained by:

- `docs/adr/ADR-0003-rust-runtime-v2-and-codex-reference.md` for the accepted Rust sidecar and selective Codex reference decision;
- `docs/runtime-v2/codex-reference-audit.md` for the reviewed Codex CLI（Codex 命令行）patterns and non-portable code-domain assumptions;
- `docs/runtime-v2/current-runtime-audit.md` for the legacy runtime's actual ownership, failure windows and migration seams;
- `docs/plans/2026-07-12-runtime-v2-foundation.md` for the implementation gates and reconnection order.

Any future change that moves Provider calls, permissions, canonical writes, recovery ownership or authoritative Run state outside the Rust Runtime V2 kernel requires a new ADR（架构决策记录）. Presentation changes and additional domain object types do not require redefining the Harness if they preserve these boundaries.

## 17. Three-layer reference strategy

Decision date: 2026-07-12.

NovelX will not replace Runtime V2 with an oh-my-pi fork. The accepted reference hierarchy is:

```text
Codex CLI（Codex 命令行）
  reliability, recovery, permission, audit and side-effect safety standard

oh-my-pi
  mature Agent feature and implementation reference

NovelX Runtime V2（第二版运行时）
  authoritative creative-domain implementation
```

“Reference” does not grant upstream code authority over canon, project writes, credentials or recovery. Every adopted component is wrapped by Runtime V2 identities, events, permissions, source receipts and failure behavior.

### 17.1 Accepted implementation sequence

| Stage | Goal | Primary reference | Acceptance boundary |
| --- | --- | --- | --- |
| 1 | Finish Assignment（智能体分配） wiring | Codex + current NovelX | Strict commands, exact child Run pin, non-forgeable identity, no duplicate child Run after restart |
| 2 | Complete startup recovery | Codex CLI | Restart never duplicates Provider calls, tools or project writes |
| 3 | Rebuild context and compaction | oh-my-pi Compaction（上下文压缩） | Tool pairs, sources, Goal/Plan/Assignment and pending approvals survive compaction |
| 4 | Build real multi-Agent scheduling | oh-my-pi Task（子任务） + Codex state machines | Bounded parallelism, cancellation, recovery, budgets and typed Artifacts（产物） |
| 5 | Build long-term memory and graph retrieval | mnemopi + NovelX Canon（正史） | Active retrieval; candidate memory cannot mutate canon |
| 6 | Upgrade tools | oh-my-pi Tools（工具系统） | Stable reads, search, chunking, version checks, timeouts and typed failures |
| 7 | Reconnect creative Agents | NovelX domain implementation | Steward, Writer, Checker and GM use the same authoritative runtime |
| 8 | Reconnect desktop workbench | oh-my-pi RPC（远程过程调用） + Codex UI（用户界面） | Real Goal, Plan, Assignment, model selection, branches, comments, activity and history |
| 9 | Stress and fault acceptance | all three | Long documents, multi-Agent, network loss, crashes and conflicts pass continuously |

### 17.2 oh-my-pi audit scope

The first audit is restricted to:

- `packages/agent/src/agent-loop.ts`;
- `packages/agent/src/compaction`;
- `packages/coding-agent/src/task`;
- `packages/coding-agent/src/session`;
- `packages/coding-agent/src/modes/rpc`;
- `packages/mnemopi`;
- `packages/ai`;
- Rust-native read, search and token-counting tools.

Every module audit must classify:

1. code that can be reused directly;
2. design that can only be referenced;
3. assumptions that conflict with NovelX;
4. state that must remain authoritative in Rust Runtime V2.

No whole-repository copy is permitted. Upstream code cannot receive direct Canonical Assertion（权威断言）, project commit or unrestricted filesystem authority.

### 17.3 Context and memory boundaries

oh-my-pi patterns to evaluate include Tool Protection（工具结果保护）, Branch Summary（分支摘要）, Compaction Summary（压缩摘要）, Handoff Document（任务交接文档）and File Operation Summary（文件操作摘要）.

NovelX must additionally preserve strict ToolCall/ToolResult pairing, current Goal/Plan/Assignment state, unresolved approvals and Change Sets, source versions and retrieval receipts, Canonical Assertions, world rules and conflict warnings. Acceptance includes million-scale source material chunking, repeated compaction and restart recovery.

mnemopi is only a candidate-memory layer. Raw sources, candidate facts, confirmed canon, story-scoped canon, OC variants, private task memory and project shared memory remain separate. Similarity and model confidence never promote a candidate fact to canon; Checker review and source-linked Canonical Assertion are required.

### 17.4 Evaluation discipline

oh-my-pi is preferred as a reference for Provider compatibility, feature-rich task coordination, experimental memory, tool breadth, Windows-aware native utilities and RPC embedding. Codex remains preferred for Run lifecycle, crash recovery, permission boundaries, side-effect safety, conservative protocol design and auditability.

Neither project is a complete NovelX foundation. Upstream README performance claims are not accepted evidence. All adopted behavior must be re-measured with NovelX's real Provider configurations, DeepSeek, long Chinese documents, multi-Agent workloads, cancellation, network failure, process termination and source conflicts.
