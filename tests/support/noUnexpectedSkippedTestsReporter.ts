import type { TestModule } from "vitest/node";
import type { Reporter } from "vitest/reporters";

export default class NoUnexpectedSkippedTestsReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const counts = { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0 };
    const skippedTests: string[] = [];
    for (const testModule of testModules) {
      for (const test of testModule.children.allTests()) {
        counts.total += 1;
        counts[test.result().state] += 1;
        if (test.result().state === "skipped") skippedTests.push(test.fullName);
      }
    }
    const debugSelection = process.env.NOVELX_TEST_STAGE === "toolcall-debug";
    process.stdout.write(`[novelx-vitest-audit] ${JSON.stringify({
      schemaVersion: 1,
      stage: process.env.NOVELX_TEST_STAGE ?? "direct",
      skipPolicy: debugSelection ? "debug_selection_allowed" : "zero_unexpected_skips",
      counts,
    })}\n`);
    if (!debugSelection && counts.skipped > 0) {
      throw new Error(`Unexpected skipped tests (${counts.skipped}): ${skippedTests.join(" | ")}`);
    }
  }
}
