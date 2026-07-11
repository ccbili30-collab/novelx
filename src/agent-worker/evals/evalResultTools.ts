import type { PromptRole } from "../prompts/manifest";
import { createRoleOutputTool, type RoleOutputToolCapture } from "../contracts/roleOutputTool";

export type EvalResultToolCapture = RoleOutputToolCapture;

export function createEvalResultTool(role: PromptRole): EvalResultToolCapture {
  return createRoleOutputTool(role, {
    label: "提交结构化评测结果",
    description: "Submit the only structured result for this evaluation case. This does not write project data.",
  });
}
