// 生产 deps 装配:config → 各角色模型 → usage 记账。CLI 与 server 共用。
import type { LoadedConfig } from "./config.js";
import { resolveRole } from "./config.js";
import { modelFor, embeddingModelFor } from "./llm/provider.js";
import { streamCall, generateCall } from "./llm/call.js";
import { recordUsage, type UsageSummary } from "./llm/usage.js";
import { retrieve } from "./memory/retrieve.js";
import type { BookStore } from "./store/book.js";
import type { WriteDeps, GenerateRole, StreamRole } from "./engine/write.js";
import type { Config, ProviderPricing, Usage } from "./types.js";

export type AppDeps = WriteDeps & { chatter: StreamRole; auditor: GenerateRole };

/** DeepSeek 价目(美元/百万 token)。 */
const DEEPSEEK_PRICE: ProviderPricing = { prompt: 0.28, cachedPrompt: 0.028, completion: 0.42 };

export function costOf(usage: Usage, pricing: ProviderPricing = DEEPSEEK_PRICE): number {
  const miss = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (
    (miss * pricing.prompt +
      usage.cachedTokens * pricing.cachedPrompt +
      usage.completionTokens * pricing.completion) / 1_000_000
  );
}

const warnedProviders = new Set<string>();

/** provider 的价目:配了用配的;没配但像 DeepSeek 就用默认价;否则警告一次后按默认价记(账不可信)。 */
export function pricingFor(
  providers: Config["providers"],
  providerName: string,
): ProviderPricing {
  const provider = providers[providerName];
  if (provider?.pricing) return provider.pricing;
  const looksDeepSeek = (provider?.baseUrl ?? "").includes("deepseek");
  if (!looksDeepSeek && !warnedProviders.has(providerName)) {
    warnedProviders.add(providerName);
    console.warn(
      `provider「${providerName}」未配置 pricing,按 DeepSeek 价目估算——成本账本与预算护栏不可信,建议在 config.json 补 pricing(pricing_missing)`,
    );
  }
  return DEEPSEEK_PRICE;
}

/** 参与写章管线的角色;chat/onboard 的对话成本不摊进章均估算。 */
export const WRITING_ROLES = ["writer", "planner", "extractor", "auditor"] as const;

/** 单次 run 成本估算(SPEC §5):写作角色的历史均摊 × 章数。无历史返回 0(放行)。 */
export function estimateWriteCost(
  summary: UsageSummary,
  writtenChapters: number,
  chapterCount: number,
): number {
  if (writtenChapters <= 0) return 0;
  const writingCost = WRITING_ROLES.reduce((sum, role) => sum + (summary.byRole[role]?.costUsd ?? 0), 0);
  return (writingCost / writtenChapters) * chapterCount;
}

export function buildDeps(store: BookStore, loaded: LoadedConfig): AppDeps {
  const writerModel = modelFor(loaded, "writer");
  const plannerModel = modelFor(loaded, "planner");
  const extractorModel = modelFor(loaded, "extractor");
  const auditorModel = modelFor(loaded, "auditor");
  const modelByRole: Record<string, string> = {
    writer: writerModel.modelId,
    planner: plannerModel.modelId,
    extractor: extractorModel.modelId,
    auditor: auditorModel.modelId,
  };
  // chat/onboard 复用 writer 模型,但记账角色独立(它们的成本不属于"章均")
  const pricingByRole: Record<string, ProviderPricing> = {};
  for (const role of ["writer", "planner", "extractor", "auditor"] as const) {
    const roleModel = resolveRole(loaded.config, role);
    if (roleModel) pricingByRole[role] = pricingFor(loaded.config.providers, roleModel.provider);
  }
  const writerPricing = pricingByRole["writer"];

  return {
    planner: (input) => generateCall({ model: plannerModel, messages: input.messages, ...(input.onUsage ? { onUsage: input.onUsage } : {}) }),
    writer: (input) => streamCall({ model: writerModel, messages: input.messages, ...(input.onUsage ? { onUsage: input.onUsage } : {}) }),
    extractor: (input) => generateCall({ model: extractorModel, messages: input.messages, ...(input.onUsage ? { onUsage: input.onUsage } : {}) }),
    chatter: (input) => streamCall({ model: writerModel, messages: input.messages, ...(input.onUsage ? { onUsage: input.onUsage } : {}) }),
    auditor: (input) => generateCall({ model: auditorModel, messages: input.messages, ...(input.onUsage ? { onUsage: input.onUsage } : {}) }),
    retrieve,
    embedder: embeddingModelFor(loaded),
    config: loaded.config,
    onUsage: (role, usage) => {
      recordUsage(store.dir, {
        role,
        model: modelByRole[role] ?? writerModel.modelId,
        usage,
        costUsd: costOf(usage, pricingByRole[role] ?? writerPricing),
      });
    },
  };
}
