import { resolve } from "node:path";
import { defineConfig } from "vite";
export default defineConfig({ build: { ssr: resolve(__dirname, "src/agent-worker/evals/decomposerPromptEvalCli.ts"), target: "node22", outDir: resolve(__dirname, "test-results/decomposer-prompt-eval-runner"), emptyOutDir: true, rollupOptions: { output: { entryFileNames: "decomposer-prompt-eval-runner.js" } } } });
