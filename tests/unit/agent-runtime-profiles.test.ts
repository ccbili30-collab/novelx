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
      version: "1.14.0",
      sha256: "29af57fd84113a54a3ba19a6d87069fb12fe7952b3bba99785efed3d29d4c10b",
    });
  });
});
