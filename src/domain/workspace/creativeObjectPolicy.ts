export type ResourceDomain = "world" | "oc" | "story" | "graph" | "timeline" | "asset";

export type CreativeObjectKind =
  | "domain_root"
  | "world"
  | "oc"
  | "story"
  | "volume"
  | "chapter"
  | "location"
  | "faction"
  | "oc_variant"
  | "graph_view"
  | "timeline_view"
  | "asset_collection";

export interface CreativeObjectDescriptor {
  id: string;
  domain: ResourceDomain;
  kind: CreativeObjectKind;
  parentId: string | null;
}

const KIND_DOMAINS: Record<Exclude<CreativeObjectKind, "domain_root">, ResourceDomain> = {
  world: "world",
  oc: "oc",
  story: "story",
  volume: "story",
  chapter: "story",
  location: "world",
  faction: "world",
  oc_variant: "story",
  graph_view: "graph",
  timeline_view: "timeline",
  asset_collection: "asset",
};

const ALLOWED_PARENT_KINDS: Record<Exclude<CreativeObjectKind, "domain_root">, readonly CreativeObjectKind[]> = {
  world: ["domain_root"],
  oc: ["domain_root"],
  story: ["domain_root"],
  volume: ["story"],
  chapter: ["story", "volume"],
  location: ["world", "location"],
  faction: ["world", "faction"],
  oc_variant: ["story"],
  graph_view: ["domain_root"],
  timeline_view: ["domain_root"],
  asset_collection: ["domain_root"],
};

export function domainForObjectKind(kind: Exclude<CreativeObjectKind, "domain_root">): ResourceDomain {
  return KIND_DOMAINS[kind];
}

export function assertCreativeObjectPlacement(
  candidate: CreativeObjectDescriptor,
  currentObjects: readonly CreativeObjectDescriptor[],
): void {
  if (candidate.kind === "domain_root") {
    if (candidate.parentId !== null) throw policyError("RESOURCE_ROOT_PARENT_INVALID", "Domain roots cannot have a parent.");
    return;
  }

  if (domainForObjectKind(candidate.kind) !== candidate.domain) {
    throw policyError("RESOURCE_DOMAIN_KIND_MISMATCH", "The object kind does not belong to the selected domain.");
  }
  if (!candidate.parentId) {
    throw policyError("RESOURCE_PARENT_REQUIRED", "The object kind requires an owning parent.");
  }

  const byId = new Map(currentObjects.map((object) => [object.id, object]));
  const parent = byId.get(candidate.parentId);
  if (!parent) throw policyError("RESOURCE_PARENT_NOT_FOUND", "The owning parent does not exist.");
  if (!ALLOWED_PARENT_KINDS[candidate.kind].includes(parent.kind)) {
    throw policyError("RESOURCE_PARENT_KIND_INVALID", "The object kind cannot be owned by the selected parent.");
  }
  if (parent.kind === "domain_root" && parent.domain !== candidate.domain) {
    throw policyError("RESOURCE_PARENT_DOMAIN_INVALID", "The domain root does not match the object domain.");
  }

  const seen = new Set<string>();
  let cursor: CreativeObjectDescriptor | undefined = parent;
  while (cursor) {
    if (cursor.id === candidate.id) {
      throw policyError("RESOURCE_OWNERSHIP_CYCLE", "The ownership hierarchy cannot contain a cycle.");
    }
    if (seen.has(cursor.id)) {
      throw policyError("RESOURCE_OWNERSHIP_CYCLE", "The existing ownership hierarchy contains a cycle.");
    }
    seen.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
}

function policyError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
