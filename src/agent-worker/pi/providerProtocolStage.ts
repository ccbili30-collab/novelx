export const providerProtocolStages = [
  "PROVIDER_PROTOCOL_NO_FINAL_MESSAGE",
  "PROVIDER_PROTOCOL_TOOL_FLOW_INCOMPLETE",
  "PROVIDER_PROTOCOL_STRUCTURED_RESULT_MISSING",
  "PROVIDER_PROTOCOL_STRUCTURED_RESULT_INVALID",
  "PROVIDER_PROTOCOL_REQUEST_LIMIT_EXCEEDED",
  "PROVIDER_PROTOCOL_OTHER",
] as const;

export type ProviderProtocolStage = (typeof providerProtocolStages)[number];

export function providerProtocolError(stage: Exclude<ProviderProtocolStage, "PROVIDER_PROTOCOL_OTHER">): Error & {
  code: "PROVIDER_PROTOCOL_FAILED";
  providerProtocolStage: ProviderProtocolStage;
} {
  return Object.assign(new Error("Provider protocol failed."), {
    code: "PROVIDER_PROTOCOL_FAILED" as const,
    providerProtocolStage: stage,
  });
}

export function readProviderProtocolStage(value: unknown): ProviderProtocolStage | null {
  if (!value || typeof value !== "object" || !("providerProtocolStage" in value)) return null;
  const stage = value.providerProtocolStage;
  return typeof stage === "string" && providerProtocolStages.includes(stage as ProviderProtocolStage)
    ? stage as ProviderProtocolStage
    : null;
}

export function auditProviderProtocolStage(value: unknown): ProviderProtocolStage | null {
  if (!value || typeof value !== "object" || !("code" in value) || value.code !== "PROVIDER_PROTOCOL_FAILED") return null;
  return readProviderProtocolStage(value) ?? "PROVIDER_PROTOCOL_OTHER";
}
