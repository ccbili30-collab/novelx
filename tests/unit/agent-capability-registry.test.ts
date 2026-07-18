import { describe, expect, it } from "vitest";
import {
  agentCapabilityRegistryVersion,
  authorizeCapabilityInvocation,
  listAgentCapabilities,
  parseCapabilitySubmission,
  requireAgentCapability,
  type AgentCapabilityDefinition,
  type TrustedPromptAssetIdentity,
} from "../../src/agent-worker/editorial/agentCapabilityRegistry";
import { agentCapabilityIds, growthEditorialContractVersion } from "../../src/shared/growthEditorialContract";

describe("fixed Agent capability registry", () => {
  it("registers every authoritative capability exactly once with immutable execution metadata", () => {
    const definitions = listAgentCapabilities();
    expect(agentCapabilityRegistryVersion).toBe("1.0.0");
    expect(definitions.map((entry) => entry.capabilityId)).toEqual(agentCapabilityIds);
    expect(new Set(definitions.map((entry) => entry.profile.sha256)).size).toBe(agentCapabilityIds.length);
    for (const definition of definitions) {
      expect(definition.profile.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(definition.promptAsset.id).toMatch(/^novax\./);
      expect(definition.promptAsset.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(definition.terminalSubmissionTool).toMatch(/^submit_/);
      expect(Object.isFrozen(definition)).toBe(true);
    }
  });

  it("fails closed for an unknown capability", () => {
    expectCode(() => requireAgentCapability("invented_author"), "AGENT_CAPABILITY_UNKNOWN");
    expectCode(() => authorizeCapabilityInvocation({ ...invocation(requireAgentCapability("writer")), capabilityId: "invented_author" }, []), "AGENT_CAPABILITY_UNKNOWN");
  });

  it("binds profile, Prompt hash, contract and the single terminal tool", () => {
    const definition = requireAgentCapability("world_system_author");
    const trustedPrompt = prompt(definition, "a".repeat(64));
    const valid = invocation(definition, trustedPrompt);
    expect(authorizeCapabilityInvocation(valid, [trustedPrompt]).definition.capabilityId).toBe("world_system_author");

    expectCode(() => authorizeCapabilityInvocation({
      ...valid,
      prompt: { ...valid.prompt, sha256: "b".repeat(64) },
    }, [trustedPrompt]), "AGENT_CAPABILITY_PROMPT_HASH_MISMATCH");
    expectCode(() => authorizeCapabilityInvocation({
      ...valid,
      requestedTools: [definition.terminalSubmissionTool, "write_database"],
    }, [trustedPrompt]), "AGENT_CAPABILITY_TOOL_POLICY_MISMATCH");
    expectCode(() => authorizeCapabilityInvocation({
      ...valid,
      inputContractId: "graph_curator_candidate_v1",
      outputContractId: "graph_curator_candidate_v1",
    }, [trustedPrompt]), "AGENT_CAPABILITY_CONTRACT_MISMATCH");
    expectCode(() => authorizeCapabilityInvocation({
      ...valid,
      profile: { ...valid.profile, sha256: "c".repeat(64) },
    }, [trustedPrompt]), "AGENT_CAPABILITY_PROFILE_MISMATCH");
  });

  it("requires one trusted Prompt identity and a capability-bound input schema", () => {
    const definition = requireAgentCapability("graph_curator");
    const trustedPrompt = prompt(definition, "d".repeat(64));
    const valid = invocation(definition, trustedPrompt);
    expectCode(() => authorizeCapabilityInvocation(valid, []), "AGENT_CAPABILITY_PROMPT_NOT_REGISTERED");
    expectCode(() => authorizeCapabilityInvocation(valid, [trustedPrompt, trustedPrompt]), "AGENT_CAPABILITY_PROMPT_NOT_REGISTERED");
    expectCode(() => authorizeCapabilityInvocation({
      ...valid,
      input: { ...valid.input, capabilityId: "writer" },
    }, [trustedPrompt]), "AGENT_CAPABILITY_INPUT_CONTRACT_MISMATCH");
    expectCode(() => authorizeCapabilityInvocation({
      ...valid,
      input: { ...valid.input, apiKey: "forbidden" },
    }, [trustedPrompt]), "AGENT_CAPABILITY_INPUT_CONTRACT_MISMATCH");
  });

  it("parses only the output contract registered for the capability", () => {
    const ready = {
      status: "ready",
      summary: "地理候选覆盖水系与资源因果。",
      contentArtifactRefs: ["@artifact1"],
      evidenceRefs: ["@evidence1"],
      coverage: [{ facetId: "hydrology", state: "covered", evidenceRefs: ["@evidence1"] }],
    };
    expect(parseCapabilitySubmission("geography_ecology_author", "specialist_candidate_v1", ready)).toEqual(ready);
    expectCode(() => parseCapabilitySubmission("graph_curator", "specialist_candidate_v1", ready), "AGENT_CAPABILITY_CONTRACT_MISMATCH");
    expectCode(() => parseCapabilitySubmission("geography_ecology_author", "specialist_candidate_v1", {
      ...ready,
      tools: ["write_database"],
    }), "AGENT_CAPABILITY_OUTPUT_CONTRACT_MISMATCH");
  });
});

function prompt(definition: AgentCapabilityDefinition, sha256: string): TrustedPromptAssetIdentity {
  return { ...definition.promptAsset, sha256 };
}

function invocation(definition: AgentCapabilityDefinition, trustedPrompt = prompt(definition, "a".repeat(64))) {
  return {
    capabilityId: definition.capabilityId,
    profile: { ...definition.profile },
    prompt: { ...trustedPrompt },
    inputContractId: definition.contract.id,
    outputContractId: definition.contract.id,
    requestedTools: [definition.terminalSubmissionTool],
    input: {
      capabilityId: definition.capabilityId,
      contractVersion: growthEditorialContractVersion,
      inputContractId: definition.contract.id,
      sourceCheckpointId: "checkpoint-1",
      workOrderId: "work-order-1",
      packetSha256: "f".repeat(64),
    },
  };
}

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrow(expect.objectContaining({ code }));
}
