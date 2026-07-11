import { describe, expect, it } from "vitest";
import {
  STEWARD_STATE_CORRECTION,
  createStewardStateCorrection,
  getAgentRuntimeProfile,
} from "../../src/shared/agentRuntimeProfiles";

describe("Agent runtime correction profiles", () => {
  it("gives Steward the stable rejection code and exact final contract", () => {
    const correction = createStewardStateCorrection(
      "submit_steward_result",
      {
        status: "awaiting_confirmation",
        changeSet: { state: "pending_review", changeSetId: "change-1" },
      },
      "STEWARD_FINAL_CHANGE_SET_MISMATCH",
    );

    expect(STEWARD_STATE_CORRECTION.version).toBe("1.1.0");
    expect(correction).toContain("STEWARD_FINAL_CHANGE_SET_MISMATCH");
    expect(correction).toContain("submit_steward_result");
    expect(correction).toContain('"status":"awaiting_confirmation"');
    expect(correction).toContain('"changeSetId":"change-1"');
    expect(correction).not.toContain("undefined");
  });

  it("keeps a stable fallback when no previous rejection exists", () => {
    expect(createStewardStateCorrection("submit_steward_plan")).toContain(
      "STRUCTURED_RESULT_REQUIRED",
    );
  });

  it("versions the Steward runtime profile with the correction contract", () => {
    expect(getAgentRuntimeProfile("steward")).toMatchObject({
      version: "1.16.0",
      sha256: "a4d067d481aa4727ee48b4a4e5777267dac50437c9fc79d38a1a8ea8bcf76e6f",
    });
  });
});
