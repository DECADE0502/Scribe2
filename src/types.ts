export type Role = "writer" | "planner" | "extractor" | "auditor" | "embedding";

export interface RoleModel {
  provider: string;
  modelId: string;
}

/** 单价(美元/百万 token)。未配价目的非 DeepSeek provider 记账不可信,会被警告。 */
export interface ProviderPricing {
  prompt: number;
  cachedPrompt: number;
  completion: number;
}

export interface Config {
  providers: Record<string, { baseUrl: string; apiKeyEnv: string; pricing?: ProviderPricing }>;
  roles: Partial<Record<Role, RoleModel | null>>;
  deepestPromptScope: "creative" | "all";
  singleBudgetUsd: number;
  masterPrompt?: string;
}

export interface StreamEvent {
  type: "text_delta";
  delta: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface Chunk {
  id: string;
  type:
    | "character"
    | "character_state"
    | "worldbook"
    | "foreshadow"
    | "timeline"
    | "summary"
    | "record"
    | "issue";
  text: string;
  keys: string[];
  chapterNo?: number;
  embedding?: number[];
  updatedAt: number;
}
