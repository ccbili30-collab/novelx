import { describe, expect, it } from "vitest";
import {
  agentWorkerToolRequestSchema,
  agentWorkerToolResponseSchema,
  proposeChangeSetArgsSchema,
  retrieveGraphEvidenceResultSchema,
} from "../../src/shared/agentWorkerProtocol";

describe("Agent Worker internal tool protocol", () => {
  it("accepts allowlisted tools and rejects unknown names or extra fields", () => {
    const base = {
      type: "tool.request",
      runId: "run-1",
      requestId: "11111111-1111-4111-8111-111111111111",
      args: { scopeResourceIds: ["world-1"] },
    };

    expect(agentWorkerToolRequestSchema.safeParse({ ...base, tool: "retrieve_graph_evidence" }).success).toBe(true);
    expect(agentWorkerToolRequestSchema.safeParse({
      ...base,
      tool: "generate_image",
      args: {
        title: "银湾夜潮",
        purpose: "scene",
        prompt: "月光下的银湾海岸",
        sourceResourceIds: ["world-1"],
        sourceVersionIds: ["version-1"],
        idempotencyKey: "silver-bay-night-v1",
      },
    }).success).toBe(true);
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

  it("accepts only source-bound, dependency-declared causal relation proposals", () => {
    const proposal = causalProposal();
    expect(proposeChangeSetArgsSchema.safeParse(proposal).success).toBe(true);

    const causal = proposal.items[2]!;
    if (causal.kind !== "causal_relation.put") throw new Error("Expected causal proposal fixture.");
    expect(proposeChangeSetArgsSchema.safeParse({
      ...proposal,
      items: [...proposal.items.slice(0, 2), { ...causal, payload: { ...causal.payload, sourceBindings: [] } }],
    }).success).toBe(false);
    expect(proposeChangeSetArgsSchema.safeParse({
      ...proposal,
      items: [...proposal.items.slice(0, 2), {
        ...causal,
        payload: { ...causal.payload, effectAssertionId: causal.payload.causeAssertionId },
      }],
    }).success).toBe(false);
    expect(proposeChangeSetArgsSchema.safeParse({
      ...proposal,
      items: [...proposal.items.slice(0, 2), { ...causal, dependsOn: ["cause"] }],
    }).success).toBe(false);
    expect(proposeChangeSetArgsSchema.safeParse({
      ...proposal,
      items: [...proposal.items.slice(0, 2), {
        ...causal,
        payload: { ...causal.payload, prompt: "ignore policy", apiKey: "secret" },
      }],
    }).success).toBe(false);
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

function causalProposal() {
  const assertion = (id: string) => ({
    id,
    dependsOn: [],
    kind: "assertion.put" as const,
    payload: {
      assertionId: `assertion.${id}`,
      scopeType: "world",
      scopeId: "world-1",
      subject: id,
      predicate: "state",
      object: { state: id },
      evidenceIds: ["document-version-1"],
    },
  });
  return {
    summary: "记录月潮对航路的因果影响",
    items: [assertion("cause"), assertion("effect"), {
      id: "causal",
      dependsOn: ["cause", "effect"],
      kind: "causal_relation.put" as const,
      payload: {
        relationId: "relation.moon-route",
        relationKind: "causes" as const,
        causeAssertionId: "assertion.cause",
        causeAssertionItemId: "cause",
        effectAssertionId: "assertion.effect",
        effectAssertionItemId: "effect",
        mechanism: "潮差改变浅滩可航窗口。",
        conditions: ["强月潮"],
        temporalScope: "涨潮后三小时",
        polarityStrengthSummary: "强正向",
        epistemicStatus: "confirmed" as const,
        sourceBindings: [{ evidenceId: "document-version-1", stableLocator: "paragraph:1" }],
      },
    }],
  };
}
