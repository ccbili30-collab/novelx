import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/support/growthWatcher.test.ts"],
    reporters: ["default", "./tests/support/noUnexpectedSkippedTestsReporter.ts"],
  },
});
