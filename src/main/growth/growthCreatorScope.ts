import type { ResourceRecord } from "../../domain/workspace/resourceRepository";

export interface AuthorizedGrowthResource {
  resource: ResourceRecord;
  scopeRootId: string;
}
/** Resolves Creator-authorized descendants without trusting Renderer-supplied scope. */
export function resolveAuthorizedGrowthResources(
  resources: readonly ResourceRecord[],
  authorizedRootIds: readonly string[],
): Map<string, AuthorizedGrowthResource> {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const roots = new Set(authorizedRootIds);
  const result = new Map<string, AuthorizedGrowthResource>();
  for (const resource of resources) {
    let current: ResourceRecord | undefined = resource;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (roots.has(current.id)) {
        result.set(resource.id, { resource, scopeRootId: current.id });
        break;
      }
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return result;
}
