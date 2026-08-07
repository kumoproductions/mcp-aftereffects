import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // After Effects is a single shared instance driven through one
    // request/response file pair: run suites sequentially so concurrent
    // suites never race over runtime/request.json.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 60_000,
    globals: false,
    reporters: "default",
  },
});
