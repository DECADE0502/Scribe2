import { generateText, streamText, type CoreMessage, type LanguageModel } from "ai";
import type { StreamEvent, Usage } from "./../types.js";
import { readDeepSeekUsage } from "./deepseek-metadata.js";
import { nextRetryDelay, withRetry } from "./retry.js";

export interface CallInput {
  model: LanguageModel;
  messages: CoreMessage[];
  abortSignal?: AbortSignal;
  onUsage?: (usage: Usage) => void;
}

function toError(raw: unknown): Error {
  if (raw instanceof Error) return raw;
  const message = (raw as { message?: string } | undefined)?.message;
  return new Error(String(message ?? raw ?? "未知流错误(stream_error)"));
}

function toUsage(
  usage: { promptTokens?: number; completionTokens?: number },
  providerMetadata: unknown,
): Usage {
  // ?? 挡不住 NaN(非 DeepSeek provider 流式无 usage 时 SDK 会给 NaN),账本必须拿到有限数
  const finite = (v: number | undefined) => (Number.isFinite(v) ? (v as number) : 0);
  return {
    promptTokens: finite(usage.promptTokens),
    completionTokens: finite(usage.completionTokens),
    cachedTokens: finite(readDeepSeekUsage(providerMetadata).cachedPromptTokens),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 流式调用:透传 text-delta;流内 error part 一律转 throw(绝不静默吞掉)。
 * 尚未流出任何内容时的失败按瞬时错误策略重试;已流出内容则不可重放,直接抛。
 */
export async function* streamCall(input: CallInput): AsyncGenerator<StreamEvent> {
  let attempt = 0;
  while (true) {
    let yielded = false;
    try {
      const result = streamText({
        model: input.model,
        messages: input.messages,
        abortSignal: input.abortSignal,
        maxRetries: 0, // 重试策略由本层 retry.ts 独家负责,SDK 内层默认重试(2 次)必须关掉
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          yielded = true;
          yield { type: "text_delta", delta: part.textDelta };
        } else if (part.type === "error") {
          throw toError(part.error);
        }
      }
      input.onUsage?.(toUsage(await result.usage, await result.providerMetadata));
      return;
    } catch (e) {
      if (input.abortSignal?.aborted || yielded) throw e;
      const delay = nextRetryDelay(e, attempt + 1);
      if (delay === null) throw e;
      attempt += 1;
      await sleep(delay);
    }
  }
}

/** 非流式调用:返回全文,带同样的重试与 usage 回调。 */
export async function generateCall(input: CallInput): Promise<{ text: string; usage: Usage }> {
  const result = await withRetry(() =>
    generateText({
      model: input.model,
      messages: input.messages,
      abortSignal: input.abortSignal,
      maxRetries: 0, // 同 streamCall:关 SDK 内层重试,策略单一来源
    }),
  );
  const usage = toUsage(result.usage, result.providerMetadata);
  input.onUsage?.(usage);
  return { text: result.text, usage };
}
