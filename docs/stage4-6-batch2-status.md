# Stage 4-6 Batch 2 Status

Date: 2026-07-11

## Completed In This Batch

- Schema v11: immutable projection artifacts and an honest projection capability catalog.
- Timeline Projection（时间线投影）from explicit structured temporal assertions only.
- Retrieval Projection（检索投影）using SQLite FTS5 trigram indexing and BM25 ranking; no string-scan fallback.
- Summary Projection（摘要投影）using auditable extractive first-paragraph summaries.
- Character Knowledge（角色认知）from explicit observed/told/inferred/unknown records only.
- Schema v12: Story Profile（故事配置）, OC bindings, append-only Playthrough（游玩存档）, immutable turns, and reconciliation decisions.
- Canon reconciliation: continue pinned old canon or fork an empty new playthrough from current sealed canon. No automatic bridge fiction.
- Schema v13: local Source Library（来源库）, immutable chunks, import jobs, and decomposition candidate storage.
- Local TXT and Markdown parsing with UTF-8/GB18030 decoding, stable line locators, and immutable chunks.

## Not Completed

- Memory-aware relevance and token admission is not yet wired into every Agent request.
- The real player GM/Writer/Validator runtime and player UI are not implemented in this batch.
- DOCX, EPUB, and image parsers are not implemented.
- Decomposer（拆解器）Provider runtime, candidate review UI, and Start Profile（起始模板）generation are not implemented.
- Stage 5 and Stage 6 are therefore not complete product loops.

## Functional Reduction Risks

- Extractive summaries are reliable but less useful than model-assisted summaries.
- Timeline and character knowledge require explicit structured assertions; prose-only facts are deliberately omitted rather than guessed.
- FTS5 trigram search is lexical, not semantic vector retrieval.
- Playthrough persistence exists, but users cannot operate it from the desktop UI yet.

## Verification

- TypeScript typecheck: passed
- Vitest: 57 files, 244 tests passed
- Production Electron build: passed
- Electron Playwright: 30 passed, 1 real-Provider test skipped because no external test credential was supplied
- The Provider-missing fail-closed E2E had one Windows child-process crash during the first full run; it then passed three isolated repetitions and the complete rerun.
