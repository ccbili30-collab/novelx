import type { PublicError } from "./ipcContract";

const publicMessages: Record<PublicError["code"], string> = {
  REAL_GM_PROVIDER_REQUIRED: "需要先配置可用的模型服务。",
  PROMPT_SET_NOT_PUBLISHED: "Agent 提示词尚未通过发布验证。",
  AGENT_TOOLS_REQUIRED: "Agent 领域工具尚未就绪。",
  AGENT_AUDIT_REQUIRED: "Agent 运行审计不可用，任务已阻止。",
  AGENT_CONTEXT_BUDGET_EXCEEDED: "当前资料超过模型的安全上下文预算，请缩小任务范围。",
  PROVIDER_RUNTIME_FAILED: "模型服务运行失败。",
  PROVIDER_OUTPUT_INCOMPLETE: "模型输出被截断。",
  PROVIDER_PROTOCOL_FAILED: "模型服务返回了无效结果。",
  AGENT_RUN_FAILED: "任务失败，请稍后重试。",
  AGENT_RUN_CANCELLED: "任务已取消。",
  AGENT_WORKER_INTERRUPTED: "Agent 工作进程已中断。",
};

export function toPublicError(value: unknown): PublicError {
  const code = readKnownCode(value);
  return {
    code,
    message: publicMessages[code],
  };
}

function readKnownCode(value: unknown): PublicError["code"] {
  if (!value || typeof value !== "object" || !("code" in value)) return "AGENT_RUN_FAILED";
  const code = String(value.code);
  return code in publicMessages ? code as PublicError["code"] : "AGENT_RUN_FAILED";
}
