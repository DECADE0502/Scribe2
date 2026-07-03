// PLAN Task 2 补测(评审测试缺口):重试策略与错误分类。
import { describe, expect, it, vi } from "vitest";
import { withRetry, classifyLlmError, nextRetryDelay } from "../../src/llm/retry.js";

describe("classifyLlmError", () => {
  it("429 只信 statusCode,消息里凑巧含 429 数字不算", () => {
    expect(classifyLlmError({ statusCode: 429, message: "x" })).toBe("rate_limit");
    expect(classifyLlmError({ message: "rate limit exceeded" })).toBe("rate_limit");
    expect(classifyLlmError({ message: "you requested 14290 tokens" })).not.toBe("rate_limit");
  });
  it("context 溢出优先于 rate_limit(消息同时含两类线索时)", () => {
    expect(classifyLlmError({ message: "429: maximum context length exceeded" })).toBe("context_overflow");
  });
  it("auth 不重试;5xx/网络归 timeout", () => {
    expect(classifyLlmError({ statusCode: 401 })).toBe("auth");
    expect(classifyLlmError({ statusCode: 503 })).toBe("timeout");
    expect(classifyLlmError({ message: "fetch failed" })).toBe("timeout");
  });
  it("AI_RetryError 解包内层错误再分类", () => {
    const inner = { statusCode: 429, message: "too many requests" };
    expect(classifyLlmError({ name: "AI_RetryError", message: "Failed after 3 attempts", errors: [inner] })).toBe("rate_limit");
    expect(classifyLlmError({ name: "AI_RetryError", message: "x", lastError: { statusCode: 401 } })).toBe("auth");
  });
});

describe("nextRetryDelay", () => {
  it("rate_limit 指数退避 1s/2s/4s,第 4 次不再重试", () => {
    const e = { statusCode: 429 };
    expect(nextRetryDelay(e, 1)).toBe(1000);
    expect(nextRetryDelay(e, 2)).toBe(2000);
    expect(nextRetryDelay(e, 3)).toBe(4000);
    expect(nextRetryDelay(e, 4)).toBeNull();
  });
  it("auth/unknown 不重试", () => {
    expect(nextRetryDelay({ statusCode: 401 }, 1)).toBeNull();
    expect(nextRetryDelay({ message: "随便什么错" }, 1)).toBeNull();
  });
});

describe("withRetry", () => {
  it("429 两败后成功:sleep 序列 [1000, 2000]", async () => {
    const sleeps: number[] = [];
    const op = vi.fn()
      .mockRejectedValueOnce({ statusCode: 429 })
      .mockRejectedValueOnce({ statusCode: 429 })
      .mockResolvedValueOnce("ok");
    const out = await withRetry(op, { sleepImpl: async (ms) => void sleeps.push(ms) });
    expect(out).toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
  });
  it("auth 错误立即抛,不 sleep", async () => {
    const sleeps: number[] = [];
    const op = vi.fn().mockRejectedValue({ statusCode: 401, message: "unauthorized" });
    await expect(withRetry(op, { sleepImpl: async (ms) => void sleeps.push(ms) })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
});
