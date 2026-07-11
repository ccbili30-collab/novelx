import { resolve } from "node:path"; import { defineConfig } from "vite";
export default defineConfig({ build: { ssr: resolve(__dirname, "src/agent-worker/evals/gmPromptEvalCli.ts"), target: "node22", outDir: resolve(__dirname, "test-results/gm-prompt-eval-runner"), emptyOutDir: true, rollupOptions: { output: { entryFileNames: "gm-prompt-eval-runner.js" } } } });
