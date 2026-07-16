import type { GrowthRunBinding } from "../../../shared/agentWorkerProtocol";

export type GrowthPhaseToolName =
  | "retrieve_graph_evidence"
  | "submit_growth_inquiry"
  | "submit_closure_self_assessment"
  | "writer"
  | "propose_change_set"
  | "generate_image";

export interface GrowthPhasePlan<TPhaseId extends string = string> {
  phaseId: TPhaseId;
  objective: "change_set" | "orchestrate";
  steps: GrowthPhaseToolName[];
}

/**
 * Stable phase-local seam. A phase owns its match and plan without teaching the
 * top-level Steward state machine another conditional branch.
 */
export interface GrowthPhaseHandler<TPhaseId extends string = string> {
  readonly id: TPhaseId;
  matches(binding: GrowthRunBinding): boolean;
  plan(binding: GrowthRunBinding): Omit<GrowthPhasePlan<TPhaseId>, "phaseId">;
}

export interface GrowthPhaseRegistry<TPhaseId extends string = string> {
  resolve(binding: GrowthRunBinding): GrowthPhasePlan<TPhaseId>;
}

export function createGrowthPhaseRegistry<TPhaseId extends string>(
  handlers: readonly GrowthPhaseHandler<TPhaseId>[],
): GrowthPhaseRegistry<TPhaseId> {
  if (handlers.length === 0 || new Set(handlers.map((handler) => handler.id)).size !== handlers.length) {
    throw phaseRegistryError();
  }
  const registered = [...handlers];
  return {
    resolve(binding) {
      const matches = registered.filter((handler) => handler.matches(binding));
      if (matches.length !== 1) throw phaseRegistryError();
      const handler = matches[0]!;
      const plan = handler.plan(binding);
      return { phaseId: handler.id, objective: plan.objective, steps: [...plan.steps] };
    },
  };
}

export function fixedGrowthPhaseHandler<TPhaseId extends string>(
  id: TPhaseId,
  matches: (binding: GrowthRunBinding) => boolean,
  objective: GrowthPhasePlan["objective"],
  steps: readonly GrowthPhaseToolName[],
): GrowthPhaseHandler<TPhaseId> {
  return { id, matches, plan: () => ({ objective, steps: [...steps] }) };
}

function phaseRegistryError(): Error & { code: "GROWTH_PHASE_REGISTRY_INVALID" } {
  return Object.assign(new Error("Growth phase registry failed closed."), {
    code: "GROWTH_PHASE_REGISTRY_INVALID" as const,
  });
}
