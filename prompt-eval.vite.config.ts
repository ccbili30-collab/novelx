import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: resolve(__dirname, "src/agent-worker/evals/promptEvalCli.ts"),
    target: "node22",
    outDir: resolve(__dirname, "test-results/prompt-eval-runner"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "prompt-eval-runner.js",
      },
    },
  },
});
