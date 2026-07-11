import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { decomposerPromptPublication as publication } from "../src/agent-worker/import/decomposerPromptPublication.ts";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
try {
  const promptPath = path.join(root, "src/agent-worker/prompts/decomposer/v1.md");
  if (sha(fs.readFileSync(promptPath)) !== publication.promptSha256) throw gateError("DECOMPOSER_PROMPT_HASH_MISMATCH");
  const reportPath = path.join(root, publication.evidence.reportPath); const bytes = fs.readFileSync(reportPath);
  if (sha(bytes) !== publication.evidence.reportSha256) throw gateError("DECOMPOSER_EVAL_REPORT_HASH_MISMATCH");
  const report = JSON.parse(bytes.toString("utf8"));
  if (report.classification !== "decomposer-prompt-publication-evaluation" || report.publicationGate?.decision !== "ready_for_manual_review"
    || report.prompt?.id !== publication.id || report.prompt?.version !== publication.version || report.prompt?.sha256 !== publication.promptSha256
    || report.provider?.providerId !== publication.evidence.providerId || report.provider?.modelId !== publication.evidence.modelId
    || report.generatedAt !== publication.evidence.evaluatedAt || !Array.isArray(report.cases) || report.cases.length < 3
    || report.cases.some((item) => item.passed !== true || item.actualProviderId === null || item.contextPolicyVersion === null)) throw gateError("DECOMPOSER_EVAL_REPORT_REJECTED");
  process.stdout.write(`${JSON.stringify({ status: "verified", promptId: publication.id, version: publication.version, reportPath: publication.evidence.reportPath })}\n`);
} catch (error) { process.stderr.write(`${JSON.stringify({ status: "blocked", code: error?.code ?? "DECOMPOSER_PUBLICATION_GATE_FAILED" })}\n`); process.exitCode = 1; }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function gateError(code) { return Object.assign(new Error("Decomposer publication gate failed."), { code }); }
