import fs from "node:fs";
import path from "node:path";
import { assertSafePromptEvalReport, runCandidatePromptEvaluation } from "./promptEvalRunner";

async function main(): Promise<void> {
  const report = await runCandidatePromptEvaluation({ env: process.env });
  assertSafePromptEvalReport(report, process.env.NOVAX_EVAL_PROVIDER_API_KEY);
  const reportDirectory = resolveReportDirectory(process.env.NOVAX_EVAL_REPORT_DIR);
  fs.mkdirSync(reportDirectory, { recursive: true });
  const timestamp = report.generatedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(reportDirectory, `prompt-eval-${timestamp}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

  process.stdout.write(`${JSON.stringify({
    status: report.run.status,
    reasonCode: report.run.reasonCode,
    publicationGate: report.publicationGate.decision,
    reportPath,
  })}\n`);
  if (report.run.status === "not_run") process.exitCode = 2;
  else if (report.publicationGate.decision === "blocked") process.exitCode = 1;
}

function resolveReportDirectory(configured: string | undefined): string {
  if (configured?.trim()) return path.resolve(configured.trim());
  return path.resolve(process.cwd(), "notes", "evidence", "novax-desktop-prompt-evals");
}

export const promptEvalCompletion = main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "PROMPT_EVAL_RUNNER_FAILED";
  process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
  process.exitCode = 1;
});
