import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptManifest } from "../src/agent-worker/prompts/manifest.ts";
import { verifyPromptPublicationEvidence } from "../src/agent-worker/promptPublicationGate.ts";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = appRoot;

try {
  const result = verifyPromptPublicationEvidence({ manifest: promptManifest, repositoryRoot });
  process.stdout.write(`${JSON.stringify({
    status: "verified",
    activePrompts: result.activePrompts,
    reportPath: result.reportPath,
  })}\n`);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "PROMPT_PUBLICATION_GATE_FAILED";
  process.stderr.write(`${JSON.stringify({ status: "blocked", code })}\n`);
  process.exitCode = 1;
}
