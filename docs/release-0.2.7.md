# NovelX Desktop 0.2.7

## Highlights

- Snow is now the default centered workspace background.
- Settings now support Snow, a custom local background image, or no background.
- Added complete project-file tools for listing, matching, searching, inspecting, and range reading.
- Added durable source-linked task notes for long project-reading tasks.
- Added Harness-controlled chunk offsets and context compaction for files larger than one model request.
- Fixed tool-call/result pairing after context compaction.
- Added contiguous source-range and real DeepSeek long-reading regression coverage.

## Reliability

- Deterministic tool outcomes now come from the Harness execution trace rather than model-authored audit fields.
- Provider structured-tool correction attempts increased while preserving fail-closed behavior.
- Workspace schema 20 adds persistent Agent task notes and supports migration from existing workspaces.
- Test Electron cleanup remains scoped to recorded test process trees.

## Known Limit

- Custom backgrounds are stored on the current device and are limited to 2 MB.
- Durable notes and source coverage are verified, but final prose can still require Checker validation for semantic agreement with every note.
