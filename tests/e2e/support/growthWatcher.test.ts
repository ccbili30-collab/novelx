import { describe, expect, it } from "vitest";
import { watchGrowthTerminal, type GrowthWatchSnapshot } from "./growthWatcher";

describe("Growth live watcher", () => {
  it("returns awaiting guidance without treating a committed Cycle as an active Worker", async () => {
    let released = 0;
    const result = await watchGrowthTerminal({
      getSnapshot: async () => ({
        coordinatorStatus: "awaiting_guidance" as const,
        cycles: [{ id: "cycle-1", status: "committed", runId: "run-1" }],
      }),
      readEvents: async () => [{ type: "run.completed", runId: "run-1" }],
      release: async () => { released += 1; },
      overallTimeoutMs: 900,
      cycleTimeoutMs: 300,
    });
    expect(result).toMatchObject({ termination: null, snapshot: { coordinatorStatus: "awaiting_guidance" } });
    expect(result.snapshot.cycles.some((cycle) => cycle.status === "running")).toBe(false);
    expect(released).toBe(1);
  });

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

  it("drains every bound public Agent terminal after coordinator completion before releasing", async () => {
    let released = 0;
    let reads = 0;
    const completed: GrowthWatchSnapshot = {
      coordinatorStatus: "completed",
      cycles: [
        { id: "cycle-1", status: "committed", runId: "run-1" },
        { id: "cycle-2", status: "committed", runId: "run-2" },
        { id: "cycle-3", status: "committed", runId: "run-3" },
      ],
    };
    const result = await watchGrowthTerminal({
      getSnapshot: async () => completed,
      readEvents: async () => {
        reads += 1;
        return reads === 1 ? [{ type: "run.completed", runId: "run-1" }, { type: "run.completed", runId: "run-2" }]
          : [{ type: "run.completed", runId: "run-1" }, { type: "run.completed", runId: "run-2" }, { type: "run.completed", runId: "run-3" }];
      },
      release: async () => { released += 1; }, overallTimeoutMs: 900, cycleTimeoutMs: 300, pollMs: 1,
      terminalDeliverySatisfied: (snapshot, events) => snapshot.cycles.every((cycle) => cycle.runId === null || events.some((event) => event.runId === cycle.runId && (event.type === "run.completed" || event.type === "run.failed"))),
    });
    expect(result.termination).toBeNull();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(released).toBe(1);
  });

  it("returns a bounded terminal-projection timeout and releases exactly once", async () => {
    let time = 0;
    let released = 0;
    const terminal: GrowthWatchSnapshot = { coordinatorStatus: "blocked", cycles: [{ id: "cycle-1", status: "blocked", runId: "run-1" }] };
    const result = await watchGrowthTerminal({
      getSnapshot: async () => terminal,
      readEvents: async () => [{ type: "run.activity", runId: "run-1" }],
      release: async () => { released += 1; }, overallTimeoutMs: 900, cycleTimeoutMs: 300, terminalDeliveryTimeoutMs: 300,
      now: () => time, sleep: async () => { time += 150; },
      terminalDeliverySatisfied: (_snapshot, events) => events.some((event) => event.type === "run.completed" || event.type === "run.failed"),
    });
    expect(result.termination).toBe("GROWTH_AGENT_TERMINAL_PROJECTION_TIMEOUT");
    expect(released).toBe(1);
  });

  it("drains a failed coordinator's bound Run terminal before returning", async () => {
    let reads = 0;
    let released = 0;
    const failed: GrowthWatchSnapshot = { coordinatorStatus: "failed", cycles: [{ id: "cycle-1", status: "failed", runId: "run-1" }] };
    const result = await watchGrowthTerminal({
      getSnapshot: async () => failed,
      readEvents: async () => {
        reads += 1;
        return reads === 1 ? [{ type: "run.activity", runId: "run-1" }] : [{ type: "run.failed", runId: "run-1" }];
      },
      release: async () => { released += 1; }, overallTimeoutMs: 900, cycleTimeoutMs: 300, pollMs: 1,
      terminalDeliverySatisfied: (snapshot, events) => snapshot.cycles.every((cycle) => cycle.runId === null || events.some((event) => event.runId === cycle.runId && (event.type === "run.completed" || event.type === "run.failed"))),
    });
    expect(result.termination).toBeNull();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(released).toBe(1);
  });
});
