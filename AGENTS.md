# NovelX Desktop Agent Rules

Scope: this repository and all descendants.

## First read

1. Read `CONTEXT.md` before scanning the repository.
2. Read only the task-routed documents listed in `CONTEXT.md`.
3. Treat `docs/product/novelx-desktop-product-requirements.md` as the long-term product source of truth.
4. Treat `docs/project/current-state-and-routes.md` and `notes/status/` as implementation-state evidence. Product requirements are not completion evidence.

## Product invariants

- NovelX Desktop is an Agent-native novel/world/OC creation workbench, not a renamed code editor or a prompt-only chatbot.
- A real Provider（模型服务）is required for any capability presented as live Agent, GM, Writer, Checker or image generation work. Missing configuration must fail closed.
- Rust Runtime V2 owns Run lifecycle, recovery, tool protocol, permissions, Provider effects and audit.
- NovelX Domain Runtime owns worlds, OCs, stories, documents, relations, Canon, graph, versions, playthroughs and domain validation.
- Renderer code may project state and collect decisions, but may not invent completion, canon, permissions, tool results or story outcomes.
- All formal project mutations use versioned domain operations and Change Sets. Assist requires user confirmation; Free remains policy-bound and auditable.
- Documents/raw sources, Canonical Assertions and graph projections remain separate layers.
- Creator Lens and Player Lens must never be conflated.
- Internal runtime files, Prompt text, raw JSON, credentials and hidden player facts are not default user-facing content.

## Development routes

- `codex/long-term-main`: long-term foundation and full product development.
- `codex/hackathon-10day`: time-boxed real visual creation/play loop; only P0 blockers.
- Do not merge the hackathon branch into long-term development without a post-event architecture and data-compatibility review.
- A2.2 Runtime foundation is frozen unless the user explicitly reopens it.

## Work style

- Windows first: PowerShell, Windows paths, UTF-8.
- One execution Agent by default. Parallel work requires non-overlapping files and true time savings.
- Do not edit files owned by another Agent. Do not run duplicate full test suites.
- Use real code, logs, tests, official documentation or upstream source for factual claims.
- Do not modify product behavior, public protocol, schema, permissions or migration semantics without a product decision.
- Do not store plaintext secrets in source, tests, documentation, Git history or logs.
- Preserve user changes. Never use destructive Git cleanup to make a worktree look clean.

## Completion report

Every completed batch must state:

- what was actually implemented;
- what commands ran and whether a real Provider was used;
- what remains incomplete or frozen;
- current risks and recovery entry points;
- branch and commit hash when committed.

Never describe a partial UI, schema-only change, fixture path or design document as a complete NovelX feature.
