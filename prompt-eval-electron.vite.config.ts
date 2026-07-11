import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: resolve(__dirname, "src/agent-worker/evals/promptEvalElectronCli.ts"),
    target: "node22",
    outDir: resolve(__dirname, "test-results/prompt-eval-electron"),
    emptyOutDir: true,
    rollupOptions: {
      external: ["electron"],
      output: { entryFileNames: "prompt-eval-electron.js" },
    },
  },
});
