import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { assertSafePromptEvalReport, runCandidatePromptEvaluation } from "./promptEvalRunner";

const userDataPath = path.resolve(
  process.env.NOVAX_EVAL_USER_DATA?.trim()
    || path.join(process.env.APPDATA || "", "novelx-desktop"),
);
app.setPath("userData", userDataPath);

async function main(): Promise<void> {
  await app.whenReady();
  const providerStorePath = path.join(userDataPath, "provider-profile.v1.json");
  const envelope = JSON.parse(fs.readFileSync(providerStorePath, "utf8")) as {
    config: {
      providerId: string;
      displayName: string;
      baseUrl: string;
      modelId: string;
      contextWindow: number;
      maxTokens: number | null;
      reasoning: boolean;
    };
    encryptedCredential: string | null;
  };
  if (!safeStorage.isEncryptionAvailable() || !envelope.encryptedCredential) {
    throw cliError("REAL_PROVIDER_CONFIG_REQUIRED");
  }
  const apiKey = safeStorage.decryptString(Buffer.from(envelope.encryptedCredential, "base64"));
  const modelId = envelope.config.providerId === "openai-compatible"
    && envelope.config.baseUrl.includes("api.deepseek.com")
    ? "deepseek-chat"
    : envelope.config.modelId;
  const env = {
    NOVAX_EVAL_PROVIDER_ID: envelope.config.providerId,
    NOVAX_EVAL_PROVIDER_NAME: envelope.config.displayName,
    NOVAX_EVAL_PROVIDER_BASE_URL: envelope.config.baseUrl,
    NOVAX_EVAL_PROVIDER_API_KEY: apiKey,
    NOVAX_EVAL_PROVIDER_MODEL: modelId,
    NOVAX_EVAL_PROVIDER_CONTEXT_WINDOW: String(envelope.config.contextWindow),
    NOVAX_EVAL_PROVIDER_MAX_TOKENS: String(envelope.config.maxTokens ?? 8192),
    NOVAX_EVAL_PROVIDER_REASONING: String(envelope.config.reasoning),
    NOVAX_EVAL_CASE_TIMEOUT_MS: process.env.NOVAX_EVAL_CASE_TIMEOUT_MS || "60000",
  };
  const report = await runCandidatePromptEvaluation({
    env,
    onCaseProgress: (event) => process.stdout.write(`${JSON.stringify({ type: "case.progress", ...event })}\n`),
  });
  assertSafePromptEvalReport(report, apiKey);
  const reportDirectory = path.resolve(
    process.env.NOVAX_EVAL_REPORT_DIR?.trim()
      || path.join(process.cwd(), "notes", "evidence", "novax-desktop-prompt-evals"),
  );
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, `prompt-eval-${report.generatedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    type: "evaluation.completed",
    status: report.run.status,
    publicationGate: report.publicationGate.decision,
    reportPath,
  })}\n`);
  process.exitCode = report.publicationGate.decision === "blocked" ? 1 : 0;
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "PROMPT_EVAL_RUNNER_FAILED";
  process.stderr.write(`${JSON.stringify({ type: "evaluation.failed", code })}\n`);
  process.exitCode = 1;
}).finally(() => app.exit(typeof process.exitCode === "number" ? process.exitCode : 1));

function cliError(code: string): Error & { code: string } {
  return Object.assign(new Error("Electron prompt evaluation failed."), { code });
}
