import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    globalSetup: ["./tests/support/runtimeV2IntegrationGlobalSetup.ts"],
    reporters: ["default", "./tests/support/noUnexpectedSkippedTestsReporter.ts"],
  },
});
