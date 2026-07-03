import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    setupFiles: ["tests/live/setup.ts"],
    testTimeout: 120_000,
  },
});
