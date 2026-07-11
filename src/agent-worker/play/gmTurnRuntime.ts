import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ProviderRuntimeProfile } from "../../shared/providerContract";
import type { RuntimeAdapter } from "../pi/runtimeAdapterContract";
import type { PlayPrompt } from "./playPromptRegistry";
import { gmTurnOutputParameters, gmTurnOutputSchema, type GmTurnOutput } from "./gmTurnContracts";

export interface GmTurnInput {
  playerAction: string;
  canonicalEvidence: string;
  evidenceIds: string[];
  currentState: Record<string, unknown>;
  recentMemory: string;
  luck: number;
}

export async function runGmTurn(input: {
  turn: GmTurnInput;
  providerProfile: ProviderRuntimeProfile;
  prompt: PlayPrompt;
  createAdapter(profile: ProviderRuntimeProfile): RuntimeAdapter;
  signal: AbortSignal;
}): Promise<GmTurnOutput> {
  if (input.prompt.status !== "active" || !input.prompt.publicationEvidence) throw runtimeError("PLAY_PROMPT_NOT_PUBLISHED");
  const evidenceIds = new Set(input.turn.evidenceIds);
  if (evidenceIds.size === 0) throw runtimeError("GM_EVIDENCE_REQUIRED");
  let submission: GmTurnOutput | null = null;
  let count = 0;
  const tool: AgentTool = {
    name: "submit_gm_result",
    label: "提交 GM 裁决",
    description: "Submit exactly one structured GM resolution or blocked result.",
    parameters: gmTurnOutputParameters,
    execute: async (_toolCallId, params) => {
      count += 1;
      const parsed = gmTurnOutputSchema.safeParse(params);
      if (!parsed.success) throw runtimeError("GM_OUTPUT_SCHEMA_INVALID");
      submission = parsed.data;
      return { content: [{ type: "text", text: "GM result accepted." }], details: { accepted: true } };
    },
  };
  const handoff = JSON.stringify({
    contract: "novax.gm-turn@1.0.0",
    playerAction: input.turn.playerAction,
    canonicalEvidence: input.turn.canonicalEvidence,
    evidenceIds: input.turn.evidenceIds,
    currentState: input.turn.currentState,
    recentMemory: input.turn.recentMemory,
    luck: input.turn.luck,
  });
  await input.createAdapter(input.providerProfile).run({
    systemPrompt: input.prompt.content,
    userInput: handoff,
    tools: [tool],
    signal: input.signal,
    completionGuard: { toolName: "submit_gm_result", isSatisfied: () => submission !== null },
  });
  if (count !== 1 || !submission) throw runtimeError("GM_OUTPUT_REQUIRED");
  const result = submission as GmTurnOutput;
  const cited = result.status === "resolved" ? result.evidenceIds : result.reasons.flatMap((reason) => reason.evidenceIds);
  if (cited.some((id) => !evidenceIds.has(id))) throw runtimeError("GM_EVIDENCE_MISMATCH");
  return result;
}

function runtimeError(code: string): Error & { code: string } {
  return Object.assign(new Error("GM turn runtime failed."), { code });
}
