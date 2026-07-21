import { describe, expect, it, vi } from "vitest";
import { createGrowthRevisionDiagnosticSink, createStewardToolDiagnosticSink } from "../../src/agent-worker/diagnostics/safeDiagnosticEmitter";
import { safeDiagnosticEnvelopeV1Schema } from "../../src/shared/diagnostics/safeDiagnosticContract";

describe("Growth Revision safe diagnostic emitter", () => {
  it("records a rejected Growth Inquiry as a bounded correction that can become terminal", async () => {
    const record = vi.fn(async () => undefined);
    const sink = createStewardToolDiagnosticSink({
      runId: "run-1", cycleId: "cycle-1", record,
      now: () => "2026-07-17T00:00:00.000Z", createId: () => "diagnostic-inquiry",
    });

    await sink.recordFailure({
      toolCallId: "tool-inquiry", toolName: "submit_growth_inquiry",
      code: "STEWARD_GROWTH_INQUIRY_REQUIRED", sideEffectState: "none",
      attempt: 1, maxAttempts: 3,
    });

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      type: "safe_diagnostic.append",
      diagnostic: expect.objectContaining({
        code: "STEWARD_GROWTH_INQUIRY_REQUIRED", disposition: "correctable",
        retryability: "model_correction", sideEffectState: "none",
      }),
    }));

    await sink.recordFailure({
      toolCallId: "tool-inquiry-terminal", toolName: "submit_growth_inquiry",
      code: "STEWARD_GROWTH_INQUIRY_REQUIRED", sideEffectState: "none",
      attempt: 3, maxAttempts: 3, terminal: true,
    });
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      diagnostic: expect.objectContaining({
        attempt: 3, maxAttempts: 3, disposition: "terminal", retryability: "do_not_retry",
      }),
    }));
    const emitted = (record.mock.calls as unknown as Array<[{ diagnostic: unknown }]>)[0]![0].diagnostic;
    expect(safeDiagnosticEnvelopeV1Schema.safeParse(emitted).success).toBe(true);
  });

  it("classifies a known Writer refusal correction after a completed Provider request as a safe retry", async () => {
    const record = vi.fn(async () => undefined);
    const sink = createStewardToolDiagnosticSink({
      runId: "run-1", cycleId: "cycle-1", record,
      now: () => "2026-07-17T00:00:00.000Z", createId: () => "diagnostic-writer-retry",
    });
    await sink.recordFailure({
      toolCallId: "writer-1", toolName: "writer",
      code: "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_GM_RESOLUTION",
      sideEffectState: "request_sent", attempt: 1, maxAttempts: 2, terminal: false,
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      diagnostic: expect.objectContaining({
        code: "STEWARD_LONGFORM_WRITER_BLOCKED_MISSING_GM_RESOLUTION",
        sideEffectState: "request_sent", disposition: "correctable", retryability: "safe_retry",
        attempt: 1, maxAttempts: 2,
      }),
    }));
    const emitted = (record.mock.calls as unknown as Array<[{ diagnostic: unknown }]>)[0]![0].diagnostic;
    expect(safeDiagnosticEnvelopeV1Schema.safeParse(emitted).success).toBe(true);
  });
  it("emits strict correctable and corrected operations without arbitrary content", async () => {
    const record = vi.fn(async () => undefined);
    const ids = ["diagnostic-failed", "diagnostic-corrected"];
    const sink = createGrowthRevisionDiagnosticSink({
      runId: "run-1",
      cycleId: "cycle-1",
      record,
      now: () => "2026-07-17T00:00:00.000Z",
      createId: () => ids.shift()!,
    });

    const failedId = await sink.recordCompileFailure({
      toolCallId: "tool-1",
      code: "GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH",
      attempt: 1,
      maxAttempts: 3,
      terminal: false,
    });
    await sink.recordCompileCorrected({
      toolCallId: "tool-2",
      code: "GROWTH_REVISION_FRAGMENT_IMPACT_MISMATCH",
      attempt: 2,
      maxAttempts: 3,
      parentDiagnosticId: failedId,
    });

    expect(record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "safe_diagnostic.append",
      diagnostic: expect.objectContaining({
        diagnosticId: "diagnostic-failed", operationKind: "tool_call", operationId: "tool-1",
        disposition: "correctable", retryability: "model_correction", sideEffectState: "none",
      }),
    }));
    expect(record).toHaveBeenNthCalledWith(2, expect.objectContaining({
      diagnostic: expect.objectContaining({
        diagnosticId: "diagnostic-corrected", operationId: "tool-2",
        parentDiagnosticId: "diagnostic-failed", disposition: "corrected", boundary: "phase_correction",
      }),
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("message");
  });

  it("rejects a phase code that is absent from the local catalog", async () => {
    const sink = createGrowthRevisionDiagnosticSink({
      runId: "run-1", cycleId: "cycle-1", record: async () => undefined,
    });
    await expect(sink.recordCompileFailure({
      toolCallId: "tool-1", code: "UNREGISTERED_PHASE_ERROR", attempt: 1, maxAttempts: 3, terminal: false,
    })).rejects.toMatchObject({ code: "SAFE_DIAGNOSTIC_CODE_UNREGISTERED" });
  });

  it("emits registered Worker and Growth Fragment failures while ignoring unknown codes", async () => {
    const record = vi.fn(async () => undefined);
    const sink = createStewardToolDiagnosticSink({
      runId: "run-1", cycleId: "cycle-1", record,
      createId: () => "diagnostic-worker", now: () => "2026-07-17T00:00:00.000Z",
    });
    expect(await sink.recordFailure({
      toolCallId: "tool-1", toolName: "propose_change_set",
      code: "STEWARD_TOOL_RESULT_INVALID", sideEffectState: "request_sent",
    })).toBe("diagnostic-worker");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      diagnostic: expect.objectContaining({
        owner: "worker_schema", boundary: "worker_to_main", code: "STEWARD_TOOL_RESULT_INVALID",
        sideEffectState: "request_sent",
      }),
    }));
    expect(await sink.recordFailure({
      toolCallId: "tool-2", toolName: "propose_change_set",
      code: "GROWTH_FRAGMENT_INVALID", sideEffectState: "none", attempt: 1, maxAttempts: 3,
    })).toBe("diagnostic-worker");
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      diagnostic: expect.objectContaining({
        owner: "growth_phase", boundary: "phase_compile", code: "GROWTH_FRAGMENT_INVALID",
        sideEffectState: "none", disposition: "correctable", retryability: "model_correction",
      }),
    }));
    expect(await sink.recordFailure({
      toolCallId: "tool-3", toolName: "propose_change_set",
      code: "UNREGISTERED_WORKER_ERROR", sideEffectState: "none",
    })).toBeNull();
    expect(record).toHaveBeenCalledTimes(2);
  });
});
