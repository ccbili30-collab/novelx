import {
  proposeChangeSetResultSchema,
  globProjectFilesResultSchema,
  inspectProjectFilesResultSchema,
  listProjectDirectoryResultSchema,
  readProjectFileResultSchema,
  retrieveGraphEvidenceResultSchema,
  searchProjectFilesResultSchema,
  statProjectFileResultSchema,
  saveTaskNoteResultSchema,
  listTaskNotesResultSchema,
  type ProposeChangeSetArgs,
} from "../shared/agentWorkerProtocol";
import { ChangeSetService, type ChangeSetItem, type ChangeSetPolicyEvaluator } from "../domain/changeSet/changeSetService";
import { AgentAuditRepository } from "../domain/audit/agentAuditRepository";
import { ContextPacketService } from "../domain/retrieval/contextPacketService";
import { CheckpointRepository } from "../domain/version/checkpointRepository";
import type { WorkspaceDatabase } from "../domain/workspace/workspaceRepository";
import type { AgentToolGateway } from "./agentProcessSupervisor";
import { ProjectFileService } from "../domain/workspace/projectFileService";
import { AgentTaskNoteRepository } from "../domain/agent/agentTaskNoteRepository";

export function createWorkspaceAgentToolGateway(
  workspace: WorkspaceDatabase,
  policy: ChangeSetPolicyEvaluator,
  isCurrentWorkspace: () => boolean,
): AgentToolGateway {
  const assertAvailable = (signal: AbortSignal): void => {
    if (signal.aborted) throw gatewayError("AGENT_RUN_CANCELLED", "Agent run was cancelled.");
    if (!isCurrentWorkspace()) throw gatewayError("AGENT_TOOLS_REQUIRED", "The active workspace changed.");
  };

  return {
    retrieveGraphEvidence: async (args, context) => {
      assertAvailable(context.signal);
      const packet = new ContextPacketService(workspace).build(args);
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
    proposeChangeSet: async (args, context) => {
      assertAvailable(context.signal);
      new AgentAuditRepository(workspace).assertToolInvocation({
        toolInvocationId: context.requestId,
        runId: context.runId,
        invocationId: context.invocationId,
        toolName: "propose_change_set",
      });
      const head = new CheckpointRepository(workspace).getActiveBranch().headCheckpointId;
      const changeSet = new ChangeSetService(workspace, policy).propose({
        idempotencyKey: `${context.runId}:${context.requestId}`,
        expectedHeadCheckpointId: head,
        mode: context.mode,
        summary: args.summary,
        items: mapProposedItems(args),
      }, { producerToolInvocationId: context.requestId });
      assertAvailable(context.signal);
      return proposeChangeSetResultSchema.parse({
        changeSetId: changeSet.id,
        mode: changeSet.mode,
        status: changeSet.status,
        gateStatus: changeSet.gateStatus,
        blockedReason: changeSet.blockedReason,
        itemCount: changeSet.items.length,
      });
    },
  };
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

function gatewayError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
