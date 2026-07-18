import type { SemanticGraphSnapshot } from "./ipcContract";

export interface SemanticGraphEdgeVisualStyle {
  stroke: string;
  strokeWidth: number;
  strokeDasharray: string | undefined;
}

export function semanticGraphEdgeStyle(
  edge: SemanticGraphSnapshot["edges"][number],
): SemanticGraphEdgeVisualStyle {
  const causalStroke = edge.kind === "causal"
    ? edge.epistemicStatus === "disputed"
      ? "var(--novax-color-danger)"
      : edge.epistemicStatus === "inferred"
        ? "var(--novax-color-warning)"
        : "var(--novax-color-accent)"
    : null;
  return {
    stroke: edge.status === "conflict" ? "var(--novax-color-danger)" : causalStroke ?? "var(--novax-color-graph-edge)",
    strokeWidth: edge.kind === "causal" ? 2 : 1.3,
    strokeDasharray: edge.kind === "causal" && edge.epistemicStatus !== "confirmed" ? "6 4" : undefined,
  };
}
