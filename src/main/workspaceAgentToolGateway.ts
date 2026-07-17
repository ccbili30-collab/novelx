import {
  proposeChangeSetResultSchema,
  globProjectFilesResultSchema,
  inspectProjectFilesResultSchema,
  listProjectDirectoryResultSchema,
  readProjectFileResultSchema,
  retrieveGraphEvidenceArgsSchema,
  retrieveGraphEvidenceResultSchema,
  searchProjectFilesResultSchema,
  statProjectFileResultSchema,
  saveTaskNoteResultSchema,
  listTaskNotesResultSchema,
  generateImageResultSchema,
  type GenerateImageArgs,
  type ProposeChangeSetArgs,
} from "../shared/agentWorkerProtocol";
import {
  ChangeSetService,
  classifyGreenfieldCreateOnlyCandidate,
  parseGreenfieldDocumentOutputEvidence,
  type ChangeSetItem,
  type ChangeSetPolicyEvaluator,
} from "../domain/changeSet/changeSetService";
import { AgentAuditRepository } from "../domain/audit/agentAuditRepository";
import { canonicalAuditHash } from "../domain/audit/canonicalAuditHash";
import { ContextPacketService } from "../domain/retrieval/contextPacketService";
import { CheckpointRepository } from "../domain/version/checkpointRepository";
import type { WorkspaceDatabase } from "../domain/workspace/workspaceRepository";
import type { AgentToolGateway } from "./agentProcessSupervisor";
import { ProjectFileService } from "../domain/workspace/projectFileService";
import { AgentTaskNoteRepository } from "../domain/agent/agentTaskNoteRepository";
import type { ImageProviderRuntimeProfile } from "../shared/imageProviderContract";
import { ImageAssetRepository } from "../domain/asset/imageAssetRepository";
import { ImageAssetStore } from "../domain/asset/imageAssetStore";
import { ImageGenerationService } from "../domain/asset/imageGenerationService";
import { isResponsesImageProviderFailureClass } from "../domain/asset/responsesImageProviderClient";
import { isGreenfieldWorkspaceEmpty } from "../domain/changeSet/workspaceChangeSetPolicy";
import { ResourceRepository } from "../domain/workspace/resourceRepository";
import { CreativeDocumentRepository } from "../domain/workspace/creativeDocumentRepository";
import { DocumentRepository } from "../domain/workspace/documentRepository";
import { GrowthRepository } from "../domain/growth/growthRepository";
import { growthIllustrationItemIdempotencyKey } from "./growth/illustration/growthIllustrationCoordinator";

interface WorkspaceAgentToolGatewayOptions {
  getImageProviderProfile?(): ImageProviderRuntimeProfile | null;
  createImageGenerationService?(workspace: WorkspaceDatabase): ImageGenerationService;
}

export function createWorkspaceAgentToolGateway(
  workspace: WorkspaceDatabase,
  policy: ChangeSetPolicyEvaluator,
  isCurrentWorkspace: () => boolean,
  options: WorkspaceAgentToolGatewayOptions = {},
): AgentToolGateway {
  const assertAvailable = (signal: AbortSignal): void => {
    if (signal.aborted) throw gatewayError("AGENT_RUN_CANCELLED", "Agent run was cancelled.");
    if (!isCurrentWorkspace()) throw gatewayError("AGENT_TOOLS_REQUIRED", "The active workspace changed.");
  };

  return {
    retrieveGraphEvidence: async (args, context) => {
      assertAvailable(context.signal);
      const packet = new ContextPacketService(workspace).build(retrieveGraphEvidenceArgsSchema.parse(args));
      assertAvailable(context.signal);
      return retrieveGraphEvidenceResultSchema.parse(packet);
    },
    inspectProjectFiles: async (args, context) => {
      assertAvailable(context.signal);
      const files = new ProjectFileService(workspace.rootPath);
      const result = args.mode === "overview"
        ? { mode: "overview" as const, ...files.overview(args.path) }
        : args.mode === "read"
          ? { mode: "read" as const, file: files.read(args.path) }
          : { mode: "search" as const, ...files.search(args.query, args.path) };
      assertAvailable(context.signal);
      return inspectProjectFilesResultSchema.parse(result);
    },
    listProjectDirectory: async (args, context) => {
      assertAvailable(context.signal);
      return listProjectDirectoryResultSchema.parse(new ProjectFileService(workspace.rootPath).list(args.path));
    },
    statProjectFile: async (args, context) => {
      assertAvailable(context.signal);
      return statProjectFileResultSchema.parse(new ProjectFileService(workspace.rootPath).stat(args.path));
    },
    globProjectFiles: async (args, context) => {
      assertAvailable(context.signal);
      return globProjectFilesResultSchema.parse(new ProjectFileService(workspace.rootPath).glob(args.pattern, args.path));
    },
    searchProjectFiles: async (args, context) => {
      assertAvailable(context.signal);
      return searchProjectFilesResultSchema.parse(new ProjectFileService(workspace.rootPath).search(args.query, args.path));
    },
    readProjectFile: async (args, context) => {
      assertAvailable(context.signal);
      return readProjectFileResultSchema.parse(new ProjectFileService(workspace.rootPath).read(args.path, args));
    },
    saveTaskNote: async (args, context) => {
      assertAvailable(context.signal);
      const stat = new ProjectFileService(workspace.rootPath).stat(args.source.path);
      if (stat.kind !== "file" || stat.sha256 !== args.source.sha256) {
        throw gatewayError("PROJECT_FILE_OPERATION_FAILED", "The task note source is stale or missing.");
      }
      const note = new AgentTaskNoteRepository(workspace).save({
        runId: context.runId,
        title: args.title,
        content: args.content,
        source: args.source,
      });
      assertAvailable(context.signal);
      const { runId: _runId, ...publicNote } = note;
      return saveTaskNoteResultSchema.parse(publicNote);
    },
    listTaskNotes: async (args, context) => {
      assertAvailable(context.signal);
      const notes = new AgentTaskNoteRepository(workspace).list(context.runId);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const page = notes.slice(offset, offset + limit);
      return listTaskNotesResultSchema.parse({
        notes: page.map(({ runId: _runId, ...note }) => note),
        total: notes.length,
        nextOffset: offset + page.length < notes.length ? offset + page.length : null,
      });
    },
    generateImage: async (args, context) => {
      assertAvailable(context.signal);
      if (context.illustrationQueueItemId) {
        assertIllustrationQueueImageArgs(workspace, context.illustrationQueueItemId, args);
      } else {
        new AgentAuditRepository(workspace).assertToolInvocation({
          toolInvocationId: context.requestId,
          runId: context.runId,
          invocationId: context.invocationId,
          toolName: "generate_image",
        });
      }
      const configuredProfile = options.getImageProviderProfile?.() ?? null;
      if (!configuredProfile) throw gatewayError("IMAGE_PROVIDER_REQUIRED", "A configured image Provider is required.");
      const profile = { ...configuredProfile };
      const repository = new ImageAssetRepository(workspace);
      const idempotencyKey = context.illustrationQueueItemId
        ? `illustration:${args.idempotencyKey}`
        : `steward:${args.idempotencyKey}`;
      if (args.purpose === "world_map") assertCurrentWorldMapSources(workspace, args);
      const service = options.createImageGenerationService?.(workspace)
        ?? new ImageGenerationService(repository, new ImageAssetStore(workspace.rootPath));
      try {
        const result = await service.generate({
          idempotencyKey,
          title: args.title,
          purpose: args.purpose,
          prompt: args.prompt,
          sourceResourceIds: args.sourceResourceIds,
          sourceVersionIds: args.sourceVersionIds,
        }, profile, context.signal, context.onImageProgress);
        assertAvailable(context.signal);
        return generateImageResultSchema.parse({
          jobId: result.job.id,
          assetId: result.asset.id,
          status: "ready",
          title: result.job.title,
          purpose: result.job.purpose,
          sourceResourceIds: result.job.sourceResourceIds,
          sourceVersionIds: result.job.sourceVersionIds,
          mimeType: result.asset.mimeType,
          width: result.asset.width,
          height: result.asset.height,
          byteLength: result.asset.byteLength,
          sha256: result.asset.sha256,
          thumbnailUrl: `novax-asset://image/${encodeURIComponent(result.asset.id)}`,
        });
      } catch (error) {
        if (context.signal.aborted || readCode(error) === "IMAGE_JOB_CANCELLED") {
          throw gatewayError("AGENT_RUN_CANCELLED", "Agent run was cancelled.");
        }
        const job = repository.getJobByIdempotencyKey(idempotencyKey);
        if (job?.status === "reconciliation_required") {
          throw gatewayError(
            "IMAGE_GENERATION_RECONCILIATION_REQUIRED",
            "The image request outcome is unknown and cannot be retried automatically.",
          );
        }
        throw gatewayError(
          "IMAGE_GENERATION_FAILED",
          "The image Provider did not return a committed image asset.",
          isResponsesImageProviderFailureClass(job?.errorCode) ? job.errorCode : undefined,
        );
      } finally {
        profile.apiKey = "";
      }
    },
    proposeChangeSet: async (args, context) => {
      assertAvailable(context.signal);
      new AgentAuditRepository(workspace).assertToolInvocation({
        toolInvocationId: context.requestId,
        runId: context.runId,
        invocationId: context.invocationId,
        toolName: "propose_change_set",
      });
      const head = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
      const items = mapProposedItems(args);
      const referencesGreenfieldOutput = items.some((item) => item.kind === "assertion.put"
        && item.payload.evidenceIds.some((evidenceId) => parseGreenfieldDocumentOutputEvidence(evidenceId) !== null));
      if (context.greenfieldCreateRequested || (referencesGreenfieldOutput
        && !context.sameChangeSetDocumentEvidenceAuthorized)) {
        assertGreenfieldCreateOnly(workspace, items, context);
      }
      const service = new ChangeSetService(workspace, policy);
      const changeSet = service.propose({
        idempotencyKey: `${context.runId}:${context.requestId}`,
        expectedHeadCheckpointId: head,
        mode: context.mode,
        summary: args.summary,
        items,
      }, {
        producerToolInvocationId: context.requestId,
        greenfieldCreateAuthorized: context.greenfieldCreateRequested === true,
        sameChangeSetDocumentEvidenceAuthorized: context.sameChangeSetDocumentEvidenceAuthorized === true,
        assertionIdentityUpdateAuthorized: context.assertionIdentityUpdateAuthorized === true,
      });
      assertAvailable(context.signal);
      const committedOutputs = changeSet.status === "committed"
        ? service.listOutputs(changeSet.id).map(({ itemId, kind, outputId }) => ({ itemId, kind, outputId }))
        : [];
      if (changeSet.status === "committed" && committedOutputs.length !== changeSet.items.length) {
        throw gatewayError("CHANGE_SET_OUTPUTS_INCOMPLETE", "Committed Change Set outputs are incomplete.");
      }
      return proposeChangeSetResultSchema.parse({
        changeSetId: changeSet.id,
        mode: changeSet.mode,
        status: changeSet.status,
        gateStatus: changeSet.gateStatus,
        blockedReason: changeSet.blockedReason,
        itemCount: changeSet.items.length,
        committedOutputs,
      });
    },
  };
}

function assertIllustrationQueueImageArgs(
  workspace: WorkspaceDatabase,
  itemId: string,
  args: GenerateImageArgs,
): void {
  const item = new GrowthRepository(workspace).getIllustrationItem(itemId);
  if (!item || !["planned", "queued", "running", "ready"].includes(item.status)) {
    throw gatewayError("GROWTH_ILLUSTRATION_QUEUE_AUTHORITY_INVALID", "Illustration Queue authority is unavailable.");
  }
  const resourceIds: string[] = [];
  const versionIds: string[] = [];
  for (const source of item.sources) {
    versionIds.push(source.kind === "resource" ? source.resourceVersionId : source.documentVersionId);
    if (source.kind === "resource") {
      resourceIds.push(source.resourceId);
    } else {
      const owner = workspace.db.prepare(`
        SELECT resource_id FROM document_versions WHERE id = ? AND creative_document_id = ?
      `).get(source.documentVersionId, source.documentId) as { resource_id: string } | undefined;
      if (!owner) throw gatewayError("GROWTH_ILLUSTRATION_QUEUE_AUTHORITY_INVALID", "Illustration source is unavailable.");
      resourceIds.push(owner.resource_id);
    }
  }
  const promptHash = canonicalAuditHash(args.prompt);
  const valid = args.idempotencyKey === growthIllustrationItemIdempotencyKey(item.requestId, item.id)
    && args.title === item.title
    && args.purpose === item.purpose
    && promptHash === item.compiledPromptSha256
    && sameStringSet(args.sourceResourceIds, resourceIds)
    && sameStringSet(args.sourceVersionIds, versionIds);
  if (!valid) {
    throw gatewayError("GROWTH_ILLUSTRATION_QUEUE_ARGS_INVALID", "Illustration Queue arguments do not match persisted authority.");
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function assertCurrentWorldMapSources(
  workspace: WorkspaceDatabase,
  args: { sourceResourceIds: string[]; sourceVersionIds: string[] },
): void {
  const branch = new CheckpointRepository(workspace).getActiveBranch();
  const currentResources = new Map(new ResourceRepository(workspace).listCurrent(branch.id)
    .map((resource) => [resource.id, resource]));
  if (args.sourceResourceIds.some((resourceId) => !currentResources.has(resourceId))) {
    throw gatewayError("WORLD_MAP_SOURCE_RESOURCE_INVALID", "World map sources must be active resources on the current branch.");
  }
  if (!args.sourceResourceIds.some((resourceId) => {
    const resource = currentResources.get(resourceId);
    return resource?.type === "world" && resource.objectKind === "world";
  })) {
    throw gatewayError("WORLD_MAP_SOURCE_WORLD_REQUIRED", "A world map requires a current formal world resource.");
  }
  const resources = new ResourceRepository(workspace);
  const documents = new DocumentRepository(workspace);
  const creativeDocuments = new CreativeDocumentRepository(workspace);
  const currentDocumentOwners = new Map<string, string>();
  for (const resourceId of args.sourceResourceIds) {
    const legacy = documents.getCurrentStable(resourceId, branch.id);
    if (legacy) currentDocumentOwners.set(legacy.id, resourceId);
    for (const creative of creativeDocuments.listCurrent(resourceId, branch.id)) {
      const stable = documents.getCurrentStableForCreativeDocument(creative.id, branch.id);
      if (stable) currentDocumentOwners.set(stable.id, resourceId);
    }
  }
  const valid = args.sourceVersionIds.every((versionId) => {
    const resource = resources.getVisibleByRevisionIdAtCheckpoint(versionId, branch.headCheckpointId);
    return args.sourceResourceIds.includes(resource?.id ?? "")
      || args.sourceResourceIds.includes(currentDocumentOwners.get(versionId) ?? "");
  });
  if (!valid) {
    throw gatewayError(
      "WORLD_MAP_SOURCE_VERSION_INVALID",
      "World map sources must be current stable versions bound to the supplied resources.",
    );
  }
}

function assertGreenfieldCreateOnly(
  workspace: WorkspaceDatabase,
  items: ChangeSetItem[],
  context: { mode: "free" | "assist"; greenfieldCreateRequested?: boolean },
): void {
  if (context.mode !== "free" || !context.greenfieldCreateRequested) {
    throw gatewayError("GREENFIELD_CREATE_EXPLICIT_FREE_REQUIRED", "Greenfield creation requires an explicit Free request.");
  }
  if (!isGreenfieldWorkspaceEmpty(workspace)) {
    throw gatewayError("GREENFIELD_WORKSPACE_NOT_EMPTY", "Greenfield creation is unavailable after formal content exists.");
  }
  const structuralViolation = classifyGreenfieldCreateOnlyCandidate(items);
  if (structuralViolation !== null) {
    throw gatewayError(structuralViolation, "Greenfield Change Sets may only create new formal content.");
  }
}

function mapProposedItems(
  args: ProposeChangeSetArgs,
): ChangeSetItem[] {
  return args.items.map((item): ChangeSetItem => {
    switch (item.kind) {
      case "assertion.put":
        return {
          ...item,
          payload: {
            ...item.payload,
            status: "current",
          },
        };
      case "resource.put":
      case "creative_document.put":
      case "creative_relation.put":
        return item;
      case "document.put":
        return {
          ...item,
          payload: { ...item.payload, authorKind: "agent" },
        };
      case "constraint_profile.put":
        return {
          ...item,
          payload: { ...item.payload, authorKind: "agent" },
        };
      case "project_file.put":
      case "project_file.delete":
        return item;
    }
  });
}

function gatewayError(
  code: string,
  message: string,
  diagnosticCode?: string,
): Error & { code: string; diagnosticCode?: string } {
  return Object.assign(new Error(message), diagnosticCode ? { code, diagnosticCode } : { code });
}

function readCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}
