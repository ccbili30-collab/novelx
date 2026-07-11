# Third-Party Notices

## webnovel-writer

NovelX Stage 4 was informed by the architecture and source layout of
[`lingfengQAQ/webnovel-writer`](https://github.com/lingfengQAQ/webnovel-writer),
reviewed at commit `59654ccaa17f240c5ae41fe51db9443284f8ca1f`.

- Upstream license: GNU General Public License v3.0 (GPL-3.0)
- NovelX license: GNU Affero General Public License v3.0 (AGPL-3.0-only)
- Incorporated direction: immutable creative-version manifests, rebuildable
  derived projections, projection execution records, and project health checks.
- Not incorporated in this batch: the upstream Python runtime, vector search,
  timeline projection, summary projection, or character-knowledge projection.

NovelX does not copy the upstream `.story-system` or `.webnovel` directory as a
second source of truth. Existing NovelX canonical SQLite tables remain authoritative.

