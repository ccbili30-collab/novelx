import type { AgentEvent } from "@earendil-works/pi-agent-core";

export type SafePiEvent =
  | { type: "text.delta"; text: string }
  | { type: "tool.started"; tool: string; label: string }
  | { type: "tool.completed"; tool: string; label: string }
  | { type: "tool.failed"; tool: string; label: string };

const safeToolLabels: Record<string, string> = {
  submit_steward_plan: "规划执行步骤",
  retrieve_graph_evidence: "检索项目事实",
  inspect_project_files: "检查项目文件",
  propose_change_set: "生成候选变更",
  writer: "调用写手",
  checker: "调用校验器",
  submit_steward_result: "整理最终结果",
};

export function projectPiEvent(event: AgentEvent): SafePiEvent | null {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    return event.assistantMessageEvent.delta
      ? { type: "text.delta", text: event.assistantMessageEvent.delta }
      : null;
  }

  if (event.type === "tool_execution_start") {
    const label = safeToolLabels[event.toolName];
    return label ? { type: "tool.started", tool: event.toolName, label } : null;
  }

  if (event.type === "tool_execution_end") {
    const label = safeToolLabels[event.toolName];
    if (!label) return null;
    return { type: event.isError ? "tool.failed" : "tool.completed", tool: event.toolName, label };
  }

  return null;
}
