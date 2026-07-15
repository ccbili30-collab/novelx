import { describe, expect, it } from "vitest";
import { watchGrowthTerminal, type GrowthWatchSnapshot } from "./growthWatcher";

describe("Growth live watcher", () => {
  it("returns a terminal coordinator snapshot promptly and releases subscriptions", async () => {
    let released = 0;
    const result = await watchGrowthTerminal({
      getSnapshot: async () => ({ coordinatorStatus: "failed", cycles: [] }),
      readEvents: async () => [{ type: "run.failed" }],
      release: async () => { released += 1; },
      overallTimeoutMs: 900, cycleTimeoutMs: 300,
    });
    expect(result).toMatchObject({ termination: null, snapshot: { coordinatorStatus: "failed" } });
    expect(released).toBe(1);
  });

  it("captures a cycle watchdog and an overall deadline without browser closures", async () => {
    let time = 0;
    let released = 0;
    const running: GrowthWatchSnapshot = { coordinatorStatus: "running", cycles: [{ id: "cycle-1", status: "running", runId: "run-1" }] };
    const cycle = await watchGrowthTerminal({
      getSnapshot: async () => running,
      readEvents: async () => [{ type: "run.activity" }],
      release: async () => { released += 1; },
      overallTimeoutMs: 900, cycleTimeoutMs: 300,
      now: () => time,
      sleep: async () => { time += 150; },
    });
    expect(cycle.termination).toBe("GROWTH_CYCLE_WATCHDOG_TIMEOUT");
    expect(cycle.events).toEqual([{ type: "run.activity" }]);

    time = 0;
    const planned: GrowthWatchSnapshot = { coordinatorStatus: "running", cycles: [{ id: "cycle-1", status: "planned", runId: null }] };
    const overall = await watchGrowthTerminal({
      getSnapshot: async () => planned,
      readEvents: async () => [],
      release: async () => { released += 1; },
      overallTimeoutMs: 300, cycleTimeoutMs: 900,
      now: () => time,
      sleep: async () => { time += 150; },
    });
    expect(overall.termination).toBe("GROWTH_OVERALL_TIMEOUT");
    expect(released).toBe(2);
  });
});
