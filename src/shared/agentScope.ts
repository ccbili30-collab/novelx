import type { WorkspaceSnapshot } from "./ipcContract";

const MAX_AGENT_SCOPES = 100;

export function resolveAgentScopeResourceIds(
  workspace: WorkspaceSnapshot | null,
  selectedResourceId: string | null,
): string[] {
  if (selectedResourceId) return [selectedResourceId];
  if (!workspace) return [];

  const projectResources = workspace.resources.filter((resource) => resource.objectKind !== "domain_root");
  if (projectResources.length <= MAX_AGENT_SCOPES) return projectResources.map((resource) => resource.id);

  const rootIds = new Set(workspace.resources
    .filter((resource) => resource.objectKind === "domain_root")
    .map((resource) => resource.id));
  return projectResources
    .filter((resource) => resource.parentId !== null && rootIds.has(resource.parentId))
    .slice(0, MAX_AGENT_SCOPES)
    .map((resource) => resource.id);
}
