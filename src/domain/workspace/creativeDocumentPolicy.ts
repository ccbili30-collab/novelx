import type { CreativeObjectKind } from "./creativeObjectPolicy";

export type CreativeDocumentKind =
  | "prose"
  | "setting"
  | "character_profile"
  | "location_profile"
  | "faction_profile"
  | "knowledge_note"
  | "style_guide"
  | "writing_constraints";

const allowedOwnerKinds: Record<CreativeDocumentKind, readonly CreativeObjectKind[]> = {
  prose: ["story", "volume", "chapter"],
  character_profile: ["oc", "oc_variant"],
  location_profile: ["location"],
  faction_profile: ["faction"],
  setting: ["world", "story"],
  knowledge_note: [
    "world", "oc", "story", "volume", "chapter", "location", "faction", "oc_variant",
    "graph_view", "timeline_view", "asset_collection",
  ],
  style_guide: [
    "world", "oc", "story", "volume", "chapter", "location", "faction", "oc_variant",
    "graph_view", "timeline_view", "asset_collection",
  ],
  writing_constraints: [
    "world", "oc", "story", "volume", "chapter", "location", "faction", "oc_variant",
    "graph_view", "timeline_view", "asset_collection",
  ],
};

export function assertCreativeDocumentOwnerAllowed(
  kind: CreativeDocumentKind,
  ownerKind: CreativeObjectKind,
): void {
  if (!allowedOwnerKinds[kind].includes(ownerKind)) {
    throw policyError("DOCUMENT_KIND_OWNER_INVALID", "The document kind is incompatible with its owner.");
  }
}

function policyError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
