import { describe, expect, it } from "vitest";
import {
  projectSafeGrowthAgentEvent,
  shouldValidateCompletedGrowthShowcase,
  watchGrowthTerminal,
  type GrowthWatchSnapshot,
} from "./growthWatcher";

describe("Growth live watcher", () => {
  it("validates the Showcase climax only for an authoritative completed coordinator", () => {
    expect(shouldValidateCompletedGrowthShowcase({ coordinatorStatus: "completed", cycles: [] })).toBe(true);
    for (const coordinatorStatus of [
      "running",
      "awaiting_guidance",
      "blocked",
      "failed",
      "cancelled",
      "reconciliation_required",
    ] as const) {
      expect(shouldValidateCompletedGrowthShowcase({ coordinatorStatus, cycles: [] })).toBe(false);
    }
  });

  it("projects only allowlisted pre-proposal block codes from public terminal artifacts", () => {
    expect(projectSafeGrowthAgentEvent({
      type: "run.completed",
      outcome: "blocked",
      changeSetState: "none",
      artifacts: [
        { kind: "conflict", code: "missing_source", message: "must not persist" },
        { kind: "conflict", code: "untrusted-model-code", message: "must not persist" },
        { kind: "document_reference", code: "user_confirmation_required", message: "not a conflict" },
      ],
    })).toEqual({
      type: "run.completed",
      outcome: "blocked",
      changeSetState: "none",
      escalationCodes: ["missing_source"],
    });
    expect(projectSafeGrowthAgentEvent({
      type: "run.completed",
      outcome: "blocked",
      changeSetState: "none",
      artifacts: [{ kind: "conflict", code: "user_confirmation_required" }],
    })).toMatchObject({ escalationCodes: ["user_confirmation_required"] });
  });

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

  it("resumes once from a creator decision boundary without releasing subscriptions", async () => {
    let state: "blocked" | "running" | "completed" = "blocked";
    let resumes = 0;
    let released = 0;
    const result = await watchGrowthTerminal({
      getSnapshot: async () => ({
        coordinatorStatus: state,
        cycles: [{ id: state === "blocked" ? "cycle-1" : "cycle-2", status: state === "completed" ? "committed" : state, runId: null }],
      }),
      readEvents: async () => [],
      resumeAtBoundary: async (snapshot) => {
        if (snapshot.coordinatorStatus !== "blocked" || resumes > 0) return false;
        resumes += 1;
        state = "running";
        return true;
      },
      release: async () => { released += 1; },
      overallTimeoutMs: 900,
      cycleTimeoutMs: 300,
      sleep: async () => { if (state === "running") state = "completed"; },
    });
    expect(result.snapshot.coordinatorStatus).toBe("completed");
    expect(resumes).toBe(1);
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
