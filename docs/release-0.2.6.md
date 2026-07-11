# NovelX Desktop 0.2.6

## Agent project file tools

- Add first-class `list_project_directory`, `stat_project_file`, `glob_project_files`, `search_project_files`, and `read_project_file` tools.
- Keep the legacy aggregate file inspection tool for backward compatibility.
- Discover real directory contents before reading instead of guessing `README.md` or fixed project modules.
- Continue with directory listing or Glob (pattern matching) when a guessed file does not exist.
- Preserve `PROJECT_FILE_NOT_FOUND` and other safe file errors across Worker IPC instead of reporting every failure as missing authorization.
- Keep all real file writes and deletes behind Change Set review and version snapshots.

## Agent behavior

- Publish Steward Prompt 1.10.0, Runtime Profile 1.16.0, and Tool Policy 2.8.0.
- Require project-summary plans to read real discovered files rather than stopping after a directory listing.
- Prohibit describing a missing file as an unmounted or unauthorized project.
- Show audited file discovery and file reads in Agent activity artifacts.

## Validation

- 79 test files and 303 tests passed.
- Prompt publication verification passed.
- Real Provider evaluation passed 10/10 adversarial cases.
- Real Provider Electron E2E passed for a project with four Chinese Markdown files and no README.
- Electron E2E cleanup left no workspace Electron processes running.

## Known limitation

The Windows installer is not code signed and may display an Unknown publisher warning.
