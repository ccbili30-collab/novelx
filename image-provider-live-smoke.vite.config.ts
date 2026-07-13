import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: resolve(__dirname, "src/main/imageProviderLiveSmokeCli.ts"),
    target: "node22",
    outDir: resolve(__dirname, "test-results/image-provider-live-smoke"),
    emptyOutDir: true,
    rollupOptions: {
      external: ["electron"],
      output: { entryFileNames: "image-provider-live-smoke.js" },
    },
  },
});
