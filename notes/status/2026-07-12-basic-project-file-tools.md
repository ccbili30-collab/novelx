# Basic project file tools publication status

Implemented the Steward-facing contract for five composable read-only project tools:

- `list_project_directory`
- `stat_project_file`
- `glob_project_files`
- `search_project_files`
- `read_project_file`

The Steward plan state machine now permits repeated basic file operations so one run can discover and read multiple files. Prompt candidate `novax.steward@1.10.0` requires list/glob discovery before uncertain reads, treats `PROJECT_FILE_NOT_FOUND` as a discovery fallback rather than an authorization failure, and covers projects with Chinese Markdown filenames and no README.

Version set prepared for publication evaluation:

- Steward Prompt candidate: `1.10.0`
- Writer Prompt candidate: `1.5.0` (unchanged content, re-certification only)
- Checker Prompt candidate: `1.6.0` (unchanged content, re-certification only)
- Steward runtime profile: `1.16.0`
- Steward tool policy: `2.8.0`

Offline verification completed. The real Provider publication evaluation passed all 10 adversarial cases with `openai-compatible` / `deepseek-v4-flash`, including directory discovery followed by reads of four Chinese Markdown files in a project without `README.md`.

Published evidence:

- Report: `notes/evidence/novax-desktop-prompt-evals/prompt-eval-2026-07-11T17-49-29-216Z.json`
- Report SHA-256: `5553370e327e6d325f4b23e579919b90e6e91ae7ea1dfe42095b422972d95e4c`
- Steward Prompt SHA-256: `2eef4a0466cd0121244106dcc87f2cbbc67c38686dde94a923d1261e5864884a`

Steward `1.10.0`, Writer `1.5.0`, and Checker `1.6.0` are active. The previous published versions remain available for rollback.
