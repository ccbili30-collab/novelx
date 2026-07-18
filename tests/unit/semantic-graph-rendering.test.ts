import { describe, expect, it } from "vitest";
import { semanticGraphEdgeStyle } from "../../src/shared/semanticGraphEdgeStyle";
import type { SemanticGraphSnapshot } from "../../src/shared/ipcContract";

describe("Semantic graph causal rendering", () => {
  it("gives confirmed, inferred and disputed causal edges distinct visual treatments", () => {
    const edge = (epistemicStatus: "confirmed" | "inferred" | "disputed") => ({
      id: `edge-${epistemicStatus}`,
      kind: "causal" as const,
      sourceNodeId: "cause",
      targetNodeId: "effect",
      label: "导致",
      status: "current" as const,
      relationKind: "causes" as const,
      mechanismSummary: "潮差改变浅滩可航窗口。",
      epistemicStatus,
      sourceReferences: [{ kind: "document" as const, versionId: "document-version", locator: "paragraph:1" }],
    }) satisfies SemanticGraphSnapshot["edges"][number];

    const confirmed = semanticGraphEdgeStyle(edge("confirmed"));
    const inferred = semanticGraphEdgeStyle(edge("inferred"));
    const disputed = semanticGraphEdgeStyle(edge("disputed"));
    expect(confirmed).toMatchObject({ stroke: "var(--novax-color-accent)", strokeWidth: 2 });
    expect(confirmed.strokeDasharray).toBeUndefined();
    expect(inferred).toMatchObject({ stroke: "var(--novax-color-warning)", strokeDasharray: "6 4" });
    expect(disputed).toMatchObject({ stroke: "var(--novax-color-danger)", strokeDasharray: "6 4" });
    expect(new Set([confirmed.stroke, inferred.stroke, disputed.stroke]).size).toBe(3);
  });
});
