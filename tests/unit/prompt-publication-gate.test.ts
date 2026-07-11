import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPromptPublicationEvidence } from "../../src/agent-worker/promptPublicationGate";
import type { PromptEvalReport } from "../../src/agent-worker/promptEvalReportSchema";
import type { PromptManifestEntry, PromptRole } from "../../src/agent-worker/prompts/manifest";
import { getAgentRuntimeProfile } from "../../src/shared/agentRuntimeProfiles";
import { CONTEXT_ADMISSION_POLICY_VERSION } from "../../src/shared/contextAdmissionContract";

const roots: string[] = [];
const evaluatedAt = "2026-07-10T10:00:00.000Z";
const providerId = "openai-compatible";
const modelId = "test-model";
const hashes: Record<PromptRole, string> = {
  steward: "1".repeat(64),
  writer: "2".repeat(64),
  checker: "3".repeat(64),
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Prompt publication evidence gate", () => {
  it("allows builds with no active Prompt while live loading remains separately blocked", () => {
    expect(verifyPromptPublicationEvidence({ manifest: [], repositoryRoot: createRoot() })).toEqual({
      ok: true,
      activePrompts: 0,
      reportPath: null,
    });
  });

  it("accepts one real ready report bound to the complete active Prompt set", () => {
    const fixture = createFixture();

    expect(verifyPromptPublicationEvidence(fixture)).toEqual({
      ok: true,
      activePrompts: 3,
      reportPath: fixture.absoluteReportPath,
    });
  });

  it("fails closed when report bytes no longer match the manifest SHA-256", () => {
    const fixture = createFixture();
    fs.appendFileSync(fixture.absoluteReportPath, " ", "utf8");

    expectGateCode(fixture, "PROMPT_PUBLICATION_REPORT_HASH_MISMATCH");
  });

  it("fails closed on an invalid report schema even when its new hash is recorded", () => {
    const fixture = createFixture({ report: { formatVersion: 1 } });

    expectGateCode(fixture, "PROMPT_PUBLICATION_REPORT_INVALID");
  });

  it("rejects a valid blocked report", () => {
    const report = createReport();
    report.publicationGate = { decision: "blocked", blockers: ["MANUAL_BLOCKER"], autoActivated: false };
    const fixture = createFixture({ report });

    expectGateCode(fixture, "PROMPT_PUBLICATION_NOT_READY");
  });

  it("rejects any Prompt identity mismatch", () => {
    const report = createReport();
    report.prompts[1]!.sha256 = "f".repeat(64);
    const fixture = createFixture({ report });

    expectGateCode(fixture, "PROMPT_PUBLICATION_IDENTITY_MISMATCH");
  });

  it.each([
    ["providerId", "another-provider"],
    ["modelId", "another-model"],
    ["evaluatedAt", "2026-07-10T11:00:00.000Z"],
  ] as const)("rejects manifest evidence with mismatched %s", (field, value) => {
    const fixture = createFixture();
    fixture.manifest = fixture.manifest.map((entry) => ({
      ...entry,
      publicationEvidence: entry.publicationEvidence && { ...entry.publicationEvidence, [field]: value },
    }));

    expectGateCode(fixture, "PROMPT_PUBLICATION_PROVIDER_MISMATCH");
  });

  it("rejects per-case Provider receipts that disagree with the manifest", () => {
    const report = createReport();
    report.realProvider.cases[0]!.actualModelId = "different-model";
    const fixture = createFixture({ report });

    expectGateCode(fixture, "PROMPT_PUBLICATION_PROVIDER_MISMATCH");
  });

  it("requires all active roles to share the same evidence receipt", () => {
    const fixture = createFixture();
    fixture.manifest = fixture.manifest.map((entry, index) => index === 2
      ? { ...entry, publicationEvidence: entry.publicationEvidence && { ...entry.publicationEvidence, modelId: "other" } }
      : entry);

    expectGateCode(fixture, "PROMPT_PUBLICATION_EVIDENCE_MISMATCH");
  });

  it("rejects reports evaluated against stale runtime or tool-policy identities", () => {
    const report = createReport();
    report.realProvider.cases[0]!.runtimeProfileSha256 = "f".repeat(64);
    const staleRuntime = createFixture({ report });
    expectGateCode(staleRuntime, "PROMPT_PUBLICATION_RUNTIME_MISMATCH");

    const policyReport = createReport();
    policyReport.realProvider.cases[0]!.toolPolicySha256 = "e".repeat(64);
    const stalePolicy = createFixture({ report: policyReport });
    expectGateCode(stalePolicy, "PROMPT_PUBLICATION_RUNTIME_MISMATCH");
  });

  it("rejects partial active sets and governed-directory traversal", () => {
    const partial = createFixture();
    partial.manifest = partial.manifest.slice(0, 2);
    expectGateCode(partial, "PROMPT_PUBLICATION_ACTIVE_SET_INVALID");

    const traversal = createFixture();
    traversal.manifest = traversal.manifest.map((entry) => ({
      ...entry,
      publicationEvidence: entry.publicationEvidence && {
        ...entry.publicationEvidence,
        reportPath: "notes/evidence/novax-desktop-prompt-evals/../../outside.json",
      },
    }));
    expectGateCode(traversal, "PROMPT_PUBLICATION_REPORT_PATH_INVALID");
  });
});

interface Fixture {
  manifest: PromptManifestEntry[];
  repositoryRoot: string;
  absoluteReportPath: string;
}

function createFixture(options: { report?: unknown } = {}): Fixture {
  const repositoryRoot = createRoot();
  const relativeReportPath = "notes/evidence/novax-desktop-prompt-evals/prompt-eval-test.json";
  const absoluteReportPath = path.join(repositoryRoot, ...relativeReportPath.split("/"));
  fs.mkdirSync(path.dirname(absoluteReportPath), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(options.report ?? createReport(), null, 2)}\n`, "utf8");
  fs.writeFileSync(absoluteReportPath, bytes);
  const reportSha256 = createHash("sha256").update(bytes).digest("hex");
  const publicationEvidence = {
    reportPath: relativeReportPath,
    reportSha256,
    providerId,
    modelId,
    actualModelIds: [modelId],
    evaluatedAt,
  };
  return {
    repositoryRoot,
    absoluteReportPath,
    manifest: (["steward", "writer", "checker"] as const).map((role) => ({
      assetKey: `novax.${role}@1.0.0`,
      id: `novax.${role}`,
      role,
      version: "1.0.0",
      status: "active",
      rollbackTo: null,
      scope: "desktop.world-to-story",
      changeSummary: "test",
      publishedSha256: hashes[role],
      publicationEvidence,
    })),
  };
}

function createReport(): PromptEvalReport {
  return {
    formatVersion: 4,
    classification: "candidate-prompt-publication-evaluation",
    generatedAt: evaluatedAt,
    run: { status: "completed", reasonCode: "REAL_PROVIDER_EVAL_COMPLETED" },
    provider: { providerId, displayName: "Test Provider", modelId },
    prompts: (["steward", "writer", "checker"] as const).map((role) => ({
      id: `novax.${role}`,
      role,
      version: "1.0.0",
      sha256: hashes[role],
      status: "candidate",
    })),
    offline: {
      classification: "fixture-only-not-live-evidence",
      cases: 2,
      compliantAccepted: 1,
      violationsRejected: 1,
    },
    realProvider: {
      status: "completed",
      cases: [createCase("steward"), createCase("writer"), createCase("checker")],
    },
    publicationGate: { decision: "ready_for_manual_review", blockers: [], autoActivated: false },
  };
}

function createCase(role: PromptRole): PromptEvalReport["realProvider"]["cases"][number] {
  const runtimeProfile = getAgentRuntimeProfile(role);
  return {
    caseId: `${role}.test`,
    role,
    passed: true,
    failureCodes: [],
    durationMs: 1,
    submissions: 1,
    outputSha256: "a".repeat(64),
    errorCode: null,
    executionPath: role === "steward" ? "production-steward-runtime" : "production-specialist-handoff",
    handoffVersion: role === "steward" ? null : "2.0.0",
    auditOperations: role === "steward" ? 2 : 4,
    runtimeProfileSha256: runtimeProfile.sha256,
    toolPolicySha256: runtimeProfile.toolPolicySha256,
    actualProviderId: providerId,
    actualModelId: modelId,
    contextPolicyVersion: CONTEXT_ADMISSION_POLICY_VERSION,
    correctionAttempts: 0,
    productionToolExecutions: [],
  };
}

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novax-prompt-publication-"));
  roots.push(root);
  return root;
}

function expectGateCode(fixture: Pick<Fixture, "manifest" | "repositoryRoot">, code: string): void {
  expect(() => verifyPromptPublicationEvidence(fixture)).toThrow(expect.objectContaining({ code }));
}
