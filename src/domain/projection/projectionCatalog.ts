export const projectionKinds = [
  "semantic_graph",
  "timeline",
  "retrieval",
  "summary",
  "character_knowledge",
] as const;

export type ProjectionKind = typeof projectionKinds[number];

export interface ProjectionCapability {
  kind: ProjectionKind;
  label: string;
  status: "implemented" | "planned";
  canonical: false;
  rebuildable: true;
}

const capabilities: readonly ProjectionCapability[] = Object.freeze([
  capability("semantic_graph", "Semantic Graph（语义图谱）", "implemented"),
  capability("timeline", "Timeline（时间线）", "implemented"),
  capability("retrieval", "Retrieval Index（检索索引）", "implemented"),
  capability("summary", "Summary（摘要）", "implemented"),
  capability("character_knowledge", "Character Knowledge（角色认知）", "implemented"),
]);

export function listProjectionCapabilities(): ProjectionCapability[] {
  return capabilities.map((entry) => ({ ...entry }));
}

export function getProjectionCapability(kind: string): ProjectionCapability | null {
  const entry = capabilities.find((candidate) => candidate.kind === kind);
  return entry ? { ...entry } : null;
}

function capability(
  kind: ProjectionKind,
  label: string,
  status: ProjectionCapability["status"],
): ProjectionCapability {
  return { kind, label, status, canonical: false, rebuildable: true };
}
