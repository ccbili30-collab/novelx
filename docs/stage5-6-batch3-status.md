# Stage 5-6 Batch 3 Status

Date: 2026-07-11

## Completed

- Schema v15 binds an optional Start Profile（起始模板）to a newly created Playthrough（游玩存档）.
- A Start Profile stores an opening situation, initial state, accepted source candidate ids, and excluded original-future event candidate ids.
- Candidate references must be accepted, belong to the selected parsed source, and carry a non-unknown rights attestation.
- Excluded future ids must reference accepted event candidates and cannot also seed the starting state.
- Draft Start Profiles cannot start a Playthrough. Active starts copy their initial state into an immutable Playthrough baseline.
- Existing Playthroughs migrate with null Start Profile and null initial state; no existing save is rewritten.
- Start Profile creation/listing and Playthrough creation with an optional Start Profile are exposed through typed Electron IPC（进程间通信）and the isolated preload API.

## Not Completed

- There is no visible Start Profile review or selection UI yet.
- The Decomposer Prompt（拆解器提示词）is still candidate-only and cannot run live before real Provider eval（模型服务评测）publication.
- The player `GM -> Writer -> Checker -> TurnValidator` pipeline is not yet routed through the audited Agent Worker subprocess.
- Main-process turn persistence, player card UI, action input, blocked state, and canon-divergence choice UI remain incomplete.
- No installer or release was produced from this batch.

## Functional Reduction Risks

- Start Profile generation is not automatic; the domain and IPC contracts exist, but no Agent or user-facing workflow creates them yet.
- Image import currently records verifiable metadata only. OCR（光学字符识别）and visual understanding are absent.
- Original future events are kept out of the initial state by explicit candidate separation, but a later story-scoped canon workflow must still govern whether any future event is imported into a new story.

## Verification

- TypeScript typecheck: passed.
- Vitest: 64 files, 261 tests passed.
- Production Electron build: passed.
- Electron Playwright: 30 passed, 1 real-Provider test skipped because no external test credential was supplied.
- `git diff --check`: passed.
- Plaintext API key scan: no match.
