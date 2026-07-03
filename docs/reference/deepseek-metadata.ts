/**
 * DeepSeek 用量元数据抽取(spec §5.6 prompt cache / §5.5 reasoning)。
 *
 * @ai-sdk/openai-compatible 默认只读 prompt_tokens / completion_tokens,
 * 丢弃了 DeepSeek 特有的:
 *   - usage.prompt_cache_hit_tokens   命中缓存的 prompt token(更便宜)
 *   - usage.completion_tokens_details.reasoning_tokens  推理 token(⊂ completion)
 * 这里实现 MetadataExtractor,把它们提取到 providerMetadata.deepseek 下,
 * 供 llm-call / audit-chapter 计入用量与成本。
 */

interface DeepSeekUsage {
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface DeepSeekUsageMetadata {
  cachedPromptTokens: number;
  reasoningTokens: number;
}

function pickUsage(body: unknown): DeepSeekUsage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  return usage as DeepSeekUsage;
}

function toMetadata(usage: DeepSeekUsage | undefined): { deepseek: DeepSeekUsageMetadata } | undefined {
  if (!usage) return undefined;
  // 兼容两种缓存命中字段:DeepSeek 的 prompt_cache_hit_tokens 与
  // OpenAI/MiMo 标准的 prompt_tokens_details.cached_tokens。
  const cachedPromptTokens =
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  if (cachedPromptTokens === 0 && reasoningTokens === 0) return undefined;
  return { deepseek: { cachedPromptTokens, reasoningTokens } };
}

/** 从 providerMetadata 安全读取 DeepSeek 用量(供消费方调用)。 */
export function readDeepSeekUsage(
  providerMetadata: unknown,
): DeepSeekUsageMetadata {
  const ds = (providerMetadata as { deepseek?: Partial<DeepSeekUsageMetadata> } | undefined)?.deepseek;
  return {
    cachedPromptTokens: ds?.cachedPromptTokens ?? 0,
    reasoningTokens: ds?.reasoningTokens ?? 0,
  };
}

// 形状与 @ai-sdk/openai-compatible 的 MetadataExtractor 一致(structural typing)。
export const deepseekMetadataExtractor = {
  extractMetadata({ parsedBody }: { parsedBody: unknown }) {
    return toMetadata(pickUsage(parsedBody));
  },
  createStreamExtractor() {
    let last: DeepSeekUsage | undefined;
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
