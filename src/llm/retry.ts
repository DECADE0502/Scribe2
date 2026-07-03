// 瞬时错误退避重试(移植自旧仓):429/5xx/网络抖动重试,auth/用户取消不重试。
export type ErrorClass = "rate_limit" | "timeout" | "auth" | "context_overflow" | "unknown";

const POLICY: Record<ErrorClass, { maxRetries: number; backoff: (n: number) => number }> = {
  rate_limit: { maxRetries: 3, backoff: (n) => 1000 * 2 ** (n - 1) },
  timeout: { maxRetries: 2, backoff: (n) => 500 * 2 ** (n - 1) },
  auth: { maxRetries: 0, backoff: () => 0 },
  context_overflow: { maxRetries: 0, backoff: () => 0 },
  unknown: { maxRetries: 0, backoff: () => 0 },
};

export function classifyLlmError(e: unknown): ErrorClass {
  const err = e as
    | {
        statusCode?: number;
        status?: number;
        message?: string;
        name?: string;
        errors?: unknown[];
        lastError?: unknown;
      }
    | undefined;
  // ai SDK 的 RetryError 是包装层,按最后一次真实错误分类
  if (err?.name === "AI_RetryError" || err?.name === "RetryError") {
    const inner = err.errors?.at(-1) ?? err.lastError;
    if (inner) return classifyLlmError(inner);
  }
  const status = err?.statusCode ?? err?.status;
  const msg = String(err?.message ?? "").toLowerCase();
  if (err?.name === "AbortError") return "unknown"; // 用户主动取消,不重试
  // context 溢出是确定性失败,必须先于 rate_limit 判定(消息可能同时含 429 字样)
  if (
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("too many tokens")
  ) {
    return "context_overflow";
  }
  // 429 只信 statusCode 或明确措辞;裸 "429" 子串会误伤(如 "requested 14290 tokens")
  if (status === 429 || msg.includes("rate limit") || msg.includes("too many requests")) {
    return "rate_limit";
  }
  if (
    status === 401 ||
    status === 403 ||
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid key")
  ) {
    return "auth";
  }
  if (
    err?.name === "TimeoutError" ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    (typeof status === "number" && status >= 500)
  ) {
    return "timeout";
  }
  return "unknown";
}

/** 返回第 attempt 次(从 1 数)重试前应等待的毫秒;不该重试时返回 null。 */
export function nextRetryDelay(e: unknown, attempt: number): number | null {
  const policy = POLICY[classifyLlmError(e)];
  if (attempt > policy.maxRetries) return null;
  return policy.backoff(attempt);
}

export interface RetryOpts {
  sleepImpl?: (ms: number) => Promise<void>;
  onAttempt?: (n: number, cls: ErrorClass) => void;
}

export async function withRetry<T>(op: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const sleep =
    opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  while (true) {
    try {
      return await op();
    } catch (e) {
      const delay = nextRetryDelay(e, attempt + 1);
      if (delay === null) throw e;
      attempt += 1;
      opts.onAttempt?.(attempt, classifyLlmError(e));
      await sleep(delay);
    }
  }
}
