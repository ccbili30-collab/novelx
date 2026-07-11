import fs from "node:fs";
import path from "node:path";
import type { AgentWorkerDiagnostic } from "./agentProcessSupervisor";

const LOG_FILE_NAME = "agent-worker-diagnostics.jsonl";
const MAX_LOG_BYTES = 1_000_000;

export function createAgentWorkerDiagnosticReporter(userDataPath: string): (diagnostic: AgentWorkerDiagnostic) => void {
  const logPath = path.join(userDataPath, LOG_FILE_NAME);
  return (diagnostic) => {
    try {
      fs.mkdirSync(userDataPath, { recursive: true });
      if (fs.existsSync(logPath) && fs.statSync(logPath).size >= MAX_LOG_BYTES) {
        const previousPath = `${logPath}.previous`;
        fs.rmSync(previousPath, { force: true });
        fs.renameSync(logPath, previousPath);
      }
      fs.appendFileSync(logPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...diagnostic,
        errorMessage: diagnostic.errorMessage?.slice(0, 500),
      })}\n`, "utf8");
    } catch {
      // Diagnostics must never replace the original fail-closed runtime behavior.
    }
  };
}
