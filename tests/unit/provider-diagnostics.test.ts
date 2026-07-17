import { describe, expect, it } from "vitest";
import { createProviderTerminalDiagnostic, providerDiagnosticCatalog } from "../../src/agent-worker/pi/providerDiagnostics";
import { providerProtocolError } from "../../src/agent-worker/pi/providerProtocolStage";

describe("Provider Safe Diagnostics", () => {
  it("classifies a protocol failure without retaining raw Provider content", () => {
    const cause = Object.assign(providerProtocolError("PROVIDER_PROTOCOL_TOOL_FLOW_INCOMPLETE"), {
      rawMessage: "apiKey=secret",
    });
    const diagnostic = createProviderTerminalDiagnostic({
      runId: "run-1", cycleId: "cycle-1", cause,
      createId: () => "diagnostic-1", now: () => "2026-07-17T00:00:00.000Z",
    });
    expect(diagnostic).toMatchObject({
      code: "PROVIDER_PROTOCOL_TOOL_FLOW_INCOMPLETE", owner: "provider", boundary: "provider_protocol",
      sideEffectState: "request_sent", disposition: "terminal", retryability: "do_not_retry",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
  });

  it("marks admission request-limit failures as pre-request Worker ownership", () => {
    const diagnostic = createProviderTerminalDiagnostic({
      runId: "run-1", cycleId: null,
      cause: providerProtocolError("PROVIDER_PROTOCOL_REQUEST_LIMIT_EXCEEDED"),
      createId: () => "diagnostic-1", now: () => "2026-07-17T00:00:00.000Z",
    });
    expect(diagnostic).toMatchObject({
      owner: "worker_schema", sideEffectState: "none", retryability: "user_action",
    });
  });

  it("returns null for non-Provider failures and keeps a frozen allowlisted catalog", () => {
    expect(createProviderTerminalDiagnostic({ runId: "run-1", cycleId: null, cause: { code: "DOMAIN_POLICY_FAILED" } })).toBeNull();
    expect(providerDiagnosticCatalog.codes).toContain("PROVIDER_RUNTIME_FAILED");
    expect(providerDiagnosticCatalog.codes).toContain("PROVIDER_PROTOCOL_OTHER");
  });
});
