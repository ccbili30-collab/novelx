# NovelX Desktop 0.2.5

## User-visible changes

- Add a real `文件夹内容` panel that lists the active project's disk folders and files without depending on the Agent.
- Keep `文件夹内容` open by default and `活动与产物` closed by default; both sections can be opened or closed independently and remember their state per project.
- Support expandable directories plus text and binary file previews while keeping `.novax`, `.git`, and `node_modules` private.
- Add the `cloude` light theme with the supplied paper surface, coral accent, serif UI typography, and dedicated code font.
- Fix Agent interruption when a large real-project file overview applies IPC (inter-process communication) backpressure.

## Reliability

- Worker sends now distinguish normal IPC backpressure from actual delivery failure.
- Add bounded structured Worker lifecycle diagnostics without storing prompts, project contents, model responses, or API keys.
- Add regression coverage for an approximately 239 KB project-file response.

## Validation

- TypeScript typecheck passed.
- 78 test files and 299 tests passed.
- Production build passed.
- Project-files panel and theme Electron E2E passed.

## Known limitation

The Windows installer is not code signed and may display an Unknown publisher warning.
