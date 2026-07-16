import type { ResourceRecord } from "./resourceRepository";

export type CreativeRelationKind = "uses_world" | "uses_oc" | "variant_of" | "related_to";

export type CreativeRelationPolicyErrorCode =
  | "RELATION_SELF_REFERENCE"
  | "RELATION_SOURCE_KIND_INVALID"
  | "RELATION_TARGET_KIND_INVALID"
  | "RELATION_ENDPOINT_KIND_INVALID";

type RelationEndpoint = Pick<ResourceRecord, "id" | "type" | "objectKind">;

/**
 * Single executable authority for creative relation endpoint semantics.
 * Repositories, Gateways, and compilers must not reinterpret these rules.
 */
export function assertCreativeRelationAllowed(input: {
  kind: CreativeRelationKind;
  source: RelationEndpoint;
  target: RelationEndpoint;
}): void {
  const { kind, source, target } = input;
  if (source.id === target.id) {
    throw relationPolicyError("RELATION_SELF_REFERENCE", "A resource cannot relate to itself.");
  }
  switch (kind) {
    case "uses_world":
      assertNarrativeSource(source, "world");
      if (target.objectKind !== "world") {
        throw relationPolicyError("RELATION_TARGET_KIND_INVALID", "A world reference must target a world.");
      }
      return;
    case "uses_oc":
      assertNarrativeSource(source, "OC");
      if (target.objectKind !== "oc") {
        throw relationPolicyError("RELATION_TARGET_KIND_INVALID", "An OC reference must target a base OC.");
      }
      return;
    case "variant_of":
      if (source.objectKind !== "oc_variant") {
        throw relationPolicyError("RELATION_SOURCE_KIND_INVALID", "Only an OC variant can declare a base OC.");
      }
      if (target.objectKind !== "oc") {
        throw relationPolicyError("RELATION_TARGET_KIND_INVALID", "An OC variant must target a base OC.");
      }
      return;
    case "related_to":
      if (source.objectKind === "domain_root" || target.objectKind === "domain_root") {
        throw relationPolicyError("RELATION_ENDPOINT_KIND_INVALID", "Domain roots cannot be related as creative objects.");
      }
  }
}

function assertNarrativeSource(source: RelationEndpoint, targetLabel: "world" | "OC"): void {
  if (source.type !== "story" || !["story", "volume"].includes(source.objectKind)) {
    throw relationPolicyError(
      "RELATION_SOURCE_KIND_INVALID",
      `Only a story or story volume can use a ${targetLabel}.`,
    );
  }
}

function relationPolicyError(
  code: CreativeRelationPolicyErrorCode,
  message: string,
): Error & { code: CreativeRelationPolicyErrorCode } {
  return Object.assign(new Error(message), { code });
}
