import { createHash } from "node:crypto";
import { Type } from "typebox";
import { z } from "zod";
import {
  generateImageArgsSchema,
  proposeChangeSetArgsSchema,
  proposeChangeSetResultSchema,
  type GenerateImageArgs,
  type ProposeChangeSetArgs,
} from "../../shared/agentWorkerProtocol";

const identifier = z.string().trim().min(1).max(240);

export const growthWorldMapBriefSchema = z.object({
  title: z.string().trim().min(1).max(240),
  prompt: z.string().trim().min(1).max(4_000),
}).strict();

export const growthWorldMapBriefParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 240 }),
  prompt: Type.String({ minLength: 1, maxLength: 4_000 }),
}, { additionalProperties: false });

export type GrowthWorldMapBriefErrorCode =
  | "GROWTH_WORLD_MAP_BRIEF_INVALID"
  | "GROWTH_WORLD_MAP_SOURCE_INVALID";

export interface TrustedGrowthWorldMapSources {
  worldResourceId: string;
  sourceVersionIds: string[];
}

export function deriveGrowthWorldMapSources(
  proposalInput: unknown,
  proposalResult: unknown,
): TrustedGrowthWorldMapSources {
  const proposal = proposeChangeSetArgsSchema.safeParse(proposalInput);
  const result = proposeChangeSetResultSchema.safeParse(proposalResult);
  if (!proposal.success || !result.success || result.data.status !== "committed") {
    throw worldMapError("GROWTH_WORLD_MAP_SOURCE_INVALID");
  }
  const worldItems = proposal.data.items.filter((item) => item.kind === "resource.put"
    && item.payload.type === "world" && item.payload.objectKind === "world" && item.payload.create && item.payload.state === "active");
  if (worldItems.length !== 1) throw worldMapError("GROWTH_WORLD_MAP_SOURCE_INVALID");
  const worldItem = worldItems[0]!;
  const worldPayload = worldItem.payload as { resourceId: string };
  const settingItems = proposal.data.items.filter((item) => item.kind === "creative_document.put"
    && item.payload.resourceId === worldPayload.resourceId && item.payload.kind === "setting"
    && item.payload.create && item.payload.state === "active");
  if (settingItems.length !== 1) throw worldMapError("GROWTH_WORLD_MAP_SOURCE_INVALID");
  const setting = settingItems[0]!;
  const settingPayload = setting.payload as { documentId: string };
  const documentItems = proposal.data.items.filter((item) => item.kind === "document.put"
    && item.payload.resourceId === worldPayload.resourceId && item.payload.creativeDocumentId === settingPayload.documentId);
  if (documentItems.length !== 1) throw worldMapError("GROWTH_WORLD_MAP_SOURCE_INVALID");
  const outputs = result.data.committedOutputs ?? [];
  const resourceOutputs = outputs.filter((output) => output.itemId === worldItem.id && output.kind === "resource_revision");
  const documentOutputs = outputs.filter((output) => output.itemId === documentItems[0]!.id && output.kind === "document_version");
  if (resourceOutputs.length !== 1 || documentOutputs.length !== 1) throw worldMapError("GROWTH_WORLD_MAP_SOURCE_INVALID");
  const resourceOutput = resourceOutputs[0]!;
  const documentOutput = documentOutputs[0]!;
  return {
    worldResourceId: worldPayload.resourceId,
    sourceVersionIds: [resourceOutput.outputId, documentOutput.outputId],
  };
}

export function compileGrowthWorldMapBrief(
  input: unknown,
  trusted: { cycleId: string; sources: TrustedGrowthWorldMapSources },
): GenerateImageArgs {
  const brief = growthWorldMapBriefSchema.safeParse(input);
  if (!brief.success) throw worldMapError("GROWTH_WORLD_MAP_BRIEF_INVALID");
  if (!identifier.safeParse(trusted.cycleId).success
    || !identifier.safeParse(trusted.sources.worldResourceId).success
    || trusted.sources.sourceVersionIds.length !== 2
    || trusted.sources.sourceVersionIds.some((versionId) => !identifier.safeParse(versionId).success)) {
    throw worldMapError("GROWTH_WORLD_MAP_SOURCE_INVALID");
  }
  return generateImageArgsSchema.parse({
    title: brief.data.title,
    purpose: "world_map",
    prompt: brief.data.prompt,
    sourceResourceIds: [trusted.sources.worldResourceId],
    sourceVersionIds: [...trusted.sources.sourceVersionIds],
    idempotencyKey: `growth-world-map-${createHash("sha256").update(trusted.cycleId, "utf8").digest("hex").slice(0, 32)}`,
  });
}

function worldMapError(code: GrowthWorldMapBriefErrorCode): Error & { code: GrowthWorldMapBriefErrorCode } {
  return Object.assign(new Error("Growth world map source is invalid."), { code });
}
