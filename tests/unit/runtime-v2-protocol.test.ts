import { describe, expect, it } from "vitest";
import {
  RUNTIME_V2_PROTOCOL_VERSION,
  RuntimeV2ProtocolVersionError,
  parseRuntimeV2Envelope,
  parseRuntimeV2HelloEnvelope,
  runtimeV2EnvelopeSchema,
} from "../../src/shared/runtimeV2Protocol";

const MESSAGE_ID = "35bf2cb7-b0db-44e7-985d-664f9cd98f97";

function helloEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: RUNTIME_V2_PROTOCOL_VERSION,
    messageId: MESSAGE_ID,
    messageType: "control",
    name: "runtime.hello",
    sentAt: "2026-07-12T00:00:00Z",
    correlationId: null,
    runId: null,
    sequence: 1,
    payload: {
      runtimeVersion: "0.1.0",
      protocolVersions: [1],
      capabilities: ["handshake"],
      build: {
        commit: "development",
        target: "x86_64-pc-windows-msvc",
      },
    },
    ...overrides,
  };
}

describe("Runtime V2 Protocol V1 TypeScript mirror", () => {
  it("accepts the Rust runtime.hello envelope", () => {
    expect(parseRuntimeV2HelloEnvelope(helloEnvelope())).toEqual(helloEnvelope());
  });

  it("accepts every Protocol V1 message type in the common envelope", () => {
    for (const messageType of ["command", "event", "response", "control"] as const) {
      expect(parseRuntimeV2Envelope(helloEnvelope({
        messageType,
        name: `${messageType}.test`,
      })).messageType).toBe(messageType);
    }
  });

  it("rejects unsupported protocol versions with a typed error", () => {
    expect(() => parseRuntimeV2Envelope(helloEnvelope({ protocolVersion: 2 }))).toThrowError(
      RuntimeV2ProtocolVersionError,
    );
    try {
      parseRuntimeV2Envelope(helloEnvelope({ protocolVersion: 2 }));
      throw new Error("Expected the unsupported version to fail.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "RUNTIME_V2_PROTOCOL_VERSION_UNSUPPORTED",
        received: 2,
        supported: 1,
      });
    }
  });

  it("rejects missing or malformed UUID identities", () => {
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ messageId: "not-a-uuid" })).success).toBe(false);
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ correlationId: "request-1" })).success).toBe(false);
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ runId: "run-1" })).success).toBe(false);
  });

  it("requires a positive safe integer sequence", () => {
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ sequence })).success).toBe(false);
    }
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ sequence: Number.MAX_SAFE_INTEGER })).success).toBe(true);
  });

  it("rejects unknown messageType values", () => {
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ messageType: "request" })).success).toBe(false);
  });

  it("enforces the runtime.hello name, control type and advertised V1 support", () => {
    expect(() => parseRuntimeV2HelloEnvelope(helloEnvelope({ name: "runtime.ready" }))).toThrow();
    expect(() => parseRuntimeV2HelloEnvelope(helloEnvelope({ messageType: "event" }))).toThrow();
    expect(() => parseRuntimeV2HelloEnvelope(helloEnvelope({
      payload: {
        ...helloEnvelope().payload,
        protocolVersions: [2],
      },
    }))).toThrow();
  });

  it("rejects unknown envelope and hello payload fields", () => {
    expect(runtimeV2EnvelopeSchema.safeParse(helloEnvelope({ unexpected: true })).success).toBe(false);
    expect(() => parseRuntimeV2HelloEnvelope(helloEnvelope({
      payload: {
        ...helloEnvelope().payload,
        secret: "must-not-cross-handshake",
      },
    }))).toThrow();
  });
});
