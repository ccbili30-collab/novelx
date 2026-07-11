import type { AgentTool } from "@earendil-works/pi-agent-core";
import { checkerOutputSchema, writerOutputSchema } from "../contracts/roleOutputs";
import type { ProviderRuntimeProfile } from "../../shared/providerContract";
import type { RuntimeAdapter } from "../pi/runtimeAdapterContract";
import type { PlayPrompt } from "./playPromptRegistry";
import { runGmTurn, type GmTurnInput } from "./gmTurnRuntime";
import type { GmTurnLifecycle } from "./gmTurnRuntime";
import { validateTurnPipeline, type AcceptedTurnPipeline } from "./turnValidator";

export interface PlayerTurnPipelineResult extends AcceptedTurnPipeline {
  stateSnapshot: Record<string, unknown>;
}

export async function runPlayerTurnPipeline(input: {
  turn: GmTurnInput;
  styleConstraints: string[];
  providerProfile: ProviderRuntimeProfile;
  gmPrompt: PlayPrompt;
  createAdapter(profile: ProviderRuntimeProfile): RuntimeAdapter;
  specialistTools: AgentTool[];
  signal: AbortSignal;
  gmLifecycle?: GmTurnLifecycle;
}): Promise<PlayerTurnPipelineResult> {
  const gm = await runGmTurn({
    turn: input.turn,
    providerProfile: input.providerProfile,
    prompt: input.gmPrompt,
    createAdapter: input.createAdapter,
    signal: input.signal,
    lifecycle: input.gmLifecycle,
  });
  if (gm.status === "blocked") throw pipelineError("GM_RESOLUTION_BLOCKED");
  const writerTool = requireTool(input.specialistTools, "writer");
  const writerResult = await writerTool.execute("player-writer", {
    instruction: "Render this immutable GM resolution as player-visible prose. Do not add outcomes.",
    sourceMaterial: input.turn.canonicalEvidence,
    evidenceIds: gm.evidenceIds,
    gmResolution: JSON.stringify(gm),
    gmResolutionId: gm.resolutionId,
    styleConstraints: input.styleConstraints,
  }, input.signal);
  const writer = writerOutputSchema.safeParse(readDetails(writerResult));
  if (!writer.success) throw pipelineError("WRITER_OUTPUT_SCHEMA_INVALID");
  if (writer.data.status !== "candidate") throw pipelineError("WRITER_TURN_BLOCKED");
  const checkerTool = requireTool(input.specialistTools, "checker");
  const checkerResult = await checkerTool.execute("player-checker", {
    candidateText: writer.data.candidateText,
    sourceMaterial: JSON.stringify({ canonicalEvidence: input.turn.canonicalEvidence, gmResolution: gm }),
    evidenceIds: gm.evidenceIds,
    constraints: [
      "Writer may not add success, failure, damage, reward, clue, NPC decision, or state change absent from gmResolution.",
      "Writer may not expose hidden facts absent from narrativeFacts.",
      ...input.styleConstraints,
    ],
  }, input.signal);
  const checker = checkerOutputSchema.safeParse(readDetails(checkerResult));
  if (!checker.success) throw pipelineError("CHECKER_OUTPUT_SCHEMA_INVALID");
  const accepted = validateTurnPipeline({ gm, writer: writer.data, checker: checker.data });
  return {
    ...accepted,
    stateSnapshot: { ...input.turn.currentState, ...gm.stateDelta },
  };
}

function requireTool(tools: AgentTool[], name: "writer" | "checker"): AgentTool {
  const matches = tools.filter((tool) => tool.name === name);
  if (matches.length !== 1) throw pipelineError("PLAYER_SPECIALIST_TOOLS_INVALID");
  return matches[0]!;
}

function readDetails(result: unknown): unknown {
  return result && typeof result === "object" && "details" in result ? result.details : null;
}

function pipelineError(code: string): Error & { code: string } {
  return Object.assign(new Error("Player turn pipeline failed."), { code });
}
