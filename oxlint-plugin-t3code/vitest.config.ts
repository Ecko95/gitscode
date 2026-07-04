import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each oxlint test spawns a real subprocess (~550 ms locally, up to ~2 s on CI).
    testTimeout: 10_000,
  },
});
