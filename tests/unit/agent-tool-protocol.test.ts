import { describe, expect, it } from "vitest";
import {
  agentWorkerToolRequestSchema,
  agentWorkerToolResponseSchema,
  proposeChangeSetArgsSchema,
  retrieveGraphEvidenceResultSchema,
} from "../../src/shared/agentWorkerProtocol";

describe("Agent Worker internal tool protocol", () => {
  it("accepts exactly the two allowlisted tool names and rejects extra fields", () => {
    const base = {
      type: "tool.request",
      runId: "run-1",
      requestId: "11111111-1111-4111-8111-111111111111",
      args: { scopeResourceIds: ["world-1"] },
    };

    expect(agentWorkerToolRequestSchema.safeParse({ ...base, tool: "retrieve_graph_evidence" }).success).toBe(true);
    expect(agentWorkerToolRequestSchema.safeParse({ ...base, tool: "read_workspace_file" }).success).toBe(false);
    expect(agentWorkerToolRequestSchema.safeParse({
      ...base,
      tool: "retrieve_graph_evidence",
      workspacePath: "C:\\private",
    }).success).toBe(false);
  });

  it("keeps authoritative mode, checkpoint and source fields out of Agent proposals", () => {
    const proposal = {
      summary: "补充海岸成因",
      items: [{
        id: "item-1",
        dependsOn: [],
        kind: "assertion.put",
        payload: {
          assertionId: "coast-origin",
          scopeType: "world",
          scopeId: "world-1",
          subject: "银湾海岸",
          predicate: "形成原因",
          object: { reason: "地壳抬升" },
          evidenceIds: ["evidence-version-1"],
        },
      }],
    };

    expect(proposeChangeSetArgsSchema.safeParse(proposal).success).toBe(true);
    expect(proposeChangeSetArgsSchema.safeParse({ ...proposal, mode: "free" }).success).toBe(false);
    expect(proposeChangeSetArgsSchema.safeParse({ ...proposal, expectedHeadCheckpointId: "head-1" }).success).toBe(false);
    expect(proposeChangeSetArgsSchema.safeParse({ ...proposal, workspacePath: "C:\\private" }).success).toBe(false);
  });

  it("requires strict correlated responses", () => {
    const response = {
      type: "tool.response",
      runId: "run-1",
      requestId: "11111111-1111-4111-8111-111111111111",
      ok: false,
      error: { code: "AGENT_TOOL_UNKNOWN", message: "Unknown Agent tool." },
    };
    expect(agentWorkerToolResponseSchema.safeParse(response).success).toBe(true);
    expect(agentWorkerToolResponseSchema.safeParse({ ...response, rawError: "apiKey=secret" }).success).toBe(false);
  });

  it("rejects retrieval metadata that hides omitted or oversized evidence", () => {
    const result = {
      branch: { id: "branch-1", headCheckpointId: "checkpoint-1" },
      scopes: [],
      assertions: [],
      documents: [],
      retrieval: {
        budget: { maxDocuments: 1, maxAssertions: 1, maxDocumentChars: 10, totalChars: 10 },
        usage: { assertions: 0, documents: 0, assertionChars: 0, documentChars: 0, totalChars: 0 },
        completeness: {
          incomplete: false,
          omittedAssertions: 1,
          omittedDocuments: 0,
          truncatedDocuments: 0,
          limitsHit: ["max_assertions"],
        },
        ordering: {
          assertions: "repository_subject_predicate_assertion_id",
          documents: "requested_scope_order",
          relevanceRanking: "not_applied",
        },
      },
    };

    expect(retrieveGraphEvidenceResultSchema.safeParse(result).success).toBe(false);
    result.retrieval.completeness.incomplete = true;
    expect(retrieveGraphEvidenceResultSchema.safeParse(result).success).toBe(true);
  });
});
