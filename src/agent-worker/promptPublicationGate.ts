import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promptEvalReportSchema } from "./promptEvalReportSchema.ts";
import type { PromptManifestEntry, PromptRole } from "./prompts/manifest.ts";
import { getAgentRuntimeProfile } from "../shared/agentRuntimeProfiles.ts";
import { CONTEXT_ADMISSION_POLICY_VERSION } from "../shared/contextAdmissionContract.ts";

const REQUIRED_ROLES = ["steward", "writer", "checker"] as const satisfies readonly PromptRole[];
const EVIDENCE_DIRECTORY = "notes/evidence/novax-desktop-prompt-evals";

export interface PromptPublicationGateInput {
  manifest: readonly PromptManifestEntry[];
  repositoryRoot: string;
}

export interface PromptPublicationGateResult {
  ok: true;
  activePrompts: number;
  reportPath: string | null;
}

export function verifyPromptPublicationEvidence(
  input: PromptPublicationGateInput,
): PromptPublicationGateResult {
  const active = input.manifest.filter((entry) => entry.status === "active");
  if (active.length === 0) return { ok: true, activePrompts: 0, reportPath: null };

  assertCompleteActiveSet(active);
  const evidence = requireSharedEvidence(active);
  const reportPath = resolveEvidencePath(input.repositoryRoot, evidence.reportPath);
  const reportBytes = readEvidence(reportPath);
  if (sha256(reportBytes) !== evidence.reportSha256) {
    throw publicationError("PROMPT_PUBLICATION_REPORT_HASH_MISMATCH", "Prompt publication report SHA-256 does not match the manifest.");
  }

  let rawReport: unknown;
  try {
    rawReport = JSON.parse(reportBytes.toString("utf8"));
  } catch {
    throw publicationError("PROMPT_PUBLICATION_REPORT_INVALID", "Prompt publication report is not valid UTF-8 JSON.");
  }
  const parsed = promptEvalReportSchema.safeParse(rawReport);
  if (!parsed.success) {
    throw publicationError("PROMPT_PUBLICATION_REPORT_INVALID", "Prompt publication report does not match the required schema.");
  }
  const report = parsed.data;
  if (report.publicationGate.decision !== "ready_for_manual_review") {
    throw publicationError("PROMPT_PUBLICATION_NOT_READY", "Prompt publication report is not ready for manual review.");
  }
  if (!report.provider) {
    throw publicationError("PROMPT_PUBLICATION_PROVIDER_MISMATCH", "Prompt publication report lacks real Provider evidence.");
  }
  if (
    report.provider.providerId !== evidence.providerId
    || report.provider.modelId !== evidence.modelId
    || report.generatedAt !== evidence.evaluatedAt
    || report.realProvider.cases.some((item) => item.actualProviderId !== evidence.providerId || item.actualModelId === null)
    || JSON.stringify(uniqueSorted(report.realProvider.cases.map((item) => item.actualModelId!)))
      !== JSON.stringify(uniqueSorted(evidence.actualModelIds))
  ) {
    throw publicationError("PROMPT_PUBLICATION_PROVIDER_MISMATCH", "Prompt publication Provider, model, or evaluation time does not match the manifest.");
  }

  const reportPrompts = new Map(report.prompts.map((prompt) => [prompt.role, prompt]));
  for (const entry of active) {
    const evaluated = reportPrompts.get(entry.role);
    if (
      !evaluated
      || evaluated.id !== entry.id
      || evaluated.version !== entry.version
      || evaluated.sha256 !== entry.publishedSha256
    ) {
      throw publicationError("PROMPT_PUBLICATION_IDENTITY_MISMATCH", `Evaluated Prompt identity does not match active ${entry.role}.`);
    }
    const runtimeProfile = getAgentRuntimeProfile(entry.role);
    const roleCases = report.realProvider.cases.filter((item) => item.role === entry.role);
    if (roleCases.length === 0 || roleCases.some((item) => (
      item.runtimeProfileSha256 !== runtimeProfile.sha256
      || item.toolPolicySha256 !== runtimeProfile.toolPolicySha256
      || item.contextPolicyVersion !== CONTEXT_ADMISSION_POLICY_VERSION
    ))) {
      throw publicationError(
        "PROMPT_PUBLICATION_RUNTIME_MISMATCH",
        `Evaluated runtime identity does not match active ${entry.role}.`,
      );
    }
  }

  return { ok: true, activePrompts: active.length, reportPath };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function assertCompleteActiveSet(active: readonly PromptManifestEntry[]): void {
  if (active.length !== REQUIRED_ROLES.length) {
    throw publicationError("PROMPT_PUBLICATION_ACTIVE_SET_INVALID", "Active Prompt set must contain exactly three roles.");
  }
  for (const role of REQUIRED_ROLES) {
    const matches = active.filter((entry) => entry.role === role && entry.id === `novax.${role}`);
    if (matches.length !== 1) {
      throw publicationError("PROMPT_PUBLICATION_ACTIVE_SET_INVALID", `Active Prompt missing or ambiguous for role: ${role}.`);
    }
  }
}

function requireSharedEvidence(active: readonly PromptManifestEntry[]): NonNullable<PromptManifestEntry["publicationEvidence"]> {
  const first = active[0]?.publicationEvidence;
  if (!first) {
    throw publicationError("PROMPT_PUBLICATION_EVIDENCE_MISSING", "Active Prompt lacks publication evidence.");
  }
  const fingerprint = JSON.stringify(first);
  if (active.some((entry) => !entry.publicationEvidence || JSON.stringify(entry.publicationEvidence) !== fingerprint)) {
    throw publicationError("PROMPT_PUBLICATION_EVIDENCE_MISMATCH", "Active Prompt set must share one publication report and Provider receipt.");
  }
  return first;
}

function resolveEvidencePath(repositoryRoot: string, reportPath: string): string {
  const normalized = reportPath.replace(/\\/g, "/");
  if (!normalized.startsWith(`${EVIDENCE_DIRECTORY}/`) || path.isAbsolute(reportPath)) {
    throw publicationError("PROMPT_PUBLICATION_REPORT_PATH_INVALID", "Prompt publication report must be inside the governed evidence directory.");
  }
  const evidenceRoot = path.resolve(repositoryRoot, ...EVIDENCE_DIRECTORY.split("/"));
  const resolved = path.resolve(repositoryRoot, ...normalized.split("/"));
  const relative = path.relative(evidenceRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw publicationError("PROMPT_PUBLICATION_REPORT_PATH_INVALID", "Prompt publication report path escapes or names the governed evidence directory.");
  }
  return resolved;
}

function readEvidence(reportPath: string): Buffer {
  try {
    return fs.readFileSync(reportPath);
  } catch {
    throw publicationError("PROMPT_PUBLICATION_REPORT_UNREADABLE", "Prompt publication report cannot be read.");
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function publicationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
