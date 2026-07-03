export type Role = "writer" | "planner" | "extractor" | "auditor" | "embedding";

export interface RoleModel {
  provider: string;
  modelId: string;
}

export interface Config {
  providers: Record<string, { baseUrl: string; apiKeyEnv: string }>;
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
