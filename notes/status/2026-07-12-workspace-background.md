# 2026-07-12 Workspace background

Implemented Snow as the default centered workspace background using the bundled `snow.svg` asset.

Settings now provide three choices: Snow, custom image, and none. Custom images accept PNG, JPEG, WebP, GIF, and SVG up to 2 MB and are stored on the current device. The background is centered, keeps its aspect ratio, and does not tile.

The background is shown in the Agent mode conversation workspace and the IDE mode central canvas. Rails remain opaque; conversation surfaces use a translucent layer to preserve text readability.

Verification:

- Background preference unit tests passed.
- Electron visual E2E verified default Snow, centered/no-repeat rendering, custom upload, none, and persistence after restart.
- Full suite: 81 test files and 315 tests passed.
- TypeScript typecheck, Electron build, and `git diff --check` passed.

Known limit: custom images larger than 2 MB are rejected because this version persists them in local application storage rather than a dedicated asset store.
