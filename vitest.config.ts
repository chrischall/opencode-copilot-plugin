import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The M365 protocol is inherently sequential (their AGENTS.md: the rate limit
    // tracks threads-started, not messages). Our stub-server tests bind real ports,
    // so keep them serialised too — it makes port collisions impossible.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
