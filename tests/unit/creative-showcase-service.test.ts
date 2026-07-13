import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ImageAssetRepository } from "../../src/domain/asset/imageAssetRepository";
import { AssertionRepository } from "../../src/domain/graph/assertionRepository";
import { CreativeShowcaseService } from "../../src/domain/showcase/creativeShowcaseService";
import { CreativeDocumentEditorService } from "../../src/domain/workspace/creativeDocumentEditorService";
import { CreativeDocumentRepository } from "../../src/domain/workspace/creativeDocumentRepository";
import { CreativeWorkspaceService } from "../../src/domain/workspace/creativeWorkspaceService";
import { ResourceRepository } from "../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../src/domain/workspace/workspaceRepository";
import { commitFixtureCheckpoint } from "../helpers/workspaceFixtures";

describe("CreativeShowcaseService", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("projects stable story data, source-bound image states and only the selected story graph", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-showcase-service-"));
    const workspace = openWorkspace(root);
    try {
      const creative = new CreativeWorkspaceService(workspace);
      creative.mutate({ action: "create_resource", domain: "world", objectKind: "world", title: "潮雾世界", parentId: null });
      creative.mutate({ action: "create_resource", domain: "oc", objectKind: "oc", title: "洛弥", parentId: null });
      creative.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "潮雾纪事", parentId: null });
      creative.mutate({ action: "create_resource", domain: "story", objectKind: "story", title: "另一故事", parentId: null });

      const resources = new ResourceRepository(workspace).listCurrent();
      const world = resources.find((resource) => resource.title === "潮雾世界")!;
      const character = resources.find((resource) => resource.title === "洛弥")!;
      const story = resources.find((resource) => resource.title === "潮雾纪事")!;
      const otherStory = resources.find((resource) => resource.title === "另一故事")!;
      creative.mutate({ action: "create_relation", kind: "uses_world", sourceResourceId: story.id, targetResourceId: world.id });
      creative.mutate({ action: "create_relation", kind: "uses_oc", sourceResourceId: story.id, targetResourceId: character.id });

      const prose = new CreativeDocumentRepository(workspace).listCurrent()
        .find((document) => document.resourceId === story.id && document.kind === "prose")!;
      const editor = new CreativeDocumentEditorService(workspace);
      const firstDraft = editor.saveWorkingCopy({
        documentId: prose.id,
        content: "已发布正文",
        expectedRevision: 0,
        expectedStableVersionId: null,
      });
      const stable = editor.saveStable({ documentId: prose.id, expectedRevision: firstDraft.workingRevision });
      editor.saveWorkingCopy({
        documentId: prose.id,
        content: "尚未发布的工作副本",
        expectedRevision: stable.workingRevision,
        expectedStableVersionId: stable.stableVersionId,
      });

      putAssertion(workspace, story.id, "选中故事事件", "发生");
      putAssertion(workspace, otherStory.id, "其他故事秘密", "发生");

      const images = new ImageAssetRepository(workspace);
      const queued = images.createOrGetJob(imageJob("queued", story.id, stable.stableVersionId!));
      const ready = images.createOrGetJob(imageJob("ready", character.id, stable.stableVersionId!));
      images.claim(ready.id);
      images.markRequestSent(ready.id);
      images.complete(ready.id, {
        mimeType: "image/png",
        width: 1024,
        height: 1024,
        byteLength: 256,
        sha256: "b".repeat(64),
        relativePath: `.novax/assets/images/${"b".repeat(64)}.png`,
      });

      const result = new CreativeShowcaseService(workspace).get(story.id);
      expect(result.story.id).toBe(story.id);
      expect(result.worlds.map((resource) => resource.id)).toEqual([world.id]);
      expect(result.characters.map((resource) => resource.id)).toEqual([character.id]);
      expect(result.proseDocuments.map((document) => document.content)).toEqual(["已发布正文"]);
      expect(JSON.stringify(result)).not.toContain("尚未发布的工作副本");
      expect(result.images.map((image) => [image.jobId, image.status])).toEqual(expect.arrayContaining([
        [ready.id, "ready"],
        [queued.id, "queued"],
      ]));
      expect(result.graphScopeResourceIds).toContain(story.id);
      expect(result.graph.nodes.some((node) => node.label.includes("选中故事事件"))).toBe(true);
      expect(result.graph.nodes.some((node) => node.label.includes("其他故事秘密"))).toBe(false);
      expect(() => new CreativeShowcaseService(workspace).get(world.id)).toThrowError(
        expect.objectContaining({ code: "SHOWCASE_STORY_INVALID" }),
      );
    } finally {
      workspace.close();
    }
  });
});

function imageJob(suffix: string, resourceId: string, versionId: string) {
  return {
    idempotencyKey: `showcase-${suffix}`,
    providerId: "test-provider",
    modelId: "test-image-model",
    title: `图片 ${suffix}`,
    purpose: "scene" as const,
    prompt: "Unit-test fixture only.",
    size: "1024x1024",
    quality: "auto" as const,
    background: "auto" as const,
    sourceResourceIds: [resourceId],
    sourceVersionIds: [versionId],
  };
}

function putAssertion(
  workspace: ReturnType<typeof openWorkspace>,
  scopeId: string,
  subject: string,
  predicate: string,
): void {
  const repository = new AssertionRepository(workspace);
  commitFixtureCheckpoint(workspace, {
    idempotencyKey: `showcase-assertion-${scopeId}`,
    summary: `记录 ${subject}`,
    label: `记录 ${subject}`,
  }, (checkpointId, changeSetId) => repository.putVersion({
    assertionId: `assertion.${scopeId}`,
    checkpointId,
    scopeType: "story",
    scopeId,
    subject,
    predicate,
    object: { text: `${subject}${predicate}` },
    status: "current",
    source: { kind: "confirmed_change_set", ref: changeSetId },
  }));
}
