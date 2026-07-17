export interface GrowthWatchSnapshot {
  coordinatorStatus: "running" | "awaiting_guidance" | "completed" | "blocked" | "failed" | "cancelled" | "reconciliation_required";
  cycles: Array<{ id: string; status: string; runId: string | null }>;
}

export interface GrowthWatchResult<TSnapshot extends GrowthWatchSnapshot, TEvents> {
  snapshot: TSnapshot;
  events: TEvents;
  elapsedMs: number;
  termination: "GROWTH_CYCLE_WATCHDOG_TIMEOUT" | "GROWTH_OVERALL_TIMEOUT" | "GROWTH_AGENT_TERMINAL_PROJECTION_TIMEOUT" | null;
}

export function shouldValidateCompletedGrowthShowcase(snapshot: GrowthWatchSnapshot): boolean {
  return snapshot.coordinatorStatus === "completed";
}

const safeGrowthBlockCodes = new Set([
  "major_conflict",
  "missing_source",
  "tool_failed",
  "user_confirmation_required",
]);

export function projectSafeGrowthAgentEvent(event: {
  type: string;
  phase?: string;
  code?: string;
  outcome?: string;
  changeSetState?: string;
  artifacts?: ReadonlyArray<{ kind?: string; code?: string; message?: unknown; evidenceIds?: unknown }>;
}): { type: string; phase?: string; code?: string; outcome?: string; changeSetState?: string; escalationCodes?: string[] } {
  if (event.type === "run.activity") return { type: event.type, phase: event.phase };
  if (event.type === "run.failed") return { type: event.type, code: event.code };
  if (event.type === "run.completed") {
    const escalationCodes = [...new Set((event.artifacts ?? []).flatMap((artifact) => (
      artifact.kind === "conflict" && artifact.code && safeGrowthBlockCodes.has(artifact.code)
        ? [artifact.code]
        : []
    )))].sort();
    return {
      type: event.type,
      outcome: event.outcome,
      changeSetState: event.changeSetState,
      ...(escalationCodes.length > 0 ? { escalationCodes } : {}),
    };
  }
  return { type: event.type };
}

export async function watchGrowthTerminal<TSnapshot extends GrowthWatchSnapshot, TEvents>(input: {
  getSnapshot(): Promise<TSnapshot>;
  readEvents(): Promise<TEvents>;
  release(): Promise<void>;
  overallTimeoutMs: number;
  cycleTimeoutMs: number;
  terminalDeliveryTimeoutMs?: number;
  terminalDeliverySatisfied?(snapshot: TSnapshot, events: TEvents): boolean;
  resumeAtBoundary?(snapshot: TSnapshot, events: TEvents): Promise<boolean>;
  pollMs?: number;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
}): Promise<GrowthWatchResult<TSnapshot, TEvents>> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  let watchedCycleId: string | null = null;
  let watchedCycleAt: number | null = null;
  let coordinatorTerminalAt: number | null = null;
  try {
    for (;;) {
      const snapshot = await input.getSnapshot();
      const events = await input.readEvents();
      const elapsedMs = now() - startedAt;
      if (snapshot.coordinatorStatus !== "running") {
        if (input.resumeAtBoundary && await input.resumeAtBoundary(snapshot, events)) {
          watchedCycleId = null;
          watchedCycleAt = null;
          coordinatorTerminalAt = null;
          await sleep(input.pollMs ?? 500);
          continue;
        }
        if (!input.terminalDeliverySatisfied || input.terminalDeliverySatisfied(snapshot, events)) {
          return { snapshot, events, elapsedMs, termination: null };
        }
        coordinatorTerminalAt ??= now();
        if (now() - coordinatorTerminalAt >= (input.terminalDeliveryTimeoutMs ?? 30_000)) {
          const finalSnapshot = await input.getSnapshot();
          const finalEvents = await input.readEvents();
          return { snapshot: finalSnapshot, events: finalEvents, elapsedMs: now() - startedAt, termination: "GROWTH_AGENT_TERMINAL_PROJECTION_TIMEOUT" };
        }
        await sleep(input.pollMs ?? 500);
        continue;
      }
      const running = snapshot.cycles.find((cycle) => cycle.status === "running" && cycle.runId !== null);
      if (running?.id !== watchedCycleId) {
        watchedCycleId = running?.id ?? null;
        watchedCycleAt = running ? now() : null;
      }
      const termination = elapsedMs >= input.overallTimeoutMs
        ? "GROWTH_OVERALL_TIMEOUT"
        : watchedCycleAt !== null && now() - watchedCycleAt >= input.cycleTimeoutMs
          ? "GROWTH_CYCLE_WATCHDOG_TIMEOUT"
          : null;
      if (termination) {
        const finalSnapshot = await input.getSnapshot();
        const finalEvents = await input.readEvents();
        return { snapshot: finalSnapshot, events: finalEvents, elapsedMs: now() - startedAt, termination };
      }
      await sleep(input.pollMs ?? 500);
    }
  } finally {
    await input.release();
  }
}
