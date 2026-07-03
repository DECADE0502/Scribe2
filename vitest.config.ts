import { defineConfig } from "vitest/config";

export default defineConfig({
  // retry:Windows 下多 worker 并发 spawn git 偶发抖动,重试一次;真回归会连挂两次照样报红
  test: { include: ["tests/unit/**/*.test.ts"], retry: 1 },
});
