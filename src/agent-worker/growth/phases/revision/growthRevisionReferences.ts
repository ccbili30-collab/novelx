import { Type } from "typebox";
import { z } from "zod";
import type { GrowthRevisionAuthority } from "../../../../shared/agentWorkerProtocol";

export const growthRevisionExistingRefPattern = "^@(resource|document|assertion|relation)[1-9][0-9]*$";
export const growthRevisionExistingRefSchema = z.string().regex(new RegExp(growthRevisionExistingRefPattern));
export const growthRevisionExistingRefParameter = Type.String({ pattern: growthRevisionExistingRefPattern });

export type GrowthRevisionTarget = GrowthRevisionAuthority["targets"][number];

export interface GrowthRevisionReference {
  ref: string;
  kind: GrowthRevisionTarget["kind"];
  label: string;
}

export function createGrowthRevisionReferenceCatalog(
  authority: GrowthRevisionAuthority,
): GrowthRevisionReference[] {
  const counts = new Map<GrowthRevisionTarget["kind"], number>();
  return authority.targets.map((target) => {
    const index = (counts.get(target.kind) ?? 0) + 1;
    counts.set(target.kind, index);
    return { ref: `@${target.kind}${index}`, kind: target.kind, label: targetLabel(target) };
  });
}

export function indexGrowthRevisionTargets(
  authority: GrowthRevisionAuthority,
): Map<string, GrowthRevisionTarget> {
  const references = createGrowthRevisionReferenceCatalog(authority);
  return new Map(references.map((reference, index) => [reference.ref, authority.targets[index]!]));
}

function targetLabel(target: GrowthRevisionTarget): string {
  switch (target.kind) {
    case "resource":
    case "document": return target.title;
    case "assertion": return `${target.subject} ${target.predicate}`.slice(0, 500);
    case "relation": return target.relationKind;
  }
}
