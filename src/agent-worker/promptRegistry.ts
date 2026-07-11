import { createHash } from "node:crypto";
import checkerPrompt from "./prompts/checker/v1.md?raw";
import checkerPromptV1_1 from "./prompts/checker/v1.1.md?raw";
import { promptManifest, type PromptManifestEntry, type PromptRole } from "./prompts/manifest";
import stewardPrompt from "./prompts/steward/v1.md?raw";
import stewardPromptV1_1 from "./prompts/steward/v1.1.md?raw";
import stewardPromptV1_2 from "./prompts/steward/v1.2.md?raw";
import stewardPromptV1_3 from "./prompts/steward/v1.3.md?raw";
import stewardPromptV1_4 from "./prompts/steward/v1.4.md?raw";
import stewardPromptV1_5 from "./prompts/steward/v1.5.md?raw";
import stewardPromptV1_6 from "./prompts/steward/v1.6.md?raw";
import stewardPromptV1_7 from "./prompts/steward/v1.7.md?raw";
import stewardPromptV1_8FileToolsAddendum from "./prompts/steward/v1.8-file-tools-addendum.md?raw";
import stewardPromptV1_9LongContextAddendum from "./prompts/steward/v1.9-long-context-addendum.md?raw";
import writerPrompt from "./prompts/writer/v1.md?raw";

const promptContent: Record<string, string> = {
  "novax.steward@1.0.0": stewardPrompt,
  "novax.steward@1.1.0": stewardPromptV1_1,
  "novax.steward@1.2.0": stewardPromptV1_2,
  "novax.steward@1.3.0": stewardPromptV1_3,
  "novax.steward@1.4.0": stewardPromptV1_4,
  "novax.steward@1.5.0": stewardPromptV1_5,
  "novax.steward@1.6.0": stewardPromptV1_5,
  "novax.steward@1.7.0": stewardPromptV1_5,
  "novax.steward@1.8.0": stewardPromptV1_6,
  "novax.steward@1.9.0": stewardPromptV1_7,
  "novax.steward@1.10.0": `${stewardPromptV1_7}\n${stewardPromptV1_8FileToolsAddendum}`,
  "novax.steward@1.11.0": `${stewardPromptV1_7}\n${stewardPromptV1_8FileToolsAddendum}\n${stewardPromptV1_9LongContextAddendum}`,
  "novax.writer@1.0.0": writerPrompt,
  "novax.writer@1.1.0": writerPrompt,
  "novax.writer@1.2.0": writerPrompt,
  "novax.writer@1.3.0": writerPrompt,
  "novax.writer@1.4.0": writerPrompt,
  "novax.writer@1.5.0": writerPrompt,
  "novax.writer@1.6.0": writerPrompt,
  "novax.checker@1.0.0": checkerPrompt,
  "novax.checker@1.1.0": checkerPromptV1_1,
  "novax.checker@1.2.0": checkerPromptV1_1,
  "novax.checker@1.3.0": checkerPromptV1_1,
  "novax.checker@1.4.0": checkerPromptV1_1,
  "novax.checker@1.5.0": checkerPromptV1_1,
  "novax.checker@1.6.0": checkerPromptV1_1,
  "novax.checker@1.7.0": checkerPromptV1_1,
};

export interface PublishedPrompt {
  id: `novax.${PromptRole}`;
  role: PromptRole;
  version: `${number}.${number}.${number}`;
  status: "candidate" | "active" | "deprecated";
  rollbackTo: string | null;
  sha256: string;
  content: string;
}

export function loadActivePromptSet(): PublishedPrompt[] {
  verifyPromptRegistry();
  const active = promptManifest.filter((entry) => entry.status === "active");
  if (active.length !== 3) {
    throw promptRegistryError("PROMPT_SET_NOT_PUBLISHED", "The complete Prompt set has not passed its publication gate.");
  }
  const prompts = materialize(active);
  for (const role of ["steward", "writer", "checker"] as const) requireActivePrompt(prompts, role);
  return prompts;
}

export function loadCandidatePromptSet(): PublishedPrompt[] {
  verifyPromptRegistry();
  return materialize(promptManifest.filter((entry) => entry.status === "candidate"));
}

function materialize(entries: readonly PromptManifestEntry[]): PublishedPrompt[] {
  return entries.map((entry) => ({
      id: entry.id,
      role: entry.role,
      version: entry.version,
      status: entry.status,
      rollbackTo: entry.rollbackTo,
      sha256: entry.publishedSha256,
      content: promptContent[entry.assetKey],
    }));
}

export function verifyPromptRegistry(): { ok: true; verified: number } {
  for (const entry of promptManifest) {
    const actual = sha256(promptContent[entry.assetKey]);
    if (actual !== entry.publishedSha256) {
      throw promptRegistryError(
        "PROMPT_INTEGRITY_FAILED",
        `Prompt integrity check failed for ${entry.id}@${entry.version}.`,
      );
    }
    if (entry.status === "active") {
      const evidence = entry.publicationEvidence;
      if (
        !evidence
        || !/^[a-f0-9]{64}$/.test(evidence.reportSha256)
        || !evidence.reportPath.startsWith("notes/evidence/novax-desktop-prompt-evals/")
      ) {
        throw promptRegistryError(
          "PROMPT_SET_NOT_PUBLISHED",
          `Active Prompt lacks verified publication evidence: ${entry.id}@${entry.version}.`,
        );
      }
    }
  }
  return { ok: true, verified: promptManifest.length };
}

export function requireActivePrompt(prompts: PublishedPrompt[], role: PromptRole): PublishedPrompt {
  const matches = prompts.filter((candidate) => candidate.role === role);
  const prompt = matches[0];
  if (
    matches.length !== 1
    || !prompt
    || prompt.id !== `novax.${role}`
    || prompt.status !== "active"
  ) {
    throw promptRegistryError("PROMPT_SET_NOT_PUBLISHED", `Active Prompt missing or ambiguous for role: ${role}.`);
  }
  return prompt;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function promptRegistryError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
