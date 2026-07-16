import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChangeSetRepository } from "../../src/domain/changeSet/changeSetRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace, type WorkspaceDatabase } from "../../src/domain/workspace/workspaceRepository";
import { assertGrowthRepairProposalAllowed } from "../../src/main/growth/phases/closure/growthRepairTargetPolicy";

const opened: WorkspaceDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  for (const workspace of opened.splice(0)) workspace.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Growth Repair target policy", () => {
  it("preserves the pinned resource type, object kind, and parent identity", () => {
    const boundary = createSelectedBoundary();

    expect(() => assertGrowthRepairProposalAllowed({
      ...boundary.input,
      proposal: {
        summary: "Attempt to reparent the selected world.",
        items: [{
          id: "reparent-world", dependsOn: [], kind: "resource.put",
          payload: {
            resourceId: boundary.worldId, create: false, type: "world", objectKind: "world",
            title: "Reparented world", parentId: boundary.locationId, state: "active", sortOrder: 0,
          },
        }],
      },
    })).toThrow(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));
  });

  it("allows a legal missing relation only when both selected endpoints satisfy the domain policy", () => {
    const boundary = createSelectedBoundary();

    expect(() => assertGrowthRepairProposalAllowed({
      ...boundary.input,
      proposal: {
        summary: "Connect the selected world and harbor.",
        items: [{
          id: "connect-selected", dependsOn: [], kind: "creative_relation.put",
          payload: {
            relationId: "connect-selected", create: true, relationKind: "related_to",
            sourceResourceId: boundary.worldId, targetResourceId: boundary.locationId, state: "active",
          },
        }],
      },
    })).not.toThrow();

    expect(() => assertGrowthRepairProposalAllowed({
      ...boundary.input,
      proposal: {
        summary: "Attempt an invalid world binding.",
        items: [{
          id: "invalid-world-binding", dependsOn: [], kind: "creative_relation.put",
          payload: {
            relationId: "invalid-world-binding", create: true, relationKind: "uses_world",
            sourceResourceId: boundary.worldId, targetResourceId: boundary.locationId, state: "active",
          },
        }],
      },
    })).toThrow(expect.objectContaining({ code: "GROWTH_BINDING_INVALID" }));
  });
});

function createSelectedBoundary() {
  const workspace = createWorkspace();
  const resources = new ResourceRepository(workspace);
  const changes = new ChangeSetRepository(workspace);
  const rootsByType = new Map(resources.listCurrent().map((resource) => [resource.type, resource]));
  let worldId = "";
  let locationId = "";
  const proposed = changes.propose({
    idempotencyKey: "repair-policy-objects", mode: "free", summary: "Create selected repair objects",
  });
  const checkpointId = changes.commit(proposed.id, "Create selected repair objects", (createdCheckpointId) => {
    worldId = resources.putRevision({
      checkpointId: createdCheckpointId, type: "world", objectKind: "world", title: "Selected world",
      parentId: rootsByType.get("world")!.id, state: "active", sortOrder: 0,
    });
    locationId = resources.putRevision({
      checkpointId: createdCheckpointId, type: "world", objectKind: "location", title: "Selected harbor",
      parentId: worldId, state: "active", sortOrder: 0,
    });
  });
  return {
    worldId,
    locationId,
    input: {
      workspace,
      checkpointId,
      receiptLinks: [
        { targetKind: "resource" as const, targetId: worldId, targetVersionId: "selected-world-version" },
        { targetKind: "resource" as const, targetId: locationId, targetVersionId: "selected-location-version" },
      ],
      targetEvidenceIds: ["selected-world-version", "selected-location-version"],
    },
  };
}

function createWorkspace(): WorkspaceDatabase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-growth-repair-policy-"));
  roots.push(root);
  const workspace = openWorkspace(root);
  opened.push(workspace);
  return workspace;
}
