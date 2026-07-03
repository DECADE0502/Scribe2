import {
  generateText,
  streamText,
  type LanguageModel,
  type CoreMessage,
  type Tool,
} from "ai";
import { readDeepSeekUsage } from "./providers/deepseek-metadata.js";
import { withRetry, classifyLlmError } from "./retry.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type ProviderOptions = Record<string, Record<string, JsonValue>>;

export interface LlmCallInput {
  model: LanguageModel;
  messages: CoreMessage[];
  tools?: Record<string, Tool>;
  abortSignal?: AbortSignal;
  /**
   * Vercel AI SDK 默认 maxSteps=1(只跑一次)。要让模型在 tool_call 之后自动续写,
   * 需要让 streamText 多步执行。本字段控制最多续写多少轮,默认 5。
   */
  maxSteps?: number;
  providerOptions?: ProviderOptions;
}

export interface GeneratedLlmText {
  text: string;
  reasoning?: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
    reasoningTokens?: number;
  };
}

export type LlmStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_start"; toolName: string; args?: unknown }
  | { type: "tool_call_end"; toolName: string; result: unknown }
  | { type: "usage"; promptTokens: number; completionTokens: number; cachedTokens?: number; reasoningTokens?: number }
  | { type: "done" }
  | { type: "error"; errorClass: string; message: string };

/**
 * B-6-002 修复:工具执行抛错时,SDK 会把整个流断掉(LLM 没机会纠正)。
 * 这里把每个工具的 execute 包一层 try/catch,错误转成普通工具结果
 * `{ success: false, error }` 返回给 LLM,让它在下一步自我修正(改参数重试等)。
 */
function withToolErrorRecovery(
  tools: Record<string, Tool> | undefined,
): Record<string, Tool> | undefined {
  if (!tools) return undefined;
  const wrapped: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (!execute) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (args, options) => {
        try {
          return await execute(args, options);
        } catch (e) {
          const err = e as { message?: string };
          return { success: false, error: String(err?.message ?? err) };
        }
      },
    } as Tool;
  }
  return wrapped;
}

export async function* streamLlm(input: LlmCallInput): AsyncIterable<LlmStreamEvent> {
  try {
    const result = streamText({
      model: input.model,
      messages: input.messages,
      tools: withToolErrorRecovery(input.tools),
      maxSteps: input.maxSteps ?? 5,
      abortSignal: input.abortSignal,
      providerOptions: input.providerOptions,
    });
    for await (const rawPart of result.fullStream) {
      const part = rawPart as { type: string; [k: string]: unknown };
      if (part.type === "text-delta") {
        yield { type: "text_delta", delta: part.textDelta as string };
      } else if (part.type === "reasoning") {
        yield { type: "reasoning_delta", delta: part.textDelta as string };
      } else if (part.type === "tool-call") {
        yield {
          type: "tool_call_start",
          toolName: part.toolName as string,
          args: part.args,
        };
      } else if (part.type === "tool-result") {
        yield {
          type: "tool_call_end",
          toolName: part.toolName as string,
          result: part.result,
        };
      } else if (part.type === "error") {
        const err = part.error as { message?: string } | string | undefined;
        const message =
          typeof err === "string" ? err : String(err?.message ?? err ?? "unknown error");
        yield { type: "error", errorClass: "unknown", message };
        return;
      }
    }
    const usage = await result.usage;
    // spec §5.6/§5.5:从 providerMetadata 读取 DeepSeek 缓存命中 / reasoning token
    const ds = readDeepSeekUsage(await result.providerMetadata);
    yield {
      type: "usage",
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      cachedTokens: ds.cachedPromptTokens,
      reasoningTokens: ds.reasoningTokens,
    };
    yield { type: "done" };
  } catch (e) {
    const err = e as { message?: string };
    yield {
      type: "error",
      errorClass: "unknown",
      message: String(err?.message ?? err),
    };
  }
}

/**
 * 裸 generateText + 退避重试(429/5xx/网络抖动重试;auth/abort 不重试)。
 * 给那些直接用 generateText、需要结构化解析的调用(如 auditChapter)复用,
 * 让它们也享受统一的瞬时错误退避,而不是各写各的。
 */
export function generateTextWithRetry(
  params: Parameters<typeof generateText>[0],
): ReturnType<typeof generateText> {
  return withRetry(() => generateText(params), { classify: classifyLlmError });
}

export async function generateLlmText(input: Omit<LlmCallInput, "tools" | "maxSteps">): Promise<GeneratedLlmText> {
  // 全程瞬时错误(429 / 5xx / 网络抖动)走退避重试;auth/取消等不重试。
  const result = await withRetry(
    () => generateText({
      model: input.model,
      messages: input.messages,
      abortSignal: input.abortSignal,
      providerOptions: input.providerOptions,
    }),
    { classify: classifyLlmError },
  );
  const ds = readDeepSeekUsage(result.providerMetadata);
  return {
    text: result.text,
    reasoning: result.reasoning,
    usage: {
      promptTokens: result.usage.promptTokens ?? 0,
      completionTokens: result.usage.completionTokens ?? 0,
      cachedTokens: ds.cachedPromptTokens,
      reasoningTokens: ds.reasoningTokens,
    },
  };
}
