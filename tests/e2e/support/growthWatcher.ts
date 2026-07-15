export interface GrowthWatchSnapshot {
  coordinatorStatus: "running" | "completed" | "blocked" | "failed" | "cancelled" | "reconciliation_required";
  cycles: Array<{ id: string; status: string; runId: string | null }>;
}

export interface GrowthWatchResult<TSnapshot extends GrowthWatchSnapshot, TEvents> {
  snapshot: TSnapshot;
  events: TEvents;
  elapsedMs: number;
  termination: "GROWTH_CYCLE_WATCHDOG_TIMEOUT" | "GROWTH_OVERALL_TIMEOUT" | null;
}

export async function watchGrowthTerminal<TSnapshot extends GrowthWatchSnapshot, TEvents>(input: {
  getSnapshot(): Promise<TSnapshot>;
  readEvents(): Promise<TEvents>;
  release(): Promise<void>;
  overallTimeoutMs: number;
  cycleTimeoutMs: number;
  pollMs?: number;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
}): Promise<GrowthWatchResult<TSnapshot, TEvents>> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  let watchedCycleId: string | null = null;
  let watchedCycleAt: number | null = null;
  try {
    for (;;) {
      const snapshot = await input.getSnapshot();
      const events = await input.readEvents();
      const elapsedMs = now() - startedAt;
      if (snapshot.coordinatorStatus !== "running") return { snapshot, events, elapsedMs, termination: null };
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
