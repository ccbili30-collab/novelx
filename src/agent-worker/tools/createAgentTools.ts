import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  proposeChangeSetArgsSchema,
  proposeChangeSetResultSchema,
  inspectProjectFilesArgsSchema,
  inspectProjectFilesResultSchema,
  retrieveGraphEvidenceArgsSchema,
  retrieveGraphEvidenceResultSchema,
  type ProposeChangeSetArgs,
  type ProposeChangeSetResult,
  type InspectProjectFilesArgs,
  type InspectProjectFilesResult,
  type RetrieveGraphEvidenceArgs,
  type RetrieveGraphEvidenceResult,
} from "../../shared/agentWorkerProtocol";

const identifier = Type.String({ minLength: 1, maxLength: 240 });
const dependencyIds = Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 500 });
const jsonObject = Type.Record(Type.String({ minLength: 1, maxLength: 240 }), Type.Unknown());

const retrieveParameters = Type.Object({
  scopeResourceIds: Type.Array(identifier, { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });

const inspectProjectFilesParameters = Type.Object({
  mode: Type.Union([Type.Literal("overview"), Type.Literal("read"), Type.Literal("search")]),
  path: Type.Optional(Type.String({ maxLength: 1_000 })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}, { additionalProperties: false });

const assertionItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 160 }),
  dependsOn: dependencyIds,
  kind: Type.Literal("assertion.put"),
  payload: Type.Object({
    assertionId: identifier,
    scopeType: Type.String({ minLength: 1, maxLength: 80 }),
    scopeId: identifier,
    subject: Type.String({ minLength: 1, maxLength: 500 }),
    predicate: Type.String({ minLength: 1, maxLength: 240 }),
    object: jsonObject,
    evidenceIds: Type.Array(identifier, { minItems: 1, maxItems: 200 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const resourceItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 160 }),
  dependsOn: dependencyIds,
  kind: Type.Literal("resource.put"),
  payload: Type.Object({
    resourceId: identifier,
    create: Type.Boolean(),
    type: Type.Union([
      Type.Literal("world"),
      Type.Literal("oc"),
      Type.Literal("story"),
      Type.Literal("graph"),
      Type.Literal("timeline"),
      Type.Literal("asset"),
    ]),
    objectKind: Type.Optional(Type.Union([
      Type.Literal("domain_root"), Type.Literal("world"), Type.Literal("oc"), Type.Literal("story"),
      Type.Literal("volume"), Type.Literal("chapter"), Type.Literal("location"), Type.Literal("faction"),
      Type.Literal("oc_variant"), Type.Literal("graph_view"), Type.Literal("timeline_view"),
      Type.Literal("asset_collection"),
    ])),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    parentId: Type.Union([identifier, Type.Null()]),
    state: Type.Union([Type.Literal("active"), Type.Literal("deleted")]),
    sortOrder: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const documentItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 160 }),
  dependsOn: dependencyIds,
  kind: Type.Literal("document.put"),
  payload: Type.Object({
    resourceId: identifier,
    creativeDocumentId: Type.Optional(identifier),
    content: Type.String({ maxLength: 8_000_000 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const creativeDocumentItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 160 }),
  dependsOn: dependencyIds,
  kind: Type.Literal("creative_document.put"),
  payload: Type.Object({
    documentId: identifier,
    create: Type.Boolean(),
    resourceId: identifier,
    kind: Type.Union([
      Type.Literal("prose"), Type.Literal("setting"), Type.Literal("character_profile"),
      Type.Literal("location_profile"), Type.Literal("faction_profile"), Type.Literal("knowledge_note"),
      Type.Literal("style_guide"), Type.Literal("writing_constraints"),
    ]),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    state: Type.Union([Type.Literal("active"), Type.Literal("deleted")]),
    sortOrder: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const creativeRelationItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 160 }),
  dependsOn: dependencyIds,
  kind: Type.Literal("creative_relation.put"),
  payload: Type.Object({
    relationId: identifier,
    create: Type.Boolean(),
    relationKind: Type.Union([
      Type.Literal("uses_world"), Type.Literal("uses_oc"), Type.Literal("variant_of"), Type.Literal("related_to"),
    ]),
    sourceResourceId: identifier,
    targetResourceId: identifier,
    state: Type.Union([Type.Literal("active"), Type.Literal("deleted")]),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const constraintProfileItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 160 }),
  dependsOn: dependencyIds,
  kind: Type.Literal("constraint_profile.put"),
  payload: Type.Object({
    profileId: identifier,
    create: Type.Boolean(),
    scopeResourceId: Type.Union([identifier, Type.Null()]),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    profile: Type.Object({
      narrativePerson: Type.Union([Type.Literal("first"), Type.Literal("second"), Type.Literal("third"), Type.Null()]),
      tense: Type.Union([Type.Literal("past"), Type.Literal("present"), Type.Literal("mixed"), Type.Null()]),
      tone: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
      pacing: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
      humorLevel: Type.Union([Type.Integer({ minimum: 0, maximum: 5 }), Type.Null()]),
      prohibitedContent: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 500 }),
      requiredContent: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 500 }),
      notes: Type.String({ maxLength: 20_000 }),
    }, { additionalProperties: false }),
    state: Type.Union([Type.Literal("active"), Type.Literal("deleted")]),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const projectFilePutItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 160 }),
  dependsOn: dependencyIds,
  kind: Type.Literal("project_file.put"),
  payload: Type.Object({
    path: Type.String({ minLength: 1, maxLength: 1_000 }),
    content: Type.String({ maxLength: 8_000_000 }),
    expectedSha256: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const projectFileDeleteItem = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 160 }),
  dependsOn: dependencyIds,
  kind: Type.Literal("project_file.delete"),
  payload: Type.Object({
    path: Type.String({ minLength: 1, maxLength: 1_000 }),
    expectedSha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const proposeParameters = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 2_000 }),
  items: Type.Array(Type.Union([
    assertionItem, resourceItem, documentItem, creativeDocumentItem, creativeRelationItem, constraintProfileItem,
    projectFilePutItem, projectFileDeleteItem,
  ]), { minItems: 1, maxItems: 500 }),
}, { additionalProperties: false });

export interface AgentToolExecutor {
  retrieveGraphEvidence(args: RetrieveGraphEvidenceArgs, signal?: AbortSignal): Promise<RetrieveGraphEvidenceResult>;
  inspectProjectFiles(args: InspectProjectFilesArgs, signal?: AbortSignal): Promise<InspectProjectFilesResult>;
  proposeChangeSet(args: ProposeChangeSetArgs, signal?: AbortSignal): Promise<ProposeChangeSetResult>;
}

export function createAgentTools(executor: AgentToolExecutor): AgentTool[] {
  const retrieve: AgentTool<typeof retrieveParameters> = {
    name: "retrieve_graph_evidence",
    label: "检索项目事实",
    description: "Retrieve sourced evidence from explicitly selected active project scopes.",
    parameters: retrieveParameters,
    execute: async (_toolCallId, params, signal) => {
      const result = retrieveGraphEvidenceResultSchema.parse(await executor.retrieveGraphEvidence(
        retrieveGraphEvidenceArgsSchema.parse(params),
        signal,
      ));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result,
            novaxInstruction: "Do not repeat the same retrieval. If the user requested a Change Set and evidence is sufficient, call propose_change_set. If the evidence conflicts or the user requested validation, call checker. Otherwise submit the final structured result.",
          }),
        }],
        details: result,
      };
    },
  };

  const propose: AgentTool<typeof proposeParameters> = {
    name: "propose_change_set",
    label: "生成候选变更",
    description: "Submit a candidate Change Set for Novax policy evaluation; this tool cannot approve or commit it.",
    parameters: proposeParameters,
    execute: async (_toolCallId, params, signal) => {
      const result = proposeChangeSetResultSchema.parse(await executor.proposeChangeSet(
        proposeChangeSetArgsSchema.parse(params),
        signal,
      ));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result,
            novaxInstruction: "The Change Set proposal has finished. Do not repeat the proposal. Submit the final structured result using the returned state.",
          }),
        }],
        details: result,
      };
    },
  };

  const inspectFiles: AgentTool<typeof inspectProjectFilesParameters> = {
    name: "inspect_project_files",
    label: "检查项目文件",
    description: "List, read, or search real files inside the current project root without executing them.",
    parameters: inspectProjectFilesParameters,
    execute: async (_toolCallId, params, signal) => {
      const result = inspectProjectFilesResultSchema.parse(await executor.inspectProjectFiles(
        inspectProjectFilesArgsSchema.parse(params),
        signal,
      ));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result,
            novaxInstruction: "Use only returned file content. Respect incomplete and omitted counts. Do not claim unread files were inspected.",
          }),
        }],
        details: result,
      };
    },
  };

  return [retrieve, inspectFiles, propose];
}
