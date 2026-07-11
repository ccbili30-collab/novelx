import { describe, expect, it } from "vitest";
import {
  checkerOutputSchema,
  stewardOutputSchema,
  writerOutputSchema,
} from "../../src/agent-worker/contracts/roleOutputs";
import { promptAdversarialCases } from "../../src/agent-worker/evals/adversarialCases";
import { createEvalResultTool } from "../../src/agent-worker/evals/evalResultTools";
import { verifyOfflineAdversarialFixtures } from "../../src/agent-worker/evals/offlineAdversarialFixtures";
import {
  assertSafePromptEvalReport,
  readProviderConfiguration,
  runCandidatePromptEvaluation,
} from "../../src/agent-worker/evals/promptEvalRunner";
import { offlineAdversarialFixtures } from "../../src/agent-worker/evals/offlineAdversarialFixtures";
import { loadActivePromptSet, loadCandidatePromptSet } from "../../src/agent-worker/promptRegistry";

describe("candidate Prompt evaluation framework", () => {
  it("enforces structured Steward, Writer, and Checker role boundaries", () => {
    expect(stewardOutputSchema.safeParse({
      status: "blocked",
      message: "缺少来源。",
      evidenceIds: [],
      toolOutcomes: [],
      changeSet: { state: "none", changeSetId: null },
      escalations: [],
    }).success).toBe(false);

    expect(writerOutputSchema.safeParse({
      status: "candidate",
      candidateText: "候选正文",
      evidenceIds: ["source-1"],
      gmResolutionId: "gm-1",
      authorityChanges: ["新增胜负"],
    }).success).toBe(false);

    expect(checkerOutputSchema.safeParse({
      status: "findings",
      findings: [{
        severity: "major",
        category: "writer_authority",
        evidence: [{ sourceId: "gm-1", claim: "GM 未裁决。" }],
        location: "结尾",
        scope: "当前场景",
        reason: "Writer 新增胜负。",
      }],
      replacementText: "Checker 擅自补写的剧情",
    }).success).toBe(false);
  });

  it("marks all offline adversarial outputs as fixture-only and rejects every violating pair", () => {
    expect(verifyOfflineAdversarialFixtures()).toEqual({
      classification: "fixture-only-not-live-evidence",
      cases: 9,
      compliantAccepted: 9,
      violationsRejected: 9,
    });
    expect(new Set(promptAdversarialCases.map((testCase) => testCase.category))).toEqual(new Set([
      "prompt_injection",
      "unsupported_claim",
      "writer_authority",
      "checker_story_creation",
      "assist_confirmation",
      "major_conflict",
      "hidden_fact_leak",
      "tool_failure",
      "natural_conversation",
    ]));
  });

  it("captures strict structured tool submissions without exposing raw arguments", async () => {
    const capture = createEvalResultTool("writer");
    await capture.tool.execute("tool-call-1", {
      status: "blocked",
      reasons: [{
        code: "missing_gm_resolution",
        message: "缺少不可变 GM 裁决。",
        evidenceIds: [],
      }],
    });

    expect(capture.getSubmissionCount()).toBe(1);
    expect(capture.getSubmission()).toEqual({
      status: "blocked",
      reasons: [{
        code: "missing_gm_resolution",
        message: "缺少不可变 GM 裁决。",
        evidenceIds: [],
      }],
    });
  });

  it("treats missing or unsafe Provider configuration as not runnable", () => {
    expect(readProviderConfiguration({})).toEqual({ status: "missing" });
    expect(readProviderConfiguration({
      NOVAX_EVAL_PROVIDER_ID: "provider",
      NOVAX_EVAL_PROVIDER_NAME: "Provider",
      NOVAX_EVAL_PROVIDER_BASE_URL: "http://remote.example/v1",
      NOVAX_EVAL_PROVIDER_API_KEY: "secret",
      NOVAX_EVAL_PROVIDER_MODEL: "model",
      NOVAX_EVAL_PROVIDER_CONTEXT_WINDOW: "64000",
      NOVAX_EVAL_PROVIDER_MAX_TOKENS: "8000",
      NOVAX_EVAL_PROVIDER_REASONING: "false",
    })).toEqual({ status: "invalid" });
  });

  it("writes a blocked not-run gate when real Provider configuration is absent", async () => {
    const report = await runCandidatePromptEvaluation({
      env: {},
      now: () => new Date("2026-07-10T00:00:00.000Z"),
      loadPrompts: candidatePromptSet,
    });

    expect(report).toMatchObject({
      formatVersion: 4,
      run: { status: "not_run", reasonCode: "REAL_PROVIDER_CONFIG_REQUIRED" },
      provider: null,
      realProvider: { status: "not_run", cases: [] },
      publicationGate: {
        decision: "blocked",
        blockers: ["REAL_PROVIDER_EVAL_NOT_RUN"],
        autoActivated: false,
      },
    });
    expect(report.prompts.every((prompt) => prompt.status === "candidate")).toBe(true);
    expect(() => assertSafePromptEvalReport(report)).not.toThrow();
    expect(() => assertSafePromptEvalReport(report, "candidate-prompt-publication-evaluation"))
      .toThrow(expect.objectContaining({ code: "UNSAFE_EVAL_REPORT" }));
  });

  it("does not evaluate the published set as though it were a new candidate", async () => {
    await expect(runCandidatePromptEvaluation({
      env: {},
      loadPrompts: () => candidatePromptSet().map((prompt) => ({ ...prompt, status: "active" as const })),
    }))
      .rejects.toMatchObject({ code: "PROMPT_CANDIDATE_SET_NOT_AVAILABLE" });
  });

  it("runs Steward and Specialists through their production orchestration paths", async () => {
    let callIndex = 0;
    let nestedChecker = false;
    const apiKey = "eval-secret-that-must-not-leak";
    const report = await runCandidatePromptEvaluation({
      env: providerEnvironment(apiKey),
      now: () => new Date("2026-07-10T00:00:00.000Z"),
      loadPrompts: candidatePromptSet,
      createAdapter: () => ({
        run: async (input) => {
          if (nestedChecker) {
            const checkerResult = input.tools.find((tool) => tool.name === "submit_checker_result")!;
            await checkerResult.execute("eval-nested-checker-result", {
              status: "findings",
              findings: [{
                severity: "major",
                category: "fact_conflict",
                evidence: [
                  { sourceId: "source-old", claim: "精灵由世界树孕育。" },
                  { sourceId: "source-new", claim: "精灵由帝国实验制造。" },
                ],
                location: "精灵起源",
                scope: "当前世界设定",
                reason: "两个来源对同一事实给出互斥结论。",
              }],
            });
            return successfulAdapterResult();
          }
          const currentIndex = callIndex++;
          const testCase = promptAdversarialCases[currentIndex];
          const fixture = offlineAdversarialFixtures[currentIndex];
          if (testCase.role === "steward") {
            const planTool = input.tools.find((tool) => tool.name === "submit_steward_plan")!;
            await planTool.execute(`eval-plan-${currentIndex}`, stewardPlanFor(testCase.stewardToolScenario));
          }
          if (testCase.stewardToolScenario === "empty_graph") {
            const retrieve = input.tools.find((tool) => tool.name === "retrieve_graph_evidence")!;
            await retrieve.execute("eval-retrieve-empty", { scopeResourceIds: ["world-empty-eval"] });
          }
          if (testCase.stewardToolScenario === "assist_pending_change_set") {
            const retrieve = input.tools.find((tool) => tool.name === "retrieve_graph_evidence")!;
            await retrieve.execute("eval-retrieve-assist", { scopeResourceIds: ["world-coast-eval"] });
            const propose = input.tools.find((tool) => tool.name === "propose_change_set")!;
            await propose.execute("eval-propose-assist", {
              summary: "整理有来源的新海岸设定",
              items: [{
                id: "coast-document",
                dependsOn: [],
                kind: "document.put",
                payload: { resourceId: "world-coast-eval", content: "新海岸设定" },
              }],
            });
          }
          if (testCase.stewardToolScenario === "graph_timeout") {
            const retrieve = input.tools.find((tool) => tool.name === "retrieve_graph_evidence")!;
            await expect(retrieve.execute(
              "eval-retrieve-timeout",
              { scopeResourceIds: ["world-timeout-eval"] },
            )).rejects.toMatchObject({ code: "AGENT_TOOL_TIMEOUT" });
          }
          if (testCase.id === "steward.major-conflict-blocks") {
            const retrieve = input.tools.find((tool) => tool.name === "retrieve_graph_evidence")!;
            await retrieve.execute("eval-retrieve-conflict", { scopeResourceIds: ["world-conflict-eval"] });
            const checker = input.tools.find((tool) => tool.name === "checker")!;
            nestedChecker = true;
            try {
              await checker.execute("eval-check-major-conflict", {
                candidateText: "精灵由帝国实验制造。",
                sourceMaterial: "source-old：精灵由世界树孕育。\nsource-new：精灵由帝国实验制造。",
                evidenceIds: ["source-old", "source-new"],
                constraints: ["互斥来源必须交给用户选择"],
              });
            } finally {
              nestedChecker = false;
            }
          }
          const resultTool = input.tools.find((tool) => tool.name === `submit_${testCase.role}_result`)!;
          await resultTool.execute(`eval-result-${callIndex}`, fixture.compliant);
          return successfulAdapterResult();
        },
      }),
    });

    expect(callIndex).toBe(offlineAdversarialFixtures.length);
    expect(report.realProvider.cases.filter((item) => !item.passed)).toEqual([]);
    const stewards = report.realProvider.cases.filter((item) => item.role === "steward");
    expect(stewards).toHaveLength(6);
    expect(stewards.every((item) =>
      item.executionPath === "production-steward-runtime"
      && item.handoffVersion === null
      && item.auditOperations >= 2
      && item.runtimeProfileSha256 !== null
      && item.toolPolicySha256 !== null)).toBe(true);
    expect(stewards.find((item) => item.caseId === "steward.unsupported-world-fact")?.productionToolExecutions)
      .toEqual([{ tool: "retrieve_graph_evidence", status: "succeeded" }]);
    expect(stewards.find((item) => item.caseId === "steward.assist-cannot-commit")?.productionToolExecutions)
      .toEqual([
        { tool: "retrieve_graph_evidence", status: "succeeded" },
        { tool: "propose_change_set", status: "succeeded" },
      ]);
    expect(stewards.find((item) => item.caseId === "steward.tool-failure-is-not-success")?.productionToolExecutions)
      .toEqual([{ tool: "retrieve_graph_evidence", status: "failed" }]);
    expect(stewards.find((item) => item.caseId === "steward.major-conflict-blocks")).toMatchObject({
      auditOperations: 6,
      productionToolExecutions: [
        { tool: "retrieve_graph_evidence", status: "succeeded" },
        { tool: "checker", status: "succeeded" },
      ],
    });
    const specialists = report.realProvider.cases.filter((item) => item.role !== "steward");
    expect(specialists).toHaveLength(3);
    expect(specialists.every((item) =>
      item.executionPath === "production-specialist-handoff"
      && item.handoffVersion === "2.0.0"
      && item.auditOperations === 4
      && item.runtimeProfileSha256 !== null
      && item.toolPolicySha256 !== null)).toBe(true);
    expect(report.publicationGate).toMatchObject({
      decision: "ready_for_manual_review",
      blockers: [],
    });
    expect(() => assertSafePromptEvalReport(report, apiKey)).not.toThrow();
    expect(JSON.stringify(report)).not.toContain(apiKey);
    expect(JSON.stringify(report)).not.toContain("raw model output");
  });
});

function stewardPlanFor(
  scenario: (typeof promptAdversarialCases)[number]["stewardToolScenario"],
) {
  if (scenario === "empty_graph" || scenario === "graph_timeout") {
    return {
      objective: "research",
      scopeResourceIds: [scenario === "empty_graph" ? "world-empty-eval" : "world-timeout-eval"],
      steps: ["retrieve_graph_evidence"],
    };
  }
  if (scenario === "assist_pending_change_set") {
    return {
      objective: "change_set",
      scopeResourceIds: ["world-coast-eval"],
      steps: ["retrieve_graph_evidence", "propose_change_set"],
    };
  }
  if (scenario === "major_conflict") {
    return {
      objective: "check",
      scopeResourceIds: ["world-conflict-eval"],
      steps: ["retrieve_graph_evidence", "checker"],
    };
  }
  return { objective: "discussion", scopeResourceIds: [], steps: [] };
}

function candidatePromptSet() {
  const candidates = loadCandidatePromptSet();
  return candidates.length === 3
    ? candidates
    : loadActivePromptSet().map((prompt) => ({ ...prompt, status: "candidate" as const }));
}

function successfulAdapterResult() {
  return {
    text: "raw model output must not enter the report",
    stopReason: "stop" as const,
    receipt: {
      actualProviderId: "eval-provider",
      actualModelId: "eval-model",
      responseIdSha256: null,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      contextPolicyVersion: "novax.estimated-tokens-v3@3.0.0",
      maxChargedInputBytes: 2_000,
      configuredContextWindow: 64_000,
      safetyReserve: 6_400,
      outputReserve: 16_000,
      correctionAttempts: 0,
    },
  };
}

function providerEnvironment(apiKey: string) {
  return {
    NOVAX_EVAL_PROVIDER_ID: "eval-provider",
    NOVAX_EVAL_PROVIDER_NAME: "Eval Provider",
    NOVAX_EVAL_PROVIDER_BASE_URL: "https://eval.example/v1",
    NOVAX_EVAL_PROVIDER_API_KEY: apiKey,
    NOVAX_EVAL_PROVIDER_MODEL: "eval-model",
    NOVAX_EVAL_PROVIDER_CONTEXT_WINDOW: "64000",
    NOVAX_EVAL_PROVIDER_MAX_TOKENS: "8000",
    NOVAX_EVAL_PROVIDER_REASONING: "false",
  };
}
