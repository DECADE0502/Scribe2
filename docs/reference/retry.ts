import type { ErrorClass } from "@scribe/shared";

export interface RetryOpts {
  classify: (e: unknown) => ErrorClass;
  sleepImpl?: (ms: number) => Promise<void>;
  onAttempt?: (n: number, cls: ErrorClass) => void;
}

const POLICY: Record<ErrorClass, { maxRetries: number; backoff: (n: number) => number }> = {
  rate_limit: { maxRetries: 3, backoff: (n) => 1000 * 2 ** (n - 1) },
  timeout: { maxRetries: 1, backoff: () => 0 },
  stream_idle: { maxRetries: 1, backoff: () => 0 },
  auth: { maxRetries: 0, backoff: () => 0 },
  context_overflow: { maxRetries: 1, backoff: () => 0 },
  unknown: { maxRetries: 0, backoff: () => 0 },
};

/**
 * 通用 LLM 错误分类:从 status code / 错误信息推断重试类别。
 * 供 withRetry 使用,让 429 等瞬时错误真正走退避重试(此前 retry 模块完全没接线)。
 */
export function classifyLlmError(e: unknown): ErrorClass {
  const anyE = e as { statusCode?: number; status?: number; message?: string; name?: string } | undefined;
  const status = anyE?.statusCode ?? anyE?.status;
  const msg = String(anyE?.message ?? "").toLowerCase();
  if (anyE?.name === "AbortError") return "unknown"; // 用户主动取消,不重试
  if (status === 429 || msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) {
    return "rate_limit";
  }
  if (status === 401 || status === 403 || msg.includes("unauthorized") || msg.includes("invalid api key") || msg.includes("invalid key")) {
    return "auth";
  }
  if (msg.includes("context length") || msg.includes("maximum context") || msg.includes("context_length_exceeded") || msg.includes("too many tokens")) {
    return "context_overflow";
  }
  if (
    anyE?.name === "TimeoutError" || msg.includes("timeout") || msg.includes("etimedout") ||
    msg.includes("econnreset") || msg.includes("socket hang up") || msg.includes("fetch failed") ||
    (typeof status === "number" && status >= 500)
  ) {
    return "timeout";
  }
  return "unknown";
}

export async function withRetry<T>(op: () => Promise<T>, opts: RetryOpts): Promise<T> {
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let attempt = 0;
  while (true) {
    try {
      return await op();
    } catch (e) {
      const cls = opts.classify(e);
      const policy = POLICY[cls];
      if (attempt >= policy.maxRetries) throw e;
      attempt += 1;
      opts.onAttempt?.(attempt, cls);
      await sleep(policy.backoff(attempt));
    }
  }
}
