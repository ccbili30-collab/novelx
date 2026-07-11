import { describe, expect, it } from "vitest";
import { validateTurnPipeline } from "../../src/agent-worker/play/turnValidator";

const gm = {
  status: "resolved" as const,
  resolutionId: "resolution-1",
  evidenceIds: ["evidence-1"],
  outcome: "进入洞穴",
  consequences: [],
  stateDelta: { location: "洞穴" },
  narrativeFacts: ["玩家进入洞穴"],
};

describe("validateTurnPipeline", () => {
  it("accepts prose only when Writer and Checker preserve the GM resolution", () => {
    expect(validateTurnPipeline({
      gm,
      writer: { status: "candidate", candidateText: "你踏入洞穴。", evidenceIds: ["evidence-1"], gmResolutionId: "resolution-1", authorityChanges: [] },
      checker: { status: "passed", findings: [] },
    })).toMatchObject({ writerText: "你踏入洞穴。", gmResolution: { resolutionId: "resolution-1" } });
  });

  it("rejects Writer authority changes and major Checker findings", () => {
    expect(() => validateTurnPipeline({
      gm,
      writer: { status: "candidate", candidateText: "你获得王冠。", evidenceIds: ["evidence-1"], gmResolutionId: "resolution-1", authorityChanges: [] },
      checker: { status: "findings", findings: [{ severity: "major", category: "writer_authority", evidence: [{ sourceId: "evidence-1", claim: "GM 未裁决奖励" }], location: "正文", scope: "本回合", reason: "Writer 新增奖励" }] },
    })).toThrow();
  });
});
