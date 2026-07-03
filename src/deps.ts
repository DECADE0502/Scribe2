// 生产 deps 装配:config → 各角色模型 → usage 记账。CLI 与 server 共用。
import type { LoadedConfig } from "./config.js";
import { modelFor, embeddingModelFor } from "./llm/provider.js";
import { streamCall, generateCall } from "./llm/call.js";
import { recordUsage } from "./llm/usage.js";
import { retrieve } from "./memory/retrieve.js";
import type { BookStore } from "./store/book.js";
import type { WriteDeps, GenerateRole, StreamRole } from "./engine/write.js";
import type { Usage } from "./types.js";

export type AppDeps = WriteDeps & { chatter: StreamRole; auditor: GenerateRole };

/** DeepSeek 系价目(美元/百万 token)估算;未知模型按同价记,账本只求量级正确。 */
const PRICE = { promptMiss: 0.28, promptCacheHit: 0.028, completion: 0.42 };

export function costOf(usage: Usage): number {
  const miss = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (
    (miss * PRICE.promptMiss +
      usage.cachedTokens * PRICE.promptCacheHit +
      usage.completionTokens * PRICE.completion) / 1_000_000
  );
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
        costUsd: costOf(usage),
      });
    },
  };
}
