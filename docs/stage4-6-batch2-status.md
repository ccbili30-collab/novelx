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
- Player runtime currently stops at an internal `GM -> Writer -> Checker -> TurnValidator` boundary. Audited worker subprocess execution, validated turn persistence, and player UI are not implemented.
- Decomposer（拆解器）已具备真实 Provider（模型服务提供方）运行边界、候选 Prompt v1 完整性门、来源分块约束、失败任务落库和不可直接写入正史的候选仓库；Prompt 仍是 candidate（候选），尚未经过真实 Provider eval（评测），因此 live（正式运行）路径继续 fail-closed（失败关闭）。
- Decomposer candidate review UI（拆解候选审核界面）、接受候选到 Change Set（变更集）的转换、Start Profile（起始模板）生成仍未实现。
- TXT / Markdown / DOCX / EPUB / image metadata（文本 / Markdown / Word / 电子书 / 图片元数据）均已有本地解析器和稳定来源定位器。图片尚无 OCR（光学字符识别）或视觉理解，不会虚构图片内容。
- Stage 5 and Stage 6 are therefore not complete product loops.

## Functional Reduction Risks

- Extractive summaries are reliable but less useful than model-assisted summaries.
- Timeline and character knowledge require explicit structured assertions; prose-only facts are deliberately omitted rather than guessed.
- FTS5 trigram search is lexical, not semantic vector retrieval.
- Playthrough persistence exists, but users cannot operate it from the desktop UI yet.

## Verification

- TypeScript typecheck: passed
- Vitest: 63 files, 258 tests passed
- Production Electron build: passed
- Electron Playwright: 30 passed, 1 real-Provider test skipped because no external test credential was supplied
- The Provider-missing fail-closed E2E had one Windows child-process crash during the first full run; it then passed three isolated repetitions and the complete rerun.

## Goal Continuation: Player Runtime Boundary

- Added typed Electron IPC for Story Profile creation, Playthrough creation, canon divergence inspection, and explicit resolution.
- Added candidate GM Prompt v1 with a fixed SHA-256 identity and a separate publication gate.
- Added a real RuntimeAdapter boundary for structured GM resolution. Candidate prompts are rejected before any Provider call.
- Added the governed `GM -> Writer -> Checker -> TurnValidator` player pipeline as an internal boundary. It is not yet wired through the audited worker subprocess, main-process persistence, or player UI, so it is not a playable closed loop.
- Added schema v14 immutable Decomposer candidate revisions, human review decisions, and Start Profile storage foundation. Accepted candidates remain non-canonical until a later Change Set applies them.
- Added Turn Validator binding GM resolution, Writer output, evidence IDs, and Checker outcome.
- GM Prompt has not yet passed real Provider evaluation and is not active; player live mode therefore remains blocked rather than simulated.
- Latest verification: TypeScript passed; 63 Vitest files / 258 tests passed; production build passed; Electron Playwright 30 passed / 1 real-Provider test skipped.
