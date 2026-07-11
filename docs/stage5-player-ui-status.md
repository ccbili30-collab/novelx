# Stage 5 Player UI Status

Date: 2026-07-11

## Completed

- The titlebar now exposes separate Player Mode（玩家模式）, Agent Mode（Agent 模式）, and IDE Mode（IDE 模式）views.
- Player Mode can list and create Story Profiles（故事配置）, list active Start Profiles（起始模板）, create and select Playthroughs（游玩存档）, list immutable turns, and submit a player action through the real preload/main-process boundary.
- The reading surface renders only stored player actions, accepted prose, and allowlisted localized public state. GM resolution fields, evidence ids, audit fields, and raw state keys are not rendered.
- Canon divergence opens an explicit two-choice dialog: continue the pinned save or fork from current canon.
- Missing Provider and other fail-closed errors create no prose card.
- Manual CreativeWorkspace mutations now seal their Creative Commit before transaction completion. Without this fix, worlds and stories created through the visible IDE could never become a Story Profile baseline.
- A Playwright screenshot verifies the 1440x900 Player workbench and missing-Provider blocked state.

## Not Completed

- The GM Prompt remains candidate-only, so a real visible prose turn is still blocked pending Provider eval publication.
- Player UI does not yet expose archive/rename operations, detailed numerical-state configuration, or projection-backed long-play memory retrieval.
- Import source selection, parsing progress, candidate review, Change Set conversion, and Start Profile creation UI remain absent.
- No Windows installer or release was produced from this batch.

## Functional Reduction Risks

- Public state currently renders only location, health, stamina, luck, time, and weather. Unknown state keys are deliberately hidden instead of leaking internal identifiers.
- Large pinned contexts still fail closed rather than ranking and admitting a smaller relevant packet.
- Existing Playthrough cards are text-only; image and scene cards belong to the later asset stage and are not simulated here.
