import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../../src/domain/asset/imageAssetStore";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { CheckpointRepository } from "../../src/domain/version/checkpointRepository";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../../src/domain/workspace/creativeRelationRepository";
import { DocumentRepository } from "../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { exportLatestGrowthWorldPackage } from "../e2e/support/growthWorldPackageExport";

let root = "";
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = ""; });

describe("latest Growth world-package export", () => {
  it("atomically replaces readable committed documents, graph and real/failed image projections", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-world-package-export-"));
    const workspacePath = path.join(root, "workspace");
    const outputDirectory = path.join(root, "artifacts", "latest-growth-world-package");
    const placeholder = path.join(root, "failed.jpg");
    fs.writeFileSync(placeholder, "failed-image-placeholder", "utf8");
    const workspace = openWorkspace(workspacePath);
    const checkpoints = new CheckpointRepository(workspace);
    const resources = new ResourceRepository(workspace);
    const creativeDocuments = new CreativeDocumentRepository(workspace);
    const documents = new DocumentRepository(workspace);
    const roots = new Map(resources.listCurrent().map((resource) => [resource.type, resource.id]));
    const branch = checkpoints.getActiveBranch();
    const checkpointId = checkpoints.appendCheckpoint(branch.id, "world package fixture");
    const world = resources.putRevisionWithReceipt({
      checkpointId, type: "world", objectKind: "world", title: "潮汐王国",
      parentId: roots.get("world")!, state: "active",
    });
    const location = resources.putRevisionWithReceipt({
      checkpointId, type: "world", objectKind: "location", title: "雾港",
      parentId: world.resourceId, state: "active",
    });
    const documentId = creativeDocuments.putRevision({
      checkpointId, resourceId: world.resourceId, kind: "setting", title: "世界设定", state: "active",
    });
    const versionId = documents.putVersion({
      resourceId: world.resourceId, creativeDocumentId: documentId, checkpointId,
      content: "潮汐决定王国的历法、贸易与继承秩序。", authorKind: "agent",
    });
    new AssertionRepository(workspace).putVersion({
      assertionId: "tide-rule", checkpointId, scopeType: "world", scopeId: world.resourceId,
      subject: "潮汐", predicate: "governs", object: { target: "历法" }, status: "current",
      source: { kind: "document_version", ref: versionId },
    });
    new CreativeRelationRepository(workspace).putRevision({
      relationId: "world-location", create: true, checkpointId, kind: "related_to",
      sourceResourceId: world.resourceId, targetResourceId: location.resourceId, state: "active",
    });
    const imageRepository = new ImageAssetRepository(workspace);
    const ready = imageRepository.createOrGetJob({
      idempotencyKey: "ready-map", providerId: "image", modelId: "gpt-image-2", title: "潮汐王国地图",
      purpose: "world_map", prompt: "map", size: "1024x1024", quality: "auto", background: "opaque",
      sourceResourceIds: [world.resourceId], sourceVersionIds: [world.revisionId],
    });
    imageRepository.claim(ready.id); imageRepository.markRequestSent(ready.id);
    const stored = new ImageAssetStore(workspacePath).save(onePixelPng());
    imageRepository.complete(ready.id, stored);
    const failed = imageRepository.createOrGetJob({
      idempotencyKey: "failed-scene", providerId: "image", modelId: "gpt-image-2", title: "雾港风貌",
      purpose: "scene", prompt: "scene", size: "1024x1024", quality: "auto", background: "opaque",
      sourceResourceIds: [location.resourceId], sourceVersionIds: [location.revisionId],
    });
    imageRepository.claim(failed.id); imageRepository.markRequestSent(failed.id);
    imageRepository.markFailed(failed.id, "IMAGE_PROVIDER_RUNTIME_FAILED", "safe");
    workspace.close();

    exportPackage(workspacePath, outputDirectory, placeholder, "incomplete");
    const first = readManifest(outputDirectory);
    expect(first).toMatchObject({
      outcome: "incomplete",
      counts: { resources: 2, documents: 1, assertions: 1, relations: 1, imageJobs: 2, readyImages: 1 },
    });
    expect(first.images).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "潮汐王国地图", actualContent: true, status: "succeeded" }),
      expect.objectContaining({ title: "雾港风貌", actualContent: false, failureCode: "IMAGE_PROVIDER_RUNTIME_FAILED" }),
    ]));
    const readyEntry = first.images.find((entry) => entry.actualContent)!;
    const failedEntry = first.images.find((entry) => !entry.actualContent)!;
    expect(fs.readFileSync(path.join(outputDirectory, readyEntry.path))).toEqual(onePixelPng());
    expect(fs.readFileSync(path.join(outputDirectory, failedEntry.path), "utf8")).toBe("failed-image-placeholder");
    expect(fs.readFileSync(path.join(outputDirectory, first.documents[0]!.path), "utf8")).toContain("潮汐决定王国");
    expect(JSON.parse(fs.readFileSync(path.join(outputDirectory, "graph.json"), "utf8"))).toMatchObject({
      resources: expect.arrayContaining([expect.objectContaining({ title: "潮汐王国" })]),
      assertions: [expect.objectContaining({ assertionId: "tide-rule" })],
      relations: [expect.objectContaining({ id: "world-location" })],
    });

    fs.writeFileSync(path.join(outputDirectory, "obsolete.txt"), "old", "utf8");
    exportPackage(workspacePath, outputDirectory, placeholder, "completed");
    expect(readManifest(outputDirectory).outcome).toBe("completed");
    expect(fs.existsSync(path.join(outputDirectory, "obsolete.txt"))).toBe(false);
    expect(fs.readdirSync(path.dirname(outputDirectory)).some((name) => name.includes(".next-") || name.includes(".previous-"))).toBe(false);
  });
});

interface TestManifest {
  outcome: string;
  counts: Record<string, number>;
  documents: Array<{ path: string }>;
  images: Array<{ title: string; status: string; actualContent: boolean; failureCode: string | null; path: string }>;
}

function exportPackage(workspacePath: string, outputDirectory: string, placeholder: string, outcome: "completed" | "incomplete"): void {
  exportLatestGrowthWorldPackage({
    workspacePath, outputDirectory, failedImagePlaceholderPath: placeholder, outcome, goalId: "goal-1",
    provider: { providerId: "text", modelId: "gpt-5.4" },
    imageProvider: { providerId: "image", modelId: "gpt-image-2" },
  });
}

function readManifest(outputDirectory: string): TestManifest {
  return JSON.parse(fs.readFileSync(path.join(outputDirectory, "manifest.json"), "utf8")) as TestManifest;
}

function onePixelPng(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
}
