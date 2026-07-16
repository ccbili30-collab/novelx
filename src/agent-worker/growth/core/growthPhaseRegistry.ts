import type { GrowthRunBinding } from "../../../shared/agentWorkerProtocol";

export type GrowthPhaseId =
  | "closure_evaluation"
  | "closure_repair"
  | "longform_outline"
  | "longform_section"
  | "world"
  | "story"
  | "oc";

export type GrowthPhaseToolName =
  | "retrieve_graph_evidence"
  | "submit_growth_inquiry"
  | "submit_closure_self_assessment"
  | "writer"
  | "propose_change_set"
  | "generate_image";

export interface GrowthPhasePlan {
  phaseId: GrowthPhaseId;
  objective: "change_set" | "orchestrate";
  steps: GrowthPhaseToolName[];
}

/**
 * Narrow internal seam for phase-local behavior. The registry currently owns
 * plan routing; tool schemas and compilers migrate behind this interface next.
 */
export interface GrowthPhaseHandler {
  readonly id: GrowthPhaseId;
  matches(binding: GrowthRunBinding): boolean;
  plan(binding: GrowthRunBinding): Omit<GrowthPhasePlan, "phaseId">;
}

const handlers: readonly GrowthPhaseHandler[] = [
  fixedHandler("closure_evaluation", (binding) => binding.kind === "closure_evaluation", "orchestrate", [
    "retrieve_graph_evidence", "submit_closure_self_assessment",
  ]),
  fixedHandler("closure_repair", (binding) => binding.kind === "repair", "change_set", [
    "retrieve_graph_evidence", "propose_change_set",
  ]),
  fixedHandler("longform_outline", (binding) => binding.longformAuthority?.phase === "outline", "change_set", [
    "retrieve_graph_evidence", "submit_growth_inquiry", "propose_change_set",
  ]),
  fixedHandler("longform_section", (binding) => binding.longformAuthority?.phase === "section", "change_set", [
    "retrieve_graph_evidence", "submit_growth_inquiry", "writer", "propose_change_set",
  ]),
  contentHandler("world", ["retrieve_graph_evidence", "submit_growth_inquiry", "propose_change_set", "generate_image"]),
  contentHandler("story", ["retrieve_graph_evidence", "submit_growth_inquiry", "writer", "propose_change_set"]),
  contentHandler("oc", ["retrieve_graph_evidence", "submit_growth_inquiry", "propose_change_set"]),
];

export function resolveGrowthPhasePlan(binding: GrowthRunBinding): GrowthPhasePlan {
  if (binding.kind === "revision") throw phaseError("STEWARD_GROWTH_REVISION_NOT_IMPLEMENTED");
  const matches = handlers.filter((handler) => handler.matches(binding));
  if (matches.length !== 1) throw phaseError("GROWTH_PHASE_REGISTRY_INVALID");
  const handler = matches[0]!;
  return { phaseId: handler.id, ...handler.plan(binding) };
}

function fixedHandler(
  id: GrowthPhaseId,
  matches: (binding: GrowthRunBinding) => boolean,
  objective: GrowthPhasePlan["objective"],
  steps: GrowthPhaseToolName[],
): GrowthPhaseHandler {
  return { id, matches, plan: () => ({ objective, steps: [...steps] }) };
}

function contentHandler(id: "world" | "story" | "oc", steps: GrowthPhaseToolName[]): GrowthPhaseHandler {
  return fixedHandler(
    id,
    (binding) => binding.kind === "expand" && !binding.longformAuthority
      && binding.focusKinds.length === 1 && binding.focusKinds[0] === id,
    "change_set",
    steps,
  );
}

function phaseError(code: "STEWARD_GROWTH_REVISION_NOT_IMPLEMENTED" | "GROWTH_PHASE_REGISTRY_INVALID"): Error & { code: string } {
  return Object.assign(new Error("Growth phase registry failed closed."), { code });
}
