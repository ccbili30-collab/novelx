export type AgentRuntimeRole = "steward" | "writer" | "checker";

export interface AgentRuntimeProfileIdentity {
  id: string;
  version: `${number}.${number}.${number}`;
  sha256: string;
  toolPolicyId: string;
  toolPolicyVersion: `${number}.${number}.${number}`;
  toolPolicySha256: string;
  authorizedTools: string[];
}

export const STRUCTURED_SUBMISSION_CORRECTION = {
  id: "novax.structured-submission-correction",
  version: "2.2.0",
  maxAttempts: 3,
  template: "你尚未通过规定的结构化结果工具完成本次运行。不要重复调用领域工具，不要输出普通文本。立即且只调用一次 {{toolName}}，依据已有输入和工具结果提交最终结构化结果。",
} as const;

export const STEWARD_STATE_CORRECTION = {
  id: "novax.steward-state-correction",
  version: "1.1.0",
  template: "当前 Steward 状态尚未完成。上一轮结构化提交被 Harness 拒绝，稳定拒绝码为 {{rejectionCode}}。不要输出普通文本，不要重复已经成功的工具。立即且只调用一次 {{toolName}}；Harness 会拒绝任何其他步骤。",
} as const;

const profiles: Record<AgentRuntimeRole, AgentRuntimeProfileIdentity> = {
  steward: {
    id: "novax.steward-runtime",
    version: "1.14.0",
    sha256: "29af57fd84113a54a3ba19a6d87069fb12fe7952b3bba99785efed3d29d4c10b",
    toolPolicyId: "novax.steward-tools",
    toolPolicyVersion: "2.6.0",
    toolPolicySha256: "697c7057c667312dd64e062ae9ee7df016aa6659073ce0fe5bf6f2e098cc3cac",
    authorizedTools: [
      "checker",
      "propose_change_set",
      "retrieve_graph_evidence",
      "submit_steward_plan",
      "submit_steward_result",
      "writer",
    ],
  },
  writer: {
    id: "novax.writer-runtime",
    version: "1.5.0",
    sha256: "83f3519cb67c261b7327214150a04c760bdabd8f798251b088c00c705010d8d4",
    toolPolicyId: "novax.writer-tools",
    toolPolicyVersion: "1.1.0",
    toolPolicySha256: "dbe2044cb2759b4f79603f1eee9f2823e460f00312b17cb08268a4beae8cfc8b",
    authorizedTools: ["submit_writer_result"],
  },
  checker: {
    id: "novax.checker-runtime",
    version: "1.5.0",
    sha256: "25fb205fc63ee226465b3ec7e9fe5dd218a8e39431841972ece3430f63bf6842",
    toolPolicyId: "novax.checker-tools",
    toolPolicyVersion: "1.1.0",
    toolPolicySha256: "a581bc2585ecb7430dd872155cd7e8c61f8d4692e54410e6ec35309d72caf26c",
    authorizedTools: ["submit_checker_result"],
  },
};

export function getAgentRuntimeProfile(role: AgentRuntimeRole): AgentRuntimeProfileIdentity {
  return { ...profiles[role], authorizedTools: [...profiles[role].authorizedTools] };
}

export function createStructuredSubmissionCorrection(toolName: string): string {
  return STRUCTURED_SUBMISSION_CORRECTION.template.replace("{{toolName}}", toolName);
}

export function createStewardStateCorrection(
  toolName: string,
  finalContract?: unknown,
  rejectionCode = "STRUCTURED_RESULT_REQUIRED",
): string {
  const instruction = STEWARD_STATE_CORRECTION.template
    .replace("{{toolName}}", toolName)
    .replace("{{rejectionCode}}", rejectionCode);
  return finalContract === undefined
    ? instruction
    : `${instruction}\n最终结构化字段必须满足以下 Harness 合同：${JSON.stringify(finalContract)}`;
}
