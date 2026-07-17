import { describe, expect, it } from "vitest";
import {
  requiresCausalExtraction,
  validateCausalRelation,
  validateCausalRelationSet,
} from "../../src/domain/graph/causalRelationPolicy";
import { causalRelationKinds, type CausalRelationDefinition } from "../../src/domain/graph/causalRelationTypes";

describe("causal relation policy", () => {
  it("accepts every fixed causal kind and rejects invented kinds", () => {
    for (const kind of causalRelationKinds) {
      expect(validateCausalRelation(relation({ id: `relation.${kind}`, kind })).kind).toBe(kind);
    }
    expect(() => validateCausalRelation(relation({ kind: "correlates_with" as never })))
      .toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_KIND_INVALID" }));
  });

  it("encodes geographic isolation through transport and diffusion into national development", () => {
    const chain = validateCausalRelationSet([
      relation({
        id: "relation.isolation.transport",
        causeAssertionId: "assertion.geographic-isolation",
        effectAssertionId: "assertion.transport-cost",
        mechanism: "山脉和海峡迫使道路与港口承担更高建设和维护成本。",
      }),
      relation({
        id: "relation.transport.diffusion",
        causeAssertionId: "assertion.transport-cost",
        effectAssertionId: "assertion.diffusion-rate",
        mechanism: "高运输成本减少人员、技术和制度跨区交换频率。",
      }),
      relation({
        id: "relation.diffusion.development",
        causeAssertionId: "assertion.diffusion-rate",
        effectAssertionId: "assertion.national-development-rate",
        mechanism: "缓慢扩散延迟生产技术和治理制度的规模化采用。",
      }),
    ]);
    expect(chain.map((edge) => edge.effectAssertionId)).toEqual([
      "assertion.transport-cost",
      "assertion.diffusion-rate",
      "assertion.national-development-rate",
    ]);
  });

  it("encodes childhood poverty through deprivation and defensive behavior into insecurity", () => {
    const chain = validateCausalRelationSet([
      relation({
        id: "relation.poverty.deprivation",
        causeAssertionId: "assertion.childhood-poverty",
        effectAssertionId: "assertion.deprivation-and-stigma",
        mechanism: "长期资源不足与同伴污名共同形成匮乏预期。",
      }),
      relation({
        id: "relation.deprivation.defense",
        causeAssertionId: "assertion.deprivation-and-stigma",
        effectAssertionId: "assertion.defensive-behavior",
        mechanism: "对再次受辱的预期促使角色优先隐藏需求并攻击性防御。",
      }),
      relation({
        id: "relation.defense.insecurity",
        causeAssertionId: "assertion.defensive-behavior",
        effectAssertionId: "assertion.insecurity",
        mechanism: "持续防御削弱可信关系，反过来维持不安全感。",
      }),
    ]);
    expect(chain).toHaveLength(3);
    expect(chain.every((edge) => edge.sourceReferences.length > 0)).toBe(true);
  });

  it("represents feedback as opposite directed edges and rejects a self-edge", () => {
    expect(validateCausalRelationSet([
      relation({ id: "relation.a.b", causeAssertionId: "assertion.a", effectAssertionId: "assertion.b" }),
      relation({ id: "relation.b.a", causeAssertionId: "assertion.b", effectAssertionId: "assertion.a" }),
    ])).toHaveLength(2);
    expect(() => validateCausalRelation(relation({
      causeAssertionId: "assertion.a",
      effectAssertionId: "assertion.a",
    }))).toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_SELF_EDGE_FORBIDDEN" }));
  });

  it("rejects correlation prose without a mechanism or a source", () => {
    const valid = relation();
    expect(() => validateCausalRelation({ ...valid, mechanism: "" }))
      .toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_MECHANISM_REQUIRED" }));
    expect(() => validateCausalRelation({ ...valid, sourceReferences: [] }))
      .toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_SOURCE_REQUIRED" }));
    expect(() => validateCausalRelation({ ...valid, causeAssertionId: "一段没有断言身份的自然语言" }))
      .toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_ENDPOINT_INVALID" }));
  });

  it("does not require an edge for descriptive prose without development impact", () => {
    expect(requiresCausalExtraction({ describesOnly: true, claimsDevelopmentImpact: false })).toBe(false);
    expect(requiresCausalExtraction({ describesOnly: false, claimsDevelopmentImpact: true })).toBe(true);
  });

  it("requires explicit conditions, time, polarity/strength and allowed epistemic state", () => {
    const valid = relation();
    expect(() => validateCausalRelation({ ...valid, conditions: [] }))
      .toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_CONDITIONS_REQUIRED" }));
    expect(() => validateCausalRelation({ ...valid, temporalScope: "" }))
      .toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_TEMPORAL_SCOPE_REQUIRED" }));
    expect(() => validateCausalRelation({ ...valid, polarityStrengthSummary: "" }))
      .toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_POLARITY_STRENGTH_REQUIRED" }));
    expect(() => validateCausalRelation({ ...valid, epistemicStatus: "unknown" }))
      .toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_EPISTEMIC_STATUS_INVALID" }));
    expect(() => validateCausalRelation({ ...valid, confidence: 0.98 }))
      .toThrowError(expect.objectContaining({ code: "DOMAIN_CAUSAL_DEFINITION_INVALID" }));
  });
});

function relation(overrides: Partial<CausalRelationDefinition> = {}): CausalRelationDefinition {
  return {
    id: "relation.default",
    kind: "causes",
    causeAssertionId: "assertion.cause",
    effectAssertionId: "assertion.effect",
    mechanism: "前置事实通过明确机制改变后置事实的发展条件。",
    conditions: ["在资源和制度条件持续存在时"],
    temporalScope: "沉降纪元至当前检查点",
    polarityStrengthSummary: "正向、中等强度；不表达伪精确概率。",
    epistemicStatus: "confirmed",
    sourceReferences: [{
      sourceId: "source.1",
      sourceKind: "document",
      sourceVersionId: "document-version.1",
      stableLocator: "chapter-1:paragraph-2",
      sourceSha256: "a".repeat(64),
    }],
    ...overrides,
  };
}
