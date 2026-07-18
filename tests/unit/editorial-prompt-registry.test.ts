import { describe, expect, it } from "vitest";
import {
  editorialPromptCapabilityIds,
  editorialPromptRegistryVersion,
  evaluateEditorialPromptCandidates,
  loadCandidateEditorialPrompts,
  requireActiveEditorialPrompt,
  verifyEditorialPromptCandidates,
  type EditorialPromptAsset,
} from "../../src/agent-worker/editorial/editorialPromptRegistry";
import { requireAgentCapability } from "../../src/agent-worker/editorial/agentCapabilityRegistry";

describe("editorial Prompt candidate registry", () => {
  it("loads exactly eleven versioned candidates bound to the fixed capability registry", () => {
    const prompts = loadCandidateEditorialPrompts();
    expect(editorialPromptRegistryVersion).toBe("1.0.0");
    expect(prompts.map((prompt) => prompt.capabilityId)).toEqual(editorialPromptCapabilityIds);
    expect(new Set(prompts.map((prompt) => prompt.sha256)).size).toBe(prompts.length);
    for (const prompt of prompts) {
      const capability = requireAgentCapability(prompt.capabilityId);
      expect(prompt).toMatchObject({
        id: capability.promptAsset.id,
        version: capability.promptAsset.version,
        status: "candidate",
        publicationEvidence: null,
      });
      expect(prompt.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(prompt.content).toContain(`# Capability: ${prompt.capabilityId}`);
      expect(prompt.content).toContain(capability.terminalSubmissionTool);
    }
  });

  it("passes a static contract lint that is explicitly not publication evidence", () => {
    const report = evaluateEditorialPromptCandidates();
    expect(report.classification).toBe("static-contract-lint-not-publication-evidence");
    expect(report.cases).toHaveLength(11);
    expect(report.cases.every((item) => item.passed && item.issues.length === 0)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("publicationEvidence");
    expectCode(() => requireActiveEditorialPrompt("world_system_author"), "EDITORIAL_PROMPT_NOT_PUBLISHED");
  });

  it("fails closed for content tampering, identity drift, incomplete sets and fake activation", () => {
    const prompts = loadCandidateEditorialPrompts();
    expectCode(() => verifyEditorialPromptCandidates(prompts.map((prompt, index) =>
      index === 0 ? { ...prompt, content: `${prompt.content}\n篡改` } : prompt)), "EDITORIAL_PROMPT_INTEGRITY_FAILED");
    expectCode(() => verifyEditorialPromptCandidates(prompts.map((prompt, index) =>
      index === 0 ? { ...prompt, id: "novax.editorial.invented" } : prompt)), "EDITORIAL_PROMPT_CAPABILITY_MISMATCH");
    expectCode(() => verifyEditorialPromptCandidates(prompts.slice(1)), "EDITORIAL_PROMPT_SET_INCOMPLETE");
    expectCode(() => verifyEditorialPromptCandidates(prompts.map((prompt, index): EditorialPromptAsset =>
      index === 0 ? {
        ...prompt,
        status: "active",
        publicationEvidence: {
          reportPath: "notes/evidence/editorial/fake.json",
          reportSha256: "a".repeat(64),
          providerId: "fixture",
          modelId: "fixture",
          evaluatedAt: "2026-07-18T00:00:00.000Z",
        },
      } : prompt)), "EDITORIAL_PROMPT_CANDIDATE_SET_REQUIRED");
  });

  it("keeps fixed-role, source, authority, reasoning and model-audit rules in every composed asset", () => {
    for (const prompt of loadCandidateEditorialPrompts()) {
      expect(prompt.content).toContain("固定员工");
      expect(prompt.content).toContain("不可信项目资料");
      expect(prompt.content).toContain("不得自行更换角色");
      expect(prompt.content).toContain("没有项目工具");
      expect(prompt.content).toContain("不要输出思维链");
      expect(prompt.content).toContain("Provider、model、Prompt 版本与 profile 身份由 Harness 审计");
      expect(prompt.content).toContain("只调用一次");
    }
  });
});

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrow(expect.objectContaining({ code }));
}
