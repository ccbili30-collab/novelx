import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = path.resolve(import.meta.dirname, "../..");
const css = fs.readFileSync(path.join(appRoot, "src/renderer/src/styles/base.css"), "utf8");
const graphView = fs.readFileSync(
  path.join(appRoot, "src/renderer/src/features/graph/SemanticGraphView.tsx"),
  "utf8",
);
const graphEdgeStyle = fs.readFileSync(
  path.join(appRoot, "src/shared/semanticGraphEdgeStyle.ts"),
  "utf8",
);

const graphTokenNames = [
  "--novax-color-text-strong",
  "--novax-color-text",
  "--novax-color-text-subtle",
  "--novax-color-text-faint",
  "--novax-color-surface-control",
  "--novax-color-surface-subtle",
  "--novax-color-surface-hover",
  "--novax-color-surface-selected",
  "--novax-color-border-control",
  "--novax-color-focus-ring",
  "--novax-color-danger-surface",
  "--novax-color-danger-border",
  "--novax-color-danger-strong",
  "--novax-color-entity",
  "--novax-color-graph-edge",
  "--novax-color-graph-handle",
  "--novax-color-graph-source",
] as const;

describe("renderer theme token contract", () => {
  it.each(["white", "cloude", "dark", "high-contrast"])("defines graph semantics for the %s theme", (theme) => {
    const block = themeBlock(theme);
    for (const token of graphTokenNames) expect(block).toContain(`${token}:`);
  });

  it("maps the supplied cloude palette and typography into Novax tokens", () => {
    const block = themeBlock("cloude");
    expect(block).toContain("--novax-color-accent: #da7756;");
    expect(block).toContain("--novax-color-ink: #141413;");
    expect(block).toContain("--novax-color-app: #f5f4ee;");
    expect(block).toContain("--novax-color-diff-added: #00c853;");
    expect(block).toContain("--novax-color-diff-removed: #ff5f38;");
    expect(block).toContain("--novax-color-skill: #cc7d5e;");
    expect(block).toContain('--novax-font-code: "JetBrainsMono NFM"');
    expect(block).toContain('--novax-font-ui: ui-serif, Georgia, Cambria, "Times New Roman", Times, "Noto Serif SC", serif;');
  });

  it("keeps graph component colors theme-resolved", () => {
    const graphRenderingAuthority = `${graphView}\n${graphEdgeStyle}`;
    expect(graphRenderingAuthority).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    expect(graphRenderingAuthority).toContain("var(--novax-color-graph-edge)");
    expect(graphRenderingAuthority).toContain("var(--novax-color-danger)");
  });

  it("keeps every renderer component rule free of literal colors", () => {
    const componentRules = css.slice(css.indexOf("* { box-sizing: border-box; }"));
    expect(componentRules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
});

function themeBlock(theme: string): string {
  const marker = `:root[data-theme="${theme}"]`;
  const start = css.indexOf(marker);
  const end = css.indexOf("\n}", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}
