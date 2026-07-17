import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { compileGrowthWorldFragment, growthWorldFragmentParameters } from "../growth/growthWorldFragment";
import { growthInquiryBriefParameters, growthInquiryBriefSchema } from "../growth/growthInquiryBrief";
import { createGrowthRevisionReferenceCatalog } from "../growth/phases/revision/growthRevisionReferences";
import {
  proposeChangeSetArgsSchema,
  proposeChangeSetResultSchema,
  inspectProjectFilesArgsSchema,
  inspectProjectFilesResultSchema,
  listProjectDirectoryArgsSchema,
  listProjectDirectoryResultSchema,
  statProjectFileArgsSchema,
  statProjectFileResultSchema,
  globProjectFilesArgsSchema,
  globProjectFilesResultSchema,
  searchProjectFilesArgsSchema,
  searchProjectFilesResultSchema,
  readProjectFileArgsSchema,
  readProjectFileResultSchema,
  saveTaskNoteArgsSchema,
  saveTaskNoteResultSchema,
  listTaskNotesArgsSchema,
  listTaskNotesResultSchema,
  retrieveGraphEvidenceArgsSchema,
  retrieveGraphEvidenceResultSchema,
  growthRetrieveGraphEvidenceArgsSchema,
  growthRetrieveGraphEvidenceResultSchema,
  generateImageArgsSchema,
  generateImageResultSchema,
  submitGrowthInquiryResultSchema,
  submitClosureSelfAssessmentArgsSchema,
  submitClosureSelfAssessmentResultSchema,
  submitClosureCheckerReviewArgsSchema,
  submitClosureCheckerReviewResultSchema,
  type ProposeChangeSetArgs,
  type ProposeChangeSetResult,
  type InspectProjectFilesArgs,
  type InspectProjectFilesResult,
  type ListProjectDirectoryArgs,
  type ListProjectDirectoryResult,
  type StatProjectFileArgs,
  type StatProjectFileResult,
  type GlobProjectFilesArgs,
  type GlobProjectFilesResult,
  type SearchProjectFilesArgs,
  type SearchProjectFilesResult,
  type ReadProjectFileArgs,
  type ReadProjectFileResult,
  type SaveTaskNoteArgs,
  type SaveTaskNoteResult,
  type ListTaskNotesArgs,
  type ListTaskNotesResult,
  type RetrieveGraphEvidenceArgs,
  type RetrieveGraphEvidenceResult,
  type AgentRetrieveGraphEvidenceArgs,
  type GrowthRetrieveGraphEvidenceResult,
  type GrowthRunBinding,
  type GenerateImageArgs,
  type GenerateImageResult,
  type SubmitGrowthInquiryArgs,
  type SubmitGrowthInquiryResult,
  type SubmitClosureSelfAssessmentArgs,
  type SubmitClosureSelfAssessmentResult,
  type SubmitClosureCheckerReviewArgs,
  type SubmitClosureCheckerReviewResult,
} from "../../shared/agentWorkerProtocol";

const identifier = Type.String({ minLength: 1, maxLength: 240 });
const dependencyIds = Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 500 });
const jsonObject = Type.Record(Type.String({ minLength: 1, maxLength: 240 }), Type.Unknown());

const retrieveParameters = Type.Object({
  scopeResourceIds: Type.Array(identifier, { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });

const growthRetrieveParameters = Type.Object({
  variant: Type.Literal("growth_v1"),
  query: Type.String({ minLength: 1, maxLength: 12_000 }),
  aliases: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 100 })),
  seedResourceIds: Type.Optional(Type.Array(identifier, { maxItems: 100 })),
  maxHops: Type.Integer({ minimum: 0, maximum: 3 }),
  cpuBudgetMs: Type.Integer({ minimum: 1, maximum: 60_000 }),
  expansionBudget: Type.Integer({ minimum: 1, maximum: 100_000 }),
  resultBudget: Type.Integer({ minimum: 1, maximum: 100_000 }),
  tokenBudget: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  contentBudgetChars: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  policyVersion: Type.String({ minLength: 1, maxLength: 120 }),
}, { additionalProperties: false });

const closureSelfAssessmentParameters = Type.Object({
  decision: Type.Union([Type.Literal("continue_growing"), Type.Literal("ready_for_checker")]),
  safeSummary: Type.String({ minLength: 1, maxLength: 1_000 }),
}, { additionalProperties: false });

const closureCheckerFindingParameters = Type.Object({
  localId: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,79}$" }),
  severity: Type.Union([Type.Literal("minor"), Type.Literal("major"), Type.Literal("blocking")]),
  category: Type.Union([
    Type.Literal("world_consistency"), Type.Literal("story_consistency"), Type.Literal("character_consistency"),
    Type.Literal("causality"), Type.Literal("continuity"), Type.Literal("evidence_gap"),
    Type.Literal("scope_violation"), Type.Literal("creator_choice_required"),
  ]),
  evidenceIds: Type.Array(identifier, { minItems: 1, maxItems: 100 }),
  safeSummary: Type.String({ minLength: 1, maxLength: 1_000 }),
  repairObjective: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false });

const closureCheckerReviewParameters = Type.Object({
  decision: Type.Union([Type.Literal("accepted"), Type.Literal("repairs_required"), Type.Literal("blocked")]),
  adverseFindings: Type.Array(closureCheckerFindingParameters, { maxItems: 100 }),
}, { additionalProperties: false });

const inspectProjectFilesParameters = Type.Object({
  mode: Type.Union([Type.Literal("overview"), Type.Literal("read"), Type.Literal("search")]),
  path: Type.Optional(Type.String({ maxLength: 1_000 })),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
}, { additionalProperties: false });

const optionalProjectPath = Type.Optional(Type.String({ maxLength: 1_000 }));
const listProjectDirectoryParameters = Type.Object({ path: optionalProjectPath }, { additionalProperties: false });
const statProjectFileParameters = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1_000 }),
}, { additionalProperties: false });
const globProjectFilesParameters = Type.Object({
  pattern: Type.String({ minLength: 1, maxLength: 1_000 }),
  path: optionalProjectPath,
}, { additionalProperties: false });
const searchProjectFilesParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 500 }),
  path: optionalProjectPath,
}, { additionalProperties: false });
const readProjectFileParameters = Type.Object({
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
  offsetChars: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000, default: 4_000 })),
}, { additionalProperties: false });
const taskNoteSourceParameters = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4_000 }),
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  startChar: Type.Integer({ minimum: 0 }),
  endChar: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
const saveTaskNoteParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 240 }),
  content: Type.String({ minLength: 1, maxLength: 1_000 }),
  source: Type.Optional(taskNoteSourceParameters),
}, { additionalProperties: false });
const listTaskNotesParameters = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 100 })),
}, { additionalProperties: false });
const generateImageParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 240 }),
  purpose: Type.Union([Type.Literal("character_portrait"), Type.Literal("scene"), Type.Literal("world_map")]),
  prompt: Type.String({ minLength: 1, maxLength: 50_000 }),
  sourceResourceIds: Type.Array(identifier, { minItems: 1, maxItems: 100 }),
  sourceVersionIds: Type.Array(identifier, { minItems: 1, maxItems: 100 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
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
  retrieveGraphEvidence(args: AgentRetrieveGraphEvidenceArgs, signal?: AbortSignal): Promise<RetrieveGraphEvidenceResult | GrowthRetrieveGraphEvidenceResult>;
  inspectProjectFiles(args: InspectProjectFilesArgs, signal?: AbortSignal): Promise<InspectProjectFilesResult>;
  listProjectDirectory(args: ListProjectDirectoryArgs, signal?: AbortSignal): Promise<ListProjectDirectoryResult>;
  statProjectFile(args: StatProjectFileArgs, signal?: AbortSignal): Promise<StatProjectFileResult>;
  globProjectFiles(args: GlobProjectFilesArgs, signal?: AbortSignal): Promise<GlobProjectFilesResult>;
  searchProjectFiles(args: SearchProjectFilesArgs, signal?: AbortSignal): Promise<SearchProjectFilesResult>;
  readProjectFile(args: ReadProjectFileArgs, signal?: AbortSignal): Promise<ReadProjectFileResult>;
  saveTaskNote(args: SaveTaskNoteArgs, signal?: AbortSignal): Promise<SaveTaskNoteResult>;
  listTaskNotes(args: ListTaskNotesArgs, signal?: AbortSignal): Promise<ListTaskNotesResult>;
  generateImage(args: GenerateImageArgs, signal?: AbortSignal): Promise<GenerateImageResult>;
  submitGrowthInquiry?(args: SubmitGrowthInquiryArgs, signal?: AbortSignal): Promise<SubmitGrowthInquiryResult>;
  submitClosureSelfAssessment?(args: SubmitClosureSelfAssessmentArgs, signal?: AbortSignal): Promise<SubmitClosureSelfAssessmentResult>;
  submitClosureCheckerReview?(args: SubmitClosureCheckerReviewArgs, signal?: AbortSignal): Promise<SubmitClosureCheckerReviewResult>;
  proposeChangeSet(args: ProposeChangeSetArgs, signal?: AbortSignal): Promise<ProposeChangeSetResult>;
}

export function createAgentTools(executor: AgentToolExecutor, options: { growthBinding?: GrowthRunBinding } = {}): AgentTool[] {
  const retrieve: AgentTool<typeof retrieveParameters | typeof growthRetrieveParameters> = {
    name: "retrieve_graph_evidence",
    label: "检索项目事实",
    description: options.growthBinding
      ? "Retrieve authorized Growth evidence from the pinned Cycle checkpoint."
      : "Retrieve sourced evidence from explicitly selected active project scopes.",
    parameters: options.growthBinding ? growthRetrieveParameters : retrieveParameters,
    execute: async (_toolCallId, params, signal) => {
      const args = options.growthBinding
        ? growthRetrieveGraphEvidenceArgsSchema.parse(params)
        : retrieveGraphEvidenceArgsSchema.parse(params);
      const result = options.growthBinding
        ? growthRetrieveGraphEvidenceResultSchema.parse(await executor.retrieveGraphEvidence(args, signal))
        : retrieveGraphEvidenceResultSchema.parse(await executor.retrieveGraphEvidence(args, signal));
      const modelVisibleResult = options.growthBinding && "receiptId" in result
        ? (({ receiptId: _receiptId, revisionAuthority, ...safe }) => ({
            ...safe,
            ...(revisionAuthority
              ? { revisionReferences: createGrowthRevisionReferenceCatalog(revisionAuthority) }
              : {}),
          }))(result)
        : result;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result: modelVisibleResult,
            priorInquiries: options.growthBinding?.priorInquiries ?? [],
            novaxInstruction: options.growthBinding?.kind === "closure_evaluation"
              ? "This pinned Closure Receipt and deterministic facet projection are recorded. Do not repeat retrieval or propose changes. Submit exactly one Closure self-assessment next."
              : options.growthBinding?.kind === "repair"
              ? `This pinned Receipt contains the evidence for one authorized Closure repair. Apply only this safe objective: ${options.growthBinding.closureRepair?.repairObjective ?? "repair the selected finding"}. Submit exactly one Change Set; do not broaden the repair or repeat retrieval.`
              : options.growthBinding
              ? options.growthBinding.kind === "revision"
                ? "This pinned Growth Receipt is recorded. Do not repeat retrieval. Submit exactly one 3-7 item Growth Inquiry Brief next. Cite returned evidence IDs in the Inquiry. For the later Revision Fragment, use only revisionReferences ref aliases or new localIds; never use evidenceId, resourceId, documentId, relation endpoints, or database identities as Fragment references."
                : "This pinned Growth Receipt is recorded. Do not repeat retrieval. Submit exactly one 3-7 item Growth Inquiry Brief next. Cite only returned evidence IDs; use the trusted priorInquiries local IDs only for explicit allowlisted transitions."
              : "Do not repeat the same retrieval. If the user requested a Change Set and evidence is sufficient, call propose_change_set. If the evidence conflicts or the user requested validation, call checker. Otherwise submit the final structured result.",
          }),
        }],
        details: result,
      };
    },
  };

  const submitInquiry: AgentTool<typeof growthInquiryBriefParameters> = {
    name: "submit_growth_inquiry",
    label: "提交证据化自询",
    description: "Submit one authority-free 3-7 item Inquiry Brief after pinned retrieval. Ask about causal consequences and cross-node impact, not what extra setting can be added. For a normal Brief, selectedLocalId must name one non-choice Inquiry and every requiresCreatorChoice must be false. For a creator-choice Brief, selectedLocalId must be null and exactly one Inquiry must set requiresCreatorChoice=true. The selected or creator-choice Inquiry must have the unique highest numeric priority; priority ties are invalid. Use only local IDs and returned evidence IDs. Do not submit Batch, Inquiry, Receipt, rank, checkpoint, scope, rule, fingerprint, or lifecycle authority fields.",
    parameters: growthInquiryBriefParameters,
    execute: async (_toolCallId, params, signal) => {
      const args = growthInquiryBriefSchema.parse(params);
      if (!executor.submitGrowthInquiry) throw Object.assign(new Error("Growth Inquiry executor is required."), { code: "GROWTH_INQUIRY_REQUIRED" });
      const result = submitGrowthInquiryResultSchema.parse(await executor.submitGrowthInquiry(args, signal));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result,
            novaxInstruction: result.status === "creator_choice_required"
              ? "The Inquiry is durably blocked for a creator choice. Do not call Writer, propose_change_set, or generate_image. Submit a blocked final result using user_confirmation_required."
              : "The selected Inquiry is durable. Continue with the one remaining trusted Growth content path; do not repeat retrieval or Inquiry submission.",
          }),
        }],
        details: result,
      };
    },
  };

  const submitClosureSelfAssessment: AgentTool<typeof closureSelfAssessmentParameters> = {
    name: "submit_closure_self_assessment",
    label: "提交闭环自评",
    description: "Assess only the pinned Closure facets. Choose continue_growing when any required content facet is not satisfied; choose ready_for_checker only when every required facet is satisfied. Do not submit checkpoint, scope, Receipt, profile, run, or persistence authority.",
    parameters: closureSelfAssessmentParameters,
    execute: async (_toolCallId, params, signal) => {
      if (!executor.submitClosureSelfAssessment) throw Object.assign(new Error("Closure assessment executor is required."), { code: "GROWTH_CLOSURE_SUBMISSION_INVALID" });
      const result = submitClosureSelfAssessmentResultSchema.parse(await executor.submitClosureSelfAssessment(
        submitClosureSelfAssessmentArgsSchema.parse(params), signal,
      ));
      return fileToolResult(result, result.status === "checker_required"
        ? "The self-assessment is staged and an independent Checker review is required next."
        : "The self-assessment is staged as continue_growing. Do not call Checker or propose changes; submit the final structured result.");
    },
  };

  const submitClosureCheckerReview: AgentTool<typeof closureCheckerReviewParameters> = {
    name: "submit_closure_checker_review",
    label: "提交闭环检查",
    description: "Submit only the independent Checker decision and its cited adverse findings. Do not submit checkpoint, scope, Receipt, profile, run, hashes, or persistence authority.",
    parameters: closureCheckerReviewParameters,
    execute: async (_toolCallId, params, signal) => {
      if (!executor.submitClosureCheckerReview) throw Object.assign(new Error("Closure review executor is required."), { code: "GROWTH_CLOSURE_SUBMISSION_INVALID" });
      const result = submitClosureCheckerReviewResultSchema.parse(await executor.submitClosureCheckerReview(
        submitClosureCheckerReviewArgsSchema.parse(params), signal,
      ));
      return fileToolResult(result, "The independent Closure review is staged. Submit the final structured result without proposing project changes.");
    },
  };

  const worldFragment = options.growthBinding?.kind === "expand" && options.growthBinding.focusKinds[0] === "world"
    ? options.growthBinding
    : null;
  const propose: AgentTool<typeof proposeParameters | typeof growthWorldFragmentParameters> = {
    name: "propose_change_set",
    label: "生成候选变更",
    description: worldFragment
      ? "Submit one high-level world Fragment: at least one world, at least two location/faction entities, one setting document, and one sourced Assertion; documents, facts, and related_to relations are open arrays. Do not supply low-level IDs, parents, dependencies, create/state fields, or project-file operations."
      : "Submit a candidate Change Set for Novax policy evaluation; this tool cannot approve or commit it.",
    parameters: worldFragment ? growthWorldFragmentParameters : proposeParameters,
    execute: async (_toolCallId, params, signal) => {
      const args = worldFragment
        ? compileGrowthWorldFragment(params, {
          cycleId: worldFragment.cycleId,
          worldRootResourceId: worldFragment.domainRootResourceIds.world,
        })
        : proposeChangeSetArgsSchema.parse(params);
      const result = proposeChangeSetResultSchema.parse(await executor.proposeChangeSet(
        args,
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

  const listDirectory: AgentTool<typeof listProjectDirectoryParameters> = {
    name: "list_project_directory",
    label: "列出项目目录",
    description: "List real files and directories under the current project root. Use this first when the user asks what the project contains; do not guess README.md.",
    parameters: listProjectDirectoryParameters,
    execute: async (_toolCallId, params, signal) => fileToolResult(
      listProjectDirectoryResultSchema.parse(await executor.listProjectDirectory(listProjectDirectoryArgsSchema.parse(params), signal)),
      "Choose paths from this real listing. If the listing is incomplete, disclose its omitted count and narrow the path or use glob_project_files.",
    ),
  };

  const statFile: AgentTool<typeof statProjectFileParameters> = {
    name: "stat_project_file",
    label: "查看文件信息",
    description: "Inspect the type, size, modified time, and SHA-256 of a known project path without reading its content.",
    parameters: statProjectFileParameters,
    execute: async (_toolCallId, params, signal) => fileToolResult(
      statProjectFileResultSchema.parse(await executor.statProjectFile(statProjectFileArgsSchema.parse(params), signal)),
      "Use this metadata only for the returned path. A missing path is not an authorization failure; discover the real path with list_project_directory or glob_project_files.",
    ),
  };

  const globFiles: AgentTool<typeof globProjectFilesParameters> = {
    name: "glob_project_files",
    label: "匹配项目文件",
    description: "Discover project paths by a glob pattern such as **/*.md. Use after listing, or as fallback when a guessed file does not exist.",
    parameters: globProjectFilesParameters,
    execute: async (_toolCallId, params, signal) => fileToolResult(
      globProjectFilesResultSchema.parse(await executor.globProjectFiles(globProjectFilesArgsSchema.parse(params), signal)),
      "Read only paths returned here. No matches means the pattern matched nothing, not that project access is unauthorized.",
    ),
  };

  const searchFiles: AgentTool<typeof searchProjectFilesParameters> = {
    name: "search_project_files",
    label: "搜索项目内容",
    description: "Search text content across real project files and return source paths, line numbers, and excerpts.",
    parameters: searchProjectFilesParameters,
    execute: async (_toolCallId, params, signal) => fileToolResult(
      searchProjectFilesResultSchema.parse(await executor.searchProjectFiles(searchProjectFilesArgsSchema.parse(params), signal)),
      "Use the returned path and line evidence. Respect incomplete and skipped-binary counts; no matches is not an authorization failure.",
    ),
  };

  const readFile: AgentTool<typeof readProjectFileParameters> = {
    name: "read_project_file",
    label: "读取项目文件",
    description: "Read one bounded range of a known project file. Use offsetChars/endChar to continue large files; default chunks are intentionally small enough for long tasks.",
    parameters: readProjectFileParameters,
    execute: async (_toolCallId, params, signal) => fileToolResult(
      readProjectFileResultSchema.parse(await executor.readProjectFile(readProjectFileArgsSchema.parse(params), signal)),
      "Use only the returned content. If hasMore is true, persist a source-linked task note before continuing at endChar. If the path is not found, discover real paths instead of claiming missing authorization.",
    ),
  };

  const saveNote: AgentTool<typeof saveTaskNoteParameters> = {
    name: "save_task_note",
    label: "保存任务笔记",
    description: "Persist a concise working note for exactly one previously read file range. This is task memory, not canonical story data.",
    parameters: saveTaskNoteParameters,
    execute: async (_toolCallId, params, signal) => fileToolResult(
      saveTaskNoteResultSchema.parse(await executor.saveTaskNote(saveTaskNoteArgsSchema.parse(params), signal)),
      "The covered source range is now durable. Continue at its endChar or list notes for recovery.",
    ),
  };

  const listNotes: AgentTool<typeof listTaskNotesParameters> = {
    name: "list_task_notes",
    label: "读取任务笔记",
    description: "Read a bounded page of durable notes created during this run. Use for recovery and final synthesis; paginate when nextOffset is present.",
    parameters: listTaskNotesParameters,
    execute: async (_toolCallId, params, signal) => fileToolResult(
      listTaskNotesResultSchema.parse(await executor.listTaskNotes(listTaskNotesArgsSchema.parse(params), signal)),
      "These notes are source-linked working memory. Re-read their exact source range before resolving uncertainty or conflict.",
    ),
  };

  const generateImage: AgentTool<typeof generateImageParameters> = {
    name: "generate_image",
    label: "生成角色或场景图片",
    description: "Generate one real, source-bound character portrait or scene image using the separately configured image Provider. Retrieve stable project sources first and reuse the same idempotencyKey for retries of the same image request.",
    parameters: generateImageParameters,
    execute: async (_toolCallId, params, signal) => {
      const result = generateImageResultSchema.parse(await executor.generateImage(
        generateImageArgsSchema.parse(params),
        signal,
      ));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            result,
            novaxInstruction: "The source-bound image asset is committed and ready. Do not repeat generation. Cite its source versions and submit the final structured result.",
          }),
        }],
        details: result,
      };
    },
  };

  const growthTools = options.growthBinding?.kind === "closure_evaluation"
    ? [submitClosureSelfAssessment, submitClosureCheckerReview]
    : options.growthBinding?.kind === "repair" ? []
    : options.growthBinding ? [submitInquiry] : [];
  return [retrieve, ...growthTools, listDirectory, statFile, globFiles, searchFiles, readFile, saveNote, listNotes, inspectFiles, generateImage, propose];
}

function fileToolResult<T>(result: T, novaxInstruction: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ result, novaxInstruction }) }],
    details: result,
  };
}
