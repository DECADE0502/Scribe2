// DeepSeek 用量元数据抽取(移植自旧仓,SPEC §5):
// @ai-sdk/openai-compatible 默认丢弃 DeepSeek 特有的 prompt_cache_hit_tokens /
// completion_tokens_details.reasoning_tokens,这里用 MetadataExtractor 捞回来,
// 挂到 providerMetadata.deepseek 下供 call.ts 计入用量。
import type { MetadataExtractor } from "@ai-sdk/openai-compatible";

interface DeepSeekWireUsage {
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export type DeepSeekUsageMetadata = {
  cachedPromptTokens: number;
  reasoningTokens: number;
};

function pickUsage(body: unknown): DeepSeekWireUsage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  return usage as DeepSeekWireUsage;
}

function toMetadata(
  usage: DeepSeekWireUsage | undefined,
): { deepseek: DeepSeekUsageMetadata } | undefined {
  if (!usage) return undefined;
  // 兼容 DeepSeek 的 prompt_cache_hit_tokens 与 OpenAI 标准的 prompt_tokens_details.cached_tokens
  const cachedPromptTokens =
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  if (cachedPromptTokens === 0 && reasoningTokens === 0) return undefined;
  return { deepseek: { cachedPromptTokens, reasoningTokens } };
}

export function readDeepSeekUsage(providerMetadata: unknown): DeepSeekUsageMetadata {
  const ds = (providerMetadata as { deepseek?: Partial<DeepSeekUsageMetadata> } | undefined)
    ?.deepseek;
  return {
    cachedPromptTokens: ds?.cachedPromptTokens ?? 0,
    reasoningTokens: ds?.reasoningTokens ?? 0,
  };
}

export const deepseekMetadataExtractor: MetadataExtractor = {
  extractMetadata({ parsedBody }) {
    return toMetadata(pickUsage(parsedBody));
  },
  createStreamExtractor() {
    let last: DeepSeekWireUsage | undefined;
    return {
      processChunk(chunk: unknown) {
        const usage = pickUsage(chunk);
        if (usage) last = usage; // 末尾块携带最终 usage
      },
      buildMetadata() {
        return toMetadata(last);
      },
    };
  },
};
