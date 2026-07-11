import { describe, expect, it } from "vitest";
import { toPublicError } from "../../src/shared/publicErrors";

describe("public desktop errors", () => {
  it("preserves known stable error codes without exposing internal messages", () => {
    expect(toPublicError({ code: "REAL_GM_PROVIDER_REQUIRED", message: "apiKey=C:\\secret" })).toEqual({
      code: "REAL_GM_PROVIDER_REQUIRED",
      message: "需要先配置可用的模型服务。",
    });
  });

  it("collapses unknown values to a generic public error", () => {
    expect(toPublicError(new Error("C:\\Users\\name\\private.json"))).toEqual({
      code: "AGENT_RUN_FAILED",
      message: "任务失败，请稍后重试。",
    });
  });
});

