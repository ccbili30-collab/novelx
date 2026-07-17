import { randomUUID } from "node:crypto";
import { SafeDiagnosticRepository } from "../../domain/audit/safeDiagnosticRepository";
import { ChangeSetRepository } from "../../domain/changeSet/changeSetRepository";
import {
  isWorkspaceChangeSetMajorConflictCode,
  type WorkspaceChangeSetMajorConflictCode,
} from "../../domain/changeSet/workspaceChangeSetPolicy";
import type { WorkspaceDatabase } from "../../domain/workspace/workspaceRepository";
import type { SafeDiagnosticEnvelopeV1 } from "../../shared/diagnostics/safeDiagnosticContract";

export function appendPersistedFreePolicyConflictDiagnostic(input: {
  workspace: WorkspaceDatabase;
  changeSetId: string;
  runId: string;
  cycleId: string;
  toolInvocationId: string;
  occurredAt?: string;
}): SafeDiagnosticEnvelopeV1 | null {
  const changeSet = new ChangeSetRepository(input.workspace).get(input.changeSetId);
  if (!changeSet || changeSet.mode !== "free" || changeSet.status !== "pending" || changeSet.gateStatus !== "blocked") {
    return null;
  }
  const code = firstMajorConflictCode(changeSet.items);
  if (!code) return null;
  const diagnostics = new SafeDiagnosticRepository(input.workspace);
  const prior = diagnostics.listOperation("tool_call", input.toolInvocationId);
  const replay = prior.find((diagnostic) => diagnostic.code === code && diagnostic.runId === input.runId);
  if (replay) return replay;
  return diagnostics.append({
    schemaVersion: 1,
    diagnosticId: `change-set-policy-${randomUUID()}`,
    operationKind: "tool_call",
    operationId: input.toolInvocationId,
    runId: input.runId,
    cycleId: input.cycleId,
    toolInvocationId: input.toolInvocationId,
    parentDiagnosticId: prior.at(-1)?.diagnosticId ?? null,
    sequence: prior.length + 1,
    owner: "domain_policy",
    boundary: "change_set_policy",
    code,
    toolName: "propose_change_set",
    attempt: null,
    maxAttempts: null,
    sideEffectState: "committed",
    disposition: "terminal",
    retryability: "do_not_retry",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  });
}

function firstMajorConflictCode(
  items: ReturnType<ChangeSetRepository["getRequired"]>["items"],
): WorkspaceChangeSetMajorConflictCode | null {
  for (const item of items) {
    for (const conflict of item.conflicts) {
      if (conflict.severity === "major" && isWorkspaceChangeSetMajorConflictCode(conflict.code)) return conflict.code;
    }
  }
  return null;
}
