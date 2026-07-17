# Failed image placeholder semantics

## Decision

When an authorized Free creation Run has already committed its textual Change Set and its final image request fails with a known no-Asset outcome, NovelX continues the Run and publishes a failed image Artifact.

The failed Artifact is deliberately false-valued:

- `status = "failed"`;
- `assetId = null`;
- `thumbnailUrl = null`;
- no Image Asset, managed image URL, Canon fact, or ready state is invented;
- the bundled failure illustration is Renderer chrome only and is never persisted as generated project content.

The same bundled illustration is used for failed world maps, character portraits, scenes, and user-requested Growth illustrations. Text and other committed project content remain available.

## Runtime boundary

The Steward continuation is limited to `IMAGE_GENERATION_FAILED` and `IMAGE_PROVIDER_REQUIRED` after a committed Free Change Set. Cancellation, timeout, protocol failure, reconciliation-required, or outcome-unknown states remain terminal and fail closed.

Independent Growth illustration batches already persist each failed item separately and continue other items. They use the same Renderer placeholder without manufacturing an Asset.

## Contract invariant

Renderable Agent image Artifacts (`ready` or `stale`) require both a managed `assetId` and `thumbnailUrl`. Non-renderable states (`queued`, `generating`, or `failed`) must expose neither. This prevents the placeholder from being confused with generated content.

## Compatibility

This is an additive nullable-field change to the internal Agent Artifact projection. It requires no database migration and does not alter image Job or Image Asset persistence.
