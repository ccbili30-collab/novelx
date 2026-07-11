import { createHash } from "node:crypto";
import gmPrompt from "../prompts/gm/v1.md?raw";
import { gmPromptPublication } from "./gmPromptPublication";

export interface PlayPrompt {
  id: "novax.gm";
  role: "gm";
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

const prompt: PlayPrompt = {
  id: "novax.gm",
  role: "gm",
  version: "1.0.0",
  status: gmPromptPublication.status,
  sha256: "e5e6189fc52ba18d2e2f4b81a567f5905d02451576f3685df8844db814b7c23f",
  content: gmPrompt,
  publicationEvidence: gmPromptPublication.evidence,
};

export function loadGmPrompt(): PlayPrompt {
  const actual = createHash("sha256").update(prompt.content, "utf8").digest("hex");
  if (actual !== prompt.sha256) throw promptError("PLAY_PROMPT_INTEGRITY_FAILED");
  return { ...prompt };
}

export function requireActiveGmPrompt(): PlayPrompt {
  const current = loadGmPrompt();
  if (current.status !== "active" || !current.publicationEvidence) {
    throw promptError("PLAY_PROMPT_NOT_PUBLISHED");
  }
  return current;
}

function promptError(code: string): Error & { code: string } {
  return Object.assign(new Error("Play Prompt publication gate failed."), { code });
}
