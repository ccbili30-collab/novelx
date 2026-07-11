import { createHash } from "node:crypto";
import decomposerPrompt from "../prompts/decomposer/v1.md?raw";

export interface DecomposerPrompt {
  id: "novax.decomposer";
  role: "decomposer";
  version: `${number}.${number}.${number}`;
  status: "candidate" | "active" | "deprecated";
  sha256: string;
  content: string;
  publicationEvidence: {
    reportPath: string;
    reportSha256: string;
    providerId: string;
    modelId: string;
    evaluatedAt: string;
  } | null;
}

const prompt: DecomposerPrompt = {
  id: "novax.decomposer",
  role: "decomposer",
  version: "1.0.0",
  status: "candidate",
  sha256: "e8b432eccecf934fc197c92c8a385bc3865bd0192d9819315bcc6217dcb4a7e0",
  content: decomposerPrompt,
  publicationEvidence: null,
};

export function loadDecomposerPrompt(): DecomposerPrompt {
  const actual = createHash("sha256").update(prompt.content, "utf8").digest("hex");
  if (actual !== prompt.sha256) throw promptError("DECOMPOSER_PROMPT_INTEGRITY_FAILED");
  return { ...prompt };
}

export function requireActiveDecomposerPrompt(): DecomposerPrompt {
  const current = loadDecomposerPrompt();
  if (current.status !== "active" || !current.publicationEvidence) {
    throw promptError("DECOMPOSER_PROMPT_NOT_PUBLISHED");
  }
  return current;
}

function promptError(code: string): Error & { code: string } {
  return Object.assign(new Error("Decomposer Prompt publication gate failed."), { code });
}
