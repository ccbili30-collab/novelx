import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ImageAssetRepository } from "../../../src/domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../../../src/domain/asset/imageAssetStore";
import { AssertionRepository } from "../../../src/domain/graph/assertionRepository";
import { CheckpointRepository } from "../../../src/domain/version/checkpointRepository";
import { CreativeDocumentRepository } from "../../../src/domain/workspace/creativeDocumentRepository";
import { CreativeRelationRepository } from "../../../src/domain/workspace/creativeRelationRepository";
import { DocumentRepository } from "../../../src/domain/workspace/documentRepository";
import { ResourceRepository } from "../../../src/domain/workspace/resourceRepository";
import { openWorkspace } from "../../../src/domain/workspace/workspaceRepository";

export interface GrowthWorldPackageExportInput {
  workspacePath: string;
  outputDirectory: string;
  failedImagePlaceholderPath: string;
  outcome: "completed" | "incomplete";
  goalId: string | null;
  provider: { providerId: string | null; modelId: string | null };
  imageProvider: { providerId: string | null; modelId: string | null };
}

/**
 * Exports only committed Domain projections and verified managed image bytes.
 * It never copies the workspace database, Provider stores, prompts or audit logs.
 */
export function exportLatestGrowthWorldPackage(input: GrowthWorldPackageExportInput): void {
  const destination = path.resolve(input.outputDirectory);
  const parent = path.dirname(destination);
  const temporary = path.join(parent, `${path.basename(destination)}.next-${randomUUID()}`);
  const backup = path.join(parent, `${path.basename(destination)}.previous-${randomUUID()}`);
  fs.mkdirSync(parent, { recursive: true });
  try {
    writePackage(temporary, input);
    const hadPrevious = fs.existsSync(destination);
    if (hadPrevious) fs.renameSync(destination, backup);
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (hadPrevious && !fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination);
      throw error;
    }
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    if (fs.existsSync(backup) && !fs.existsSync(destination)) fs.renameSync(backup, destination);
    else if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  }
}

function writePackage(directory: string, input: GrowthWorldPackageExportInput): void {
  fs.mkdirSync(directory, { recursive: false });
  const workspace = openWorkspace(input.workspacePath);
  try {
    const branch = new CheckpointRepository(workspace).getActiveBranch();
    const resources = new ResourceRepository(workspace).listAtCheckpoint(branch.headCheckpointId)
      .filter((resource) => resource.objectKind !== "domain_root");
    const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
    const creativeDocuments = new CreativeDocumentRepository(workspace).listAtCheckpoint(branch.headCheckpointId)
      .filter((document) => resourceById.has(document.resourceId));
    const documentRepository = new DocumentRepository(workspace);
    const documents = creativeDocuments.flatMap((document) => {
      const stable = documentRepository.getStableForCreativeDocumentAtCheckpoint(document.id, branch.headCheckpointId);
      return stable ? [{ document, stable, resource: resourceById.get(document.resourceId)! }] : [];
    });
    const documentDirectory = path.join(directory, "documents");
    fs.mkdirSync(documentDirectory, { recursive: true });
    const documentEntries = documents.map(({ document, stable, resource }, index) => {
      const fileName = `${sequence(index + 1)}-${slug(resource.type)}-${slug(resource.title)}-${slug(document.title)}.md`;
      const relativePath = path.posix.join("documents", fileName);
      fs.writeFileSync(path.join(directory, relativePath), stable.content, "utf8");
      return {
        resourceId: resource.id,
        resourceType: resource.type,
        objectKind: resource.objectKind,
        resourceTitle: resource.title,
        documentId: document.id,
        documentKind: document.kind,
        documentTitle: document.title,
        versionId: stable.id,
        contentSha256: stable.contentHash,
        codePoints: Array.from(stable.content).length,
        path: relativePath,
      };
    });

    const assertions = new AssertionRepository(workspace)
      .listCurrentInScopesAtCheckpoint(resources.map((resource) => resource.id), branch.headCheckpointId)
      .map((assertion) => ({
        assertionId: assertion.assertionId,
        versionId: assertion.versionId,
        scopeType: assertion.scopeType,
        scopeId: assertion.scopeId,
        subject: assertion.subject,
        predicate: assertion.predicate,
        object: assertion.object,
        sources: assertion.sources,
      }));
    const relations = new CreativeRelationRepository(workspace).listAtCheckpoint(branch.headCheckpointId);
    fs.writeFileSync(path.join(directory, "graph.json"), `${JSON.stringify({
      checkpointId: branch.headCheckpointId,
      resources,
      assertions,
      relations,
    }, null, 2)}\n`, "utf8");

    const imageDirectory = path.join(directory, "images");
    fs.mkdirSync(imageDirectory, { recursive: true });
    const imageRepository = new ImageAssetRepository(workspace);
    const imageStore = new ImageAssetStore(input.workspacePath);
    const jobs = imageRepository.listShowcaseJobs().reverse();
    const imageEntries = jobs.map((job, index) => {
      const extension = job.asset ? extensionForMime(job.asset.mimeType) : ".jpg";
      const fileName = `${sequence(index + 1)}-${slug(job.purpose)}-${slug(job.title)}${extension}`;
      const relativePath = path.posix.join("images", fileName);
      if (job.asset) {
        fs.writeFileSync(path.join(directory, relativePath), imageStore.readVerified(job.asset.relativePath, job.asset.sha256));
      } else {
        fs.copyFileSync(input.failedImagePlaceholderPath, path.join(directory, relativePath));
      }
      const fullJob = imageRepository.getRequiredJob(job.jobId);
      return {
        jobId: job.jobId,
        title: job.title,
        purpose: job.purpose,
        status: job.status,
        actualContent: job.asset !== null,
        failureCode: job.asset ? null : fullJob.errorCode,
        sourceResourceIds: job.sourceResourceIds,
        sourceVersionIds: job.sourceVersionIds,
        asset: job.asset ? {
          assetId: job.asset.id,
          mimeType: job.asset.mimeType,
          width: job.asset.width,
          height: job.asset.height,
          byteLength: job.asset.byteLength,
          sha256: job.asset.sha256,
        } : null,
        path: relativePath,
      };
    });

    const manifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      outcome: input.outcome,
      goalId: input.goalId,
      provider: input.provider,
      imageProvider: input.imageProvider,
      branchId: branch.id,
      checkpointId: branch.headCheckpointId,
      counts: {
        resources: resources.length,
        documents: documentEntries.length,
        assertions: assertions.length,
        relations: relations.length,
        imageJobs: imageEntries.length,
        readyImages: imageEntries.filter((entry) => entry.actualContent).length,
      },
      documents: documentEntries,
      images: imageEntries,
      graphPath: "graph.json",
    };
    fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(directory, "README.md"), renderReadme(manifest), "utf8");
  } finally {
    workspace.close();
  }
}

function renderReadme(manifest: {
  generatedAt: string;
  outcome: string;
  checkpointId: string;
  documents: Array<{ resourceTitle: string; documentTitle: string; documentKind: string; path: string }>;
  images: Array<{ title: string; purpose: string; status: string; actualContent: boolean; path: string }>;
}): string {
  return [
    "# NovelX 最新 Growth 世界包",
    "",
    `- 导出状态：${manifest.outcome}`,
    `- 生成时间：${manifest.generatedAt}`,
    `- Checkpoint：${manifest.checkpointId}`,
    "",
    "## 文档",
    "",
    ...manifest.documents.map((entry) => `- [${entry.resourceTitle} / ${entry.documentTitle} (${entry.documentKind})](${entry.path})`),
    "",
    "## 图片",
    "",
    ...manifest.images.map((entry) => `- [${entry.title} (${entry.purpose})](${entry.path}) — ${entry.actualContent ? entry.status : "生成失败，占位图；actualContent=false"}`),
    "",
    "## 图谱",
    "",
    "- [资源、断言与关系](graph.json)",
    "",
  ].join("\n");
}

function sequence(value: number): string { return String(value).padStart(3, "0"); }

function slug(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, "-").replace(/-+/gu, "-").replace(/[. ]+$/gu, "").slice(0, 80);
  return normalized || "untitled";
}

function extensionForMime(mimeType: "image/png" | "image/jpeg" | "image/webp"): string {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return ".jpg";
}
