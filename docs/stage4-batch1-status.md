# Stage 4 Batch 1 Status

Date: 2026-07-11

## Completed

- Creative Commit（创作提交）uses the existing checkpoint ID as its stable identity.
- Sealed manifests are deterministically ordered, SHA-256 hashed, and protected by SQLite immutable triggers.
- Existing pre-upgrade checkpoints are backfilled as unsealed history; NovelX does not invent sealing or projection success.
- Change Set（变更集）commits and manual stable edits seal their canonical commit before transaction completion.
- Projection Log（投影日志）records semantic-graph attempts, input/output hashes, status, and safe failure codes.
- Semantic Graph Projection（语义图谱投影）runs after canonical commit; failure does not roll back accepted facts.
- Project Doctor（项目体检）checks commit integrity and current branch-head graph projection state.
- Agent Mode（Agent 模式）and IDE Mode（IDE 模式）both expose the same read-only Project Doctor report.
- The renderer does not display commit IDs, SQL, internal exceptions, database paths, or projection error codes.

## Explicitly Deferred

- Projection replay and automatic repair UI
- Timeline Projection（时间线投影）
- Retrieval Projection（检索投影）and vector search
- Summary Projection（摘要投影）
- Character Knowledge（角色认知）
- Long-term memory compaction and retrieval admission policy
- Upstream Python Runtime（Python 运行时）

This batch is infrastructure for Stage 4. It is not a complete Stage 4 closure and must not be presented as one.

## Verification

- `npm.cmd run typecheck`
- targeted Vitest contract, commit, projection, and doctor tests
- `npm.cmd run build`
- targeted Electron Playwright Project Doctor test

- TypeScript typecheck: passed
- Vitest: 49 files, 233 tests passed
- Electron Playwright: 30 passed, 1 real-Provider test skipped because no external test credential was supplied
- Production build: passed
