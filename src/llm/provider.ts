import {
  createOpenAICompatible,
  OpenAICompatibleChatLanguageModel,
} from "@ai-sdk/openai-compatible";
import type { EmbeddingModel, LanguageModel } from "ai";
import { resolveRole, type LoadedConfig } from "./../config.js";
import type { Role } from "./../types.js";
import { deepseekMetadataExtractor } from "./deepseek-metadata.js";

function providerOf(loaded: LoadedConfig, providerName: string, role: Role) {
  const provider = loaded.config.providers[providerName];
  if (!provider) {
    throw new Error(`角色 ${role} 引用了未知 provider「${providerName}」(unknown_provider)`);
  }
  return provider;
}

/** 聊天角色 → LanguageModel。直接构造 chat model 以挂 metadataExtractor(读 DeepSeek 缓存字段)。 */
export function modelFor(loaded: LoadedConfig, role: Exclude<Role, "embedding">): LanguageModel {
  const roleModel = resolveRole(loaded.config, role);
  if (!roleModel) {
    throw new Error(`角色 ${role} 未配置模型(role_not_configured)`);
  }
  const provider = providerOf(loaded, roleModel.provider, role);
  const apiKey = loaded.apiKeyFor(roleModel.provider);
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  return new OpenAICompatibleChatLanguageModel(
    roleModel.modelId,
    {},
    {
      provider: `${roleModel.provider}.chat`,
      url: ({ path }) => `${baseUrl}${path}`,
      headers: () => ({ Authorization: `Bearer ${apiKey}` }),
      metadataExtractor: deepseekMetadataExtractor,
      defaultObjectGenerationMode: "json",
      // 严格 OpenAI 兼容的 provider 流式默认不带 usage(SDK 会给 NaN),显式要求带上
      includeUsage: true,
    },
  );
}

/** embedding 角色未配置 → null(优雅降级为关键词+时近检索,SPEC §2.3)。 */
export function embeddingModelFor(loaded: LoadedConfig): EmbeddingModel<string> | null {
  const roleModel = resolveRole(loaded.config, "embedding");
  if (!roleModel) return null;
  const provider = providerOf(loaded, roleModel.provider, "embedding");
  const compat = createOpenAICompatible({
    name: roleModel.provider,
    baseURL: provider.baseUrl,
    apiKey: loaded.apiKeyFor(roleModel.provider),
  });
  return compat.textEmbeddingModel(roleModel.modelId);
}
