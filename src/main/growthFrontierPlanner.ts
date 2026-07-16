import type {
  GrowthClosureState,
  GrowthContentCycleIntent,
} from "../shared/growthContract";

export type GrowthFocusKind = "world" | "story" | "oc";

export interface GrowthFrontierCycleState {
  ruleRevision: number;
  status: "committed";
  intent: Pick<GrowthContentCycleIntent, "kind" | "focusKinds" | "resumeFrontier">;
}

export interface GrowthFrontierPlannerInput {
  seedKinds: GrowthFocusKind[];
  formalCoverageKinds: GrowthFocusKind[];
  currentRuleRevision: number;
  latestCycle: GrowthFrontierCycleState | null;
  closureStates: Array<Pick<GrowthClosureState, "contentState">>;
}

export type GrowthFrontierDecision =
  | { state: "plan"; intent: { kind: "expand"; focusKinds: [GrowthFocusKind]; resumeFrontier: GrowthFocusKind[] } }
  | { state: "plan"; intent: { kind: "revision"; focusKinds: GrowthFocusKind[]; resumeFrontier: GrowthFocusKind[] } }
  | { state: "awaiting_guidance" | "content_closed"; intent: null };

const canonicalOrder: GrowthFocusKind[] = ["world", "story", "oc"];

/**
 * Pure deterministic routing over persisted facts. Text meaning is deliberately
 * absent: Task 4 owns evidence-grounded seed analysis.
 */
export function planGrowthFrontier(input: GrowthFrontierPlannerInput): GrowthFrontierDecision {
  assertRevision(input.currentRuleRevision);
  const seedKinds = orderedUnique(input.seedKinds);
  const coverageKinds = orderedUnique(input.formalCoverageKinds);

  if (!input.latestCycle) {
    const intent = initialIntent(seedKinds, coverageKinds);
    return intent ? { state: "plan", intent } : { state: "awaiting_guidance", intent: null };
  }

  if (input.currentRuleRevision > input.latestCycle.ruleRevision) {
    return {
      state: "plan",
      intent: estimateRevisionIntent({
        currentIntent: input.latestCycle.intent,
        formalCoverageKinds: coverageKinds,
      }),
    };
  }

  if (input.currentRuleRevision < input.latestCycle.ruleRevision) throw plannerError("GROWTH_FRONTIER_REVISION_INVALID");

  const pendingFrontier = input.latestCycle.intent.resumeFrontier;
  if (pendingFrontier.length > 0) {
    const [next, ...remaining] = pendingFrontier;
    return { state: "plan", intent: { kind: "expand", focusKinds: [next!], resumeFrontier: remaining } };
  }

  if (input.closureStates.length > 0 && input.closureStates.every((state) => state.contentState === "closed")) {
    return { state: "content_closed", intent: null };
  }
  return { state: "awaiting_guidance", intent: null };
}

export function estimateRevisionIntent(input: {
  currentIntent: Pick<GrowthContentCycleIntent, "focusKinds" | "resumeFrontier">;
  formalCoverageKinds: GrowthFocusKind[];
}): { kind: "revision"; focusKinds: GrowthFocusKind[]; resumeFrontier: GrowthFocusKind[] } {
  const focusKinds = orderedUnique([...input.currentIntent.focusKinds, ...input.formalCoverageKinds]);
  return {
    kind: "revision",
    focusKinds: focusKinds.length > 0 ? focusKinds : [...canonicalOrder],
    resumeFrontier: [...input.currentIntent.resumeFrontier],
  };
}

function initialIntent(
  seedKinds: GrowthFocusKind[],
  coverageKinds: GrowthFocusKind[],
): { kind: "expand"; focusKinds: [GrowthFocusKind]; resumeFrontier: GrowthFocusKind[] } | null {
  if (seedKinds.length === 0) {
    return { kind: "expand", focusKinds: ["world"], resumeFrontier: ["story", "oc"] };
  }
  const persistedSeedKinds = seedKinds.filter((kind) => coverageKinds.includes(kind));
  if (persistedSeedKinds.length === 0) {
    const route = orderedUnique([...seedKinds, ...canonicalOrder]);
    const [next, ...remaining] = route;
    return next ? { kind: "expand", focusKinds: [next], resumeFrontier: remaining } : null;
  }
  const routeByPersistedSeed: Record<GrowthFocusKind, GrowthFocusKind[]> = {
    world: ["story", "oc"],
    story: ["world", "oc"],
    oc: ["story", "world"],
  };
  const route = orderedUnique(persistedSeedKinds.flatMap((kind) => routeByPersistedSeed[kind]));
  const [next, ...remaining] = route;
  return next ? { kind: "expand", focusKinds: [next], resumeFrontier: remaining } : null;
}

function orderedUnique(values: readonly GrowthFocusKind[]): GrowthFocusKind[] {
  if (values.some((value) => !canonicalOrder.includes(value))) throw plannerError("GROWTH_FRONTIER_KIND_INVALID");
  return [...new Set(values)];
}

function assertRevision(revision: number): void {
  if (!Number.isInteger(revision) || revision < 1) throw plannerError("GROWTH_FRONTIER_REVISION_INVALID");
}

function plannerError(code: string): Error & { code: string } {
  return Object.assign(new Error("Growth frontier planning failed."), { code });
}
