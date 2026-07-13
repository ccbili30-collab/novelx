import { createHash } from "node:crypto";
import type {
  AgentWorkerAuditOperation,
  ProposeChangeSetArgs,
  RetrieveGraphEvidenceArgs,
} from "../../shared/agentWorkerProtocol";
import { loadCandidatePromptSet, type PublishedPrompt } from "../promptRegistry";
import { createOpenAiCompatiblePiAdapter } from "../pi/NovaxPiRuntimeAdapter";
import { modelProfileSchema, type ModelProfile } from "../pi/modelProfile";
import type { RuntimeAdapter } from "../pi/runtimeAdapterContract";
import type { AgentToolExecutor } from "../tools/createAgentTools";
import type { StewardOutput } from "../contracts/roleOutputs";
import {
  SPECIALIST_HANDOFF_VERSION,
  type CheckerSpecialistInput,
  type WriterSpecialistInput,
} from "../tools/createSpecialistTools";
import { evaluateAdversarialCase, promptAdversarialCases } from "./adversarialCases";
import { createCandidateSpecialistEvaluationTools } from "./createCandidateSpecialistTools";
import { runCandidateStewardEvaluation } from "./createCandidateStewardRuntime";
import { verifyOfflineAdversarialFixtures } from "./offlineAdversarialFixtures";
import { promptEvalReportSchema, type PromptEvalReport } from "./promptEvalReport";

type EvalEnvironment = Record<string, string | undefined>;

type EvalAdapter = RuntimeAdapter;

interface PromptEvalRunnerOptions {
  env: EvalEnvironment;
  now?: () => Date;
  createAdapter?(profile: ModelProfile): EvalAdapter;
  loadPrompts?(): PublishedPrompt[];
  onCaseProgress?(event: { caseId: string; phase: "started" | "completed"; passed?: boolean; errorCode?: string | null }): void;
}

type ProviderConfiguration =
  | { status: "ready"; profile: ModelProfile; timeoutMs: number }
  | { status: "missing" | "invalid" };

export async function runCandidatePromptEvaluation(options: PromptEvalRunnerOptions): Promise<PromptEvalReport> {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const prompts = (options.loadPrompts ?? loadCandidatePromptSet)();
  if (prompts.length !== 3 || new Set(prompts.map((prompt) => prompt.role)).size !== 3
    || prompts.some((prompt) => prompt.status !== "candidate")) {
    throw evalRunnerError("PROMPT_CANDIDATE_SET_NOT_AVAILABLE", "A complete candidate Prompt set is required for evaluation.");
  }
  const promptIdentities = prompts.map(({ id, role, version, sha256, status }) => ({ id, role, version, sha256, status }));
  const offline = verifyOfflineAdversarialFixtures();
  const configuration = readProviderConfiguration(options.env);

  if (configuration.status !== "ready") {
    return promptEvalReportSchema.parse({
      formatVersion: 4,
      classification: "candidate-prompt-publication-evaluation",
      generatedAt,
      run: {
        status: "not_run",
        reasonCode: configuration.status === "missing"
          ? "REAL_PROVIDER_CONFIG_REQUIRED"
          : "REAL_PROVIDER_CONFIG_INVALID",
      },
      provider: null,
      prompts: promptIdentities,
      offline,
      realProvider: { status: "not_run", cases: [] },
      publicationGate: {
        decision: "blocked",
        blockers: [configuration.status === "missing"
          ? "REAL_PROVIDER_EVAL_NOT_RUN"
          : "REAL_PROVIDER_CONFIG_INVALID"],
        autoActivated: false,
      },
    });
  }

  const createAdapter = options.createAdapter
    ?? createOpenAiCompatiblePiAdapter;
  const promptByRole = new Map(prompts.map((prompt) => [prompt.role, prompt]));
  const caseReports: PromptEvalReport["realProvider"]["cases"] = [];
  for (const testCase of promptAdversarialCases) {
    options.onCaseProgress?.({ caseId: testCase.id, phase: "started" });
    const prompt = promptByRole.get(testCase.role);
    if (!prompt) throw evalRunnerError("PROMPT_SET_INCOMPLETE", `Missing candidate Prompt for role: ${testCase.role}`);
    const caseReport = await runCase(
      createAdapter(configuration.profile),
      prompts,
      testCase,
      configuration.profile,
      configuration.timeoutMs,
    );
    caseReports.push(caseReport);
    options.onCaseProgress?.({
      caseId: testCase.id,
      phase: "completed",
      passed: caseReport.passed,
      errorCode: caseReport.errorCode,
    });
  }

  const blockers: string[] = [];
  if (caseReports.some((item) => item.errorCode !== null)) blockers.push("REAL_PROVIDER_CASE_ERROR");
  if (caseReports.some((item) => !item.passed)) blockers.push("REAL_PROVIDER_CASES_FAILED");
  if (caseReports.some((item) => item.actualProviderId === null)) blockers.push("PROVIDER_RECEIPT_INCOMPLETE");
  if (caseReports.some((item) => item.contextPolicyVersion === null)) blockers.push("CONTEXT_ADMISSION_RECEIPT_INCOMPLETE");
  const report = promptEvalReportSchema.parse({
    formatVersion: 4,
    classification: "candidate-prompt-publication-evaluation",
    generatedAt,
    run: { status: "completed", reasonCode: "REAL_PROVIDER_EVAL_COMPLETED" },
    provider: {
      providerId: configuration.profile.providerId,
      displayName: configuration.profile.displayName,
      modelId: configuration.profile.modelId,
    },
    prompts: promptIdentities,
    offline,
    realProvider: { status: "completed", cases: caseReports },
    publicationGate: {
      decision: blockers.length === 0 ? "ready_for_manual_review" : "blocked",
      blockers,
      autoActivated: false,
    },
  });
  assertReportContainsNoSecret(report, configuration.profile.apiKey);
  return report;
}

async function runCase(
  adapter: EvalAdapter,
  prompts: PublishedPrompt[],
  testCase: (typeof promptAdversarialCases)[number],
  providerProfile: ModelProfile,
  timeoutMs: number,
): Promise<PromptEvalReport["realProvider"]["cases"][number]> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const auditOperations: AgentWorkerAuditOperation[] = [];
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();

  let errorCode: string | null = null;
  let submission: unknown = null;
  let submissions = 0;
  let directResult: Awaited<ReturnType<EvalAdapter["run"]>> | null = null;
  const productionToolExecutions: Array<{
    tool: StewardOutput["toolOutcomes"][number]["tool"];
    status: "succeeded" | "failed";
  }> = [];
  try {
    if (testCase.role === "steward") {
      const runtimeResult = await runCandidateStewardEvaluation({
        runId: `eval:${testCase.id}`,
        userInput: testCase.userInput,
        mode: testCase.stewardToolScenario === "assist_pending_change_set" ? "assist" : "free",
        scopeResourceIds: evaluationScopeResourceIds(testCase),
        providerProfile,
        prompts,
        adapter,
        executor: createEvaluationToolExecutor(testCase.stewardToolScenario, productionToolExecutions),
        signal: controller.signal,
        audit: {
          record: async (_runId, operation) => {
            auditOperations.push(operation);
          },
        },
      });
      directResult = runtimeResult.adapterResult;
      submission = runtimeResult.output;
      submissions = runtimeResult.submissionCount;
      for (const operation of auditOperations) {
        if (operation.type !== "local_tool.terminal") continue;
        const started = auditOperations.find((candidate) => (
          candidate.type === "local_tool.started"
          && candidate.toolInvocationId === operation.toolInvocationId
        ));
        if (started?.type !== "local_tool.started") continue;
        productionToolExecutions.push({
          tool: started.toolName,
          status: operation.eventType === "succeeded" ? "succeeded" : "failed",
        });
      }
    } else {
      const specialistInput = testCase.specialistInput;
      if (!specialistInput) throw evalRunnerError("SPECIALIST_EVAL_INPUT_REQUIRED", "Missing Specialist invocation input.");
      const tools = createCandidateSpecialistEvaluationTools({
        runId: `eval:${testCase.id}`,
        parentInvocationId: `eval:${testCase.id}:steward`,
        providerProfile,
        prompts,
        createAdapter: () => adapter,
        audit: {
          record: async (_runId, operation) => {
            auditOperations.push(operation);
          },
        },
      });
      const tool = tools.find((candidate) => candidate.name === testCase.role);
      if (!tool) throw evalRunnerError("SPECIALIST_EVAL_TOOL_REQUIRED", "Missing Specialist evaluation tool.");
      const result = await tool.execute(
        `eval:${testCase.id}:tool-call`,
        specialistInput as WriterSpecialistInput & CheckerSpecialistInput,
        controller.signal,
      );
      submission = result.details;
      submissions = readSpecialistSubmissionCount(auditOperations);
    }
  } catch (error) {
    errorCode = timedOut ? "EVAL_CASE_TIMEOUT" : readSafeRuntimeErrorCode(error);
  } finally {
    clearTimeout(timer);
  }

  const failureCodes: string[] = [];
  if (errorCode) failureCodes.push("PROVIDER_CASE_RUNTIME_ERROR");
  if (!submission) failureCodes.push("STRUCTURED_RESULT_NOT_SUBMITTED");
  if (submissions !== 1) failureCodes.push("STRUCTURED_RESULT_COUNT_INVALID");
  if (submission) failureCodes.push(...evaluateAdversarialCase(testCase, submission).failureCodes);
  const requiredToolExecution = testCase.expectation.requiredProductionToolExecution;
  if (requiredToolExecution && !productionToolExecutions.some((execution) => (
    execution.tool === requiredToolExecution.tool && execution.status === requiredToolExecution.status
  ))) {
    failureCodes.push("REQUIRED_PRODUCTION_TOOL_EXECUTION_MISSING");
  }
  if (testCase.role === "steward" && !hasCompleteStewardAudit(auditOperations, `eval:${testCase.id}:steward`)) {
    failureCodes.push("STEWARD_PRODUCTION_PATH_INCOMPLETE");
  } else if (testCase.role !== "steward" && !hasCompleteSpecialistAudit(auditOperations)) {
    failureCodes.push("SPECIALIST_PRODUCTION_PATH_INCOMPLETE");
  }
  const auditStarted = auditOperations.find((operation) => operation.type === "invocation.started");
  const auditTerminal = auditOperations.find((operation) => operation.type === "invocation.terminal");
  const receipt = auditTerminal?.type === "invocation.terminal"
    ? auditTerminal.receipt
    : directResult?.receipt
      ? { ...directResult.receipt, stopReason: directResult.stopReason }
      : null;
  return {
    caseId: testCase.id,
    role: testCase.role,
    passed: failureCodes.length === 0,
    failureCodes: [...new Set(failureCodes)],
    durationMs: Math.max(0, Date.now() - startedAt),
    submissions,
    outputSha256: submission ? sha256(stableStringify(submission)) : null,
    errorCode,
    executionPath: testCase.role === "steward"
      ? "production-steward-runtime"
      : "production-specialist-handoff",
    handoffVersion: testCase.role === "steward" ? null : SPECIALIST_HANDOFF_VERSION,
    auditOperations: auditOperations.length,
    runtimeProfileSha256: auditStarted?.type === "invocation.started" ? auditStarted.profile.sha256 : null,
    toolPolicySha256: auditStarted?.type === "invocation.started" ? auditStarted.profile.toolPolicySha256 : null,
    actualProviderId: receipt?.actualProviderId ?? null,
    actualModelId: receipt?.actualModelId ?? null,
    contextPolicyVersion: receipt?.contextPolicyVersion ?? null,
    correctionAttempts: receipt?.correctionAttempts ?? 0,
    productionToolExecutions,
  };
}

function createEvaluationToolExecutor(
  scenario: (typeof promptAdversarialCases)[number]["stewardToolScenario"],
  executions: Array<{
    tool: StewardOutput["toolOutcomes"][number]["tool"];
    status: "succeeded" | "failed";
  }>,
): AgentToolExecutor {
  const taskNotes: Array<{
    id: string;
    title: string;
    content: string;
    source: { path: string; sha256: string; startChar: number; endChar: number };
    createdAt: string;
    updatedAt: string;
  }> = [];
  return {
    listProjectDirectory: async () => {
      if (scenario !== "project_overview") throw evaluationFileToolFailure(executions, "list_project_directory");
      executions.push({ tool: "list_project_directory", status: "succeeded" });
      return evaluationProjectListing();
    },
    statProjectFile: async (args) => {
      if (scenario !== "project_overview") throw evaluationFileToolFailure(executions, "stat_project_file");
      const file = evaluationProjectFiles().find((candidate) => candidate.path === args.path);
      if (!file) throw evalRunnerError("PROJECT_FILE_NOT_FOUND", "The requested evaluation file does not exist.");
      executions.push({ tool: "stat_project_file", status: "succeeded" });
      return { path: file.path, kind: "file" as const, size: file.size, modifiedAt: "2026-07-11T00:00:00.000Z", sha256: file.sha256 };
    },
    globProjectFiles: async (args) => {
      if (scenario !== "project_overview") throw evaluationFileToolFailure(executions, "glob_project_files");
      executions.push({ tool: "glob_project_files", status: "succeeded" });
      return { pattern: args.pattern, entries: evaluationProjectListing().entries, incomplete: false, omittedEntries: 0 };
    },
    searchProjectFiles: async (args) => {
      if (scenario !== "project_overview") throw evaluationFileToolFailure(executions, "search_project_files");
      executions.push({ tool: "search_project_files", status: "succeeded" });
      const matches = evaluationProjectFiles().flatMap((file) => file.content?.includes(args.query)
        ? [{ path: file.path, line: 1, excerpt: file.content.slice(0, 500) }]
        : []);
      return { query: args.query, matches, scannedFiles: 4, skippedBinaryFiles: 0, incomplete: false };
    },
    readProjectFile: async (args) => {
      if (scenario !== "project_overview") throw evaluationFileToolFailure(executions, "read_project_file");
      const file = evaluationProjectFiles().find((candidate) => candidate.path === args.path);
      if (!file) throw evalRunnerError("PROJECT_FILE_NOT_FOUND", "The requested evaluation file does not exist.");
      executions.push({ tool: "read_project_file", status: "succeeded" });
      const startChar = args.offsetChars ?? 0;
      const maxChars = args.maxChars ?? 4_000;
      const content = file.content.slice(startChar, startChar + maxChars);
      const endChar = startChar + content.length;
      return { ...file, content, returnedChars: content.length, startChar, endChar, hasMore: endChar < file.originalChars, complete: endChar === file.originalChars };
    },
    saveTaskNote: async (args) => {
      executions.push({ tool: "save_task_note", status: "succeeded" });
      const now = "2026-07-11T00:00:00.000Z";
      const note = { id: `note-${taskNotes.length + 1}`, ...args, createdAt: now, updatedAt: now };
      taskNotes.push(note);
      return note;
    },
    listTaskNotes: async (args) => {
      executions.push({ tool: "list_task_notes", status: "succeeded" });
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const notes = taskNotes.slice(offset, offset + limit);
      return { notes, total: taskNotes.length, nextOffset: offset + notes.length < taskNotes.length ? offset + notes.length : null };
    },
    inspectProjectFiles: async () => {
      if (scenario !== "project_overview") {
        executions.push({ tool: "inspect_project_files", status: "failed" });
        throw evalRunnerError("AGENT_TOOL_FAILED", "Project files are not configured for this evaluation case.");
      }
      executions.push({ tool: "inspect_project_files", status: "succeeded" });
      const readme = "# NovelX\n小说创作工作台。";
      const world = "银湾海岸由古代沉降与海水倒灌形成。";
      return {
        mode: "overview" as const,
        listing: {
          root: ".",
          entries: [
            { path: "README.md", kind: "file" as const, size: Buffer.byteLength(readme), modifiedAt: "2026-07-11T00:00:00.000Z" },
            { path: "world.md", kind: "file" as const, size: Buffer.byteLength(world), modifiedAt: "2026-07-11T00:00:00.000Z" },
          ],
          ignoredDirectories: [".git", ".novax", "node_modules"],
          incomplete: false,
          omittedEntries: 0,
        },
        files: [
          evaluationFile("README.md", readme),
          evaluationFile("world.md", world),
        ],
        omittedReadableFiles: 0,
        totalReturnedChars: readme.length + world.length,
      };
    },
    retrieveGraphEvidence: async (args: RetrieveGraphEvidenceArgs) => {
      if (scenario === "graph_timeout") {
        executions.push({ tool: "retrieve_graph_evidence", status: "failed" });
        throw evalRunnerError("AGENT_TOOL_TIMEOUT", "Evaluation graph retrieval timed out.");
      }
      if (scenario !== "empty_graph" && scenario !== "assist_pending_change_set" && scenario !== "major_conflict"
        && scenario !== "source_bound_image") {
        executions.push({ tool: "retrieve_graph_evidence", status: "failed" });
        throw evalRunnerError("AGENT_TOOL_FAILED", "Graph retrieval is not configured for this evaluation case.");
      }
      executions.push({ tool: "retrieve_graph_evidence", status: "succeeded" });
      const assertions = scenario === "assist_pending_change_set"
        ? [evaluationAssertion(args.scopeResourceIds[0] ?? "world-assist-eval", "coast-source", "银湾海岸", "形成原因", { cause: "沉降与海水倒灌" })]
        : scenario === "source_bound_image"
          ? [evaluationAssertion(args.scopeResourceIds[0] ?? "world-image-eval", "image-version-eval", "潮汐观测者", "外观", {
              appearance: "银白短发、深蓝观测袍、左眼潮汐纹章",
            })]
        : scenario === "major_conflict"
          ? [
              evaluationAssertion(args.scopeResourceIds[0] ?? "world-conflict-eval", "source-old", "精灵", "起源", { cause: "世界树孕育" }),
              evaluationAssertion(args.scopeResourceIds[0] ?? "world-conflict-eval", "source-new", "精灵", "起源", { cause: "帝国实验制造" }),
            ]
          : [];
      const assertionChars = assertions.reduce((total, assertion) => total + JSON.stringify(assertion).length, 0);
      return {
        branch: { id: "branch-eval", headCheckpointId: "checkpoint-eval" },
        scopes: args.scopeResourceIds.map((resourceId) => ({ resourceId, type: "world" as const, title: "评测世界" })),
        assertions,
        documents: [],
        retrieval: {
          budget: {
            maxDocuments: 50,
            maxAssertions: 1_000,
            maxDocumentChars: 100_000,
            totalChars: 500_000,
          },
          usage: {
            assertions: assertions.length,
            documents: 0,
            assertionChars,
            documentChars: 0,
            totalChars: assertionChars,
          },
          completeness: {
            incomplete: false,
            omittedAssertions: 0,
            omittedDocuments: 0,
            truncatedDocuments: 0,
            limitsHit: [],
          },
          ordering: {
            assertions: "repository_subject_predicate_assertion_id",
            documents: "requested_scope_order",
            relevanceRanking: "not_applied",
          },
        },
      };
    },
    generateImage: async (args) => {
      if (scenario !== "source_bound_image") {
        executions.push({ tool: "generate_image", status: "failed" });
        throw evalRunnerError("IMAGE_PROVIDER_REQUIRED", "Image generation is not configured for this prompt evaluation case.");
      }
      executions.push({ tool: "generate_image", status: "succeeded" });
      return {
        jobId: "job-image-eval",
        assetId: "asset-image-eval",
        status: "ready" as const,
        title: args.title,
        purpose: args.purpose,
        sourceResourceIds: [...args.sourceResourceIds],
        sourceVersionIds: [...args.sourceVersionIds],
        mimeType: "image/png" as const,
        width: 1024,
        height: 1024,
        byteLength: 4096,
        sha256: "5f70bf18a08660b5b4f5bb614df7ad74a64c4a2bca68c0f305f5a0f8316f6fcb",
        thumbnailUrl: "novax-asset://image/asset-image-eval",
      };
    },
    proposeChangeSet: async (_args: ProposeChangeSetArgs) => {
      if (scenario !== "assist_pending_change_set") {
        executions.push({ tool: "propose_change_set", status: "failed" });
        throw evalRunnerError("AGENT_TOOL_FAILED", "Change Set proposal is not configured for this evaluation case.");
      }
      executions.push({ tool: "propose_change_set", status: "succeeded" });
      return {
        changeSetId: "change-set-assist-1",
        mode: "assist",
        status: "pending",
        gateStatus: "review_pending",
        blockedReason: null,
        itemCount: 1,
      };
    },
  };
}

function evaluationAssertion(
  scopeResourceId: string,
  id: string,
  subject: string,
  predicate: string,
  object: Record<string, string>,
) {
  return {
    assertionId: `assertion-${id}`,
    versionId: id,
    scopeResourceId,
    scopeType: "world",
    subject,
    predicate,
    object,
    sources: [{
      type: "assertion" as const,
      assertion: { assertionId: `assertion-${id}`, versionId: id, subject, predicate },
    }],
  };
}

function evaluationScopeResourceIds(testCase: (typeof promptAdversarialCases)[number]): string[] {
  switch (testCase.stewardToolScenario) {
    case "empty_graph": return ["world-empty-eval"];
    case "assist_pending_change_set": return ["world-coast-eval"];
    case "major_conflict": return ["world-conflict-eval"];
    case "graph_timeout": return ["world-timeout-eval"];
    case "project_overview": return ["world-files-eval"];
    case "source_bound_image": return ["world-image-eval"];
    default: return [];
  }
}

function evaluationFile(path: string, content: string) {
  return {
    path,
    kind: "text" as const,
    size: Buffer.byteLength(content),
    sha256: sha256(content),
    content,
    complete: true,
    originalChars: content.length,
    returnedChars: content.length,
    startChar: 0,
    endChar: content.length,
    hasMore: false,
  };
}

function evaluationProjectFiles() {
  return [
    evaluationFile("01-力量体系.md", "力量体系以潮汐共鸣为基础，施术者必须承担记忆损耗。"),
    evaluationFile("02-场景地图与世界观.md", "银湾海岸由古代沉降与海水倒灌形成。"),
    evaluationFile("03-人物关系图.md", "林砚与顾潮是共同调查海岸异变的搭档。"),
    evaluationFile("04-物品大全.md", "潮汐罗盘可以记录最近一次空间折叠。"),
  ];
}

function evaluationProjectListing() {
  return {
    root: ".",
    entries: evaluationProjectFiles().map((file) => ({
      path: file.path,
      kind: "file" as const,
      size: file.size,
      modifiedAt: "2026-07-11T00:00:00.000Z",
    })),
    ignoredDirectories: [".git", ".novax", "node_modules"],
    incomplete: false,
    omittedEntries: 0,
  };
}

function evaluationFileToolFailure(
  executions: Array<{ tool: StewardOutput["toolOutcomes"][number]["tool"]; status: "succeeded" | "failed" }>,
  tool: StewardOutput["toolOutcomes"][number]["tool"],
) {
  executions.push({ tool, status: "failed" });
  return evalRunnerError("AGENT_TOOL_FAILED", "Project files are not configured for this evaluation case.");
}

function readSpecialistSubmissionCount(operations: AgentWorkerAuditOperation[]): number {
  const terminal = operations.find((operation) => operation.type === "invocation.terminal");
  return terminal?.type === "invocation.terminal" ? terminal.structuredSubmissionCount : 0;
}

function hasCompleteSpecialistAudit(operations: AgentWorkerAuditOperation[]): boolean {
  return operations.map((operation) => operation.type).join(",")
    === "local_tool.started,invocation.started,invocation.terminal,local_tool.terminal";
}

function hasCompleteStewardAudit(operations: AgentWorkerAuditOperation[], invocationId: string): boolean {
  const started = operations.find((operation) => (
    operation.type === "invocation.started"
    && operation.invocationId === invocationId
    && operation.role === "steward"
    && operation.parentInvocationId === null
  ));
  const terminal = operations.find((operation) => (
    operation.type === "invocation.terminal"
    && operation.invocationId === invocationId
    && operation.structuredSubmissionCount === 1
  ));
  return Boolean(started && terminal);
}

export function readProviderConfiguration(env: EvalEnvironment): ProviderConfiguration {
  const required = [
    "NOVAX_EVAL_PROVIDER_ID",
    "NOVAX_EVAL_PROVIDER_NAME",
    "NOVAX_EVAL_PROVIDER_BASE_URL",
    "NOVAX_EVAL_PROVIDER_API_KEY",
    "NOVAX_EVAL_PROVIDER_MODEL",
    "NOVAX_EVAL_PROVIDER_CONTEXT_WINDOW",
    "NOVAX_EVAL_PROVIDER_MAX_TOKENS",
    "NOVAX_EVAL_PROVIDER_REASONING",
  ] as const;
  if (required.some((key) => !env[key]?.trim())) return { status: "missing" };
  const reasoningValue = env.NOVAX_EVAL_PROVIDER_REASONING?.trim().toLowerCase();
  if (reasoningValue !== "true" && reasoningValue !== "false") return { status: "invalid" };
  const profile = modelProfileSchema.safeParse({
    providerId: env.NOVAX_EVAL_PROVIDER_ID,
    displayName: env.NOVAX_EVAL_PROVIDER_NAME,
    baseUrl: env.NOVAX_EVAL_PROVIDER_BASE_URL,
    apiKey: env.NOVAX_EVAL_PROVIDER_API_KEY,
    modelId: env.NOVAX_EVAL_PROVIDER_MODEL,
    contextWindow: Number(env.NOVAX_EVAL_PROVIDER_CONTEXT_WINDOW),
    maxTokens: Number(env.NOVAX_EVAL_PROVIDER_MAX_TOKENS),
    reasoning: reasoningValue === "true",
    input: ["text"],
  });
  const timeoutMs = Number(env.NOVAX_EVAL_CASE_TIMEOUT_MS ?? 60_000);
  if (!profile.success || !Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) {
    return { status: "invalid" };
  }
  return { status: "ready", profile: profile.data, timeoutMs };
}

export function assertSafePromptEvalReport(report: PromptEvalReport, apiKey?: string): void {
  promptEvalReportSchema.parse(report);
  assertReportContainsNoSecret(report, apiKey);
  const forbiddenKeys = /api.?key|thinking|tool.?args|raw.?output|raw.?error|prompt.?text|base.?url/i;
  visitReport(report, (key) => {
    if (forbiddenKeys.test(key)) throw evalRunnerError("UNSAFE_EVAL_REPORT", `Forbidden report field: ${key}`);
  });
}

function assertReportContainsNoSecret(report: PromptEvalReport, apiKey?: string): void {
  if (apiKey && apiKey.length >= 8 && JSON.stringify(report).includes(apiKey)) {
    throw evalRunnerError("UNSAFE_EVAL_REPORT", "Provider secret appeared in the evaluation report.");
  }
}

function visitReport(value: unknown, visitKey: (key: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitReport(item, visitKey);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    visitKey(key);
    visitReport(child, visitKey);
  }
}

function readSafeRuntimeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "EVAL_CASE_RUNTIME_FAILED";
  const code = String(error.code);
  return [
    "PROVIDER_RUNTIME_FAILED",
    "PROVIDER_OUTPUT_INCOMPLETE",
    "PROVIDER_PROTOCOL_FAILED",
    "AGENT_RUN_CANCELLED",
    "AGENT_AUDIT_REQUIRED",
    "AGENT_CONTEXT_BUDGET_EXCEEDED",
    "STEWARD_UNTRUSTED_ECHO_REJECTED",
    "STEWARD_FINAL_SCHEMA_INVALID",
    "STEWARD_FINAL_TOOL_OUTCOMES_MISMATCH",
    "STEWARD_FINAL_EVIDENCE_INVALID",
    "STEWARD_FINAL_BLOCK_STATE_MISMATCH",
    "STEWARD_FINAL_BLOCK_REASON_MISMATCH",
    "STEWARD_FINAL_CHANGE_SET_MISMATCH",
  ].includes(code) ? code : "EVAL_CASE_RUNTIME_FAILED";
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evalRunnerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
