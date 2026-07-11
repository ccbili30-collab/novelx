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

## 12. Acceptance metrics

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

## 13. Explicit future extensions

The following may build on Runtime V2 but are not required to call the baseline complete:

- true multi-user collaboration and permissions;
- Agent group-chat presentation;
- image generation queues, visual identity anchors, maps and visual-book performance;
- marketplace, world-package publishing and Android synchronization;
- user-installable Mod/Plugin execution;
- animated OC combat cards and story-driven visual effects;
- unrestricted code workspace mode.

These extensions must reuse the kernel's project confinement, source, version, review, audit and fail-closed invariants. They may add capabilities; they may not bypass the baseline.
