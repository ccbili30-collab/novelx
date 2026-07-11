import { createHash } from "node:crypto";
import decomposerPrompt from "../prompts/decomposer/v1.md?raw";
import { decomposerPromptPublication } from "./decomposerPromptPublication";

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
  version: "1.1.0",
  status: decomposerPromptPublication.status,
  sha256: "eadcabbf9c0eab271364fbdd65b4049546d2d3cbc38d54c09f36fa917b60f548",
  content: decomposerPrompt,
  publicationEvidence: decomposerPromptPublication.evidence,
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
