import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import type { Config, Role, RoleModel } from "./types.js";

const roleModelSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});

const configSchema = z.object({
  providers: z.record(
    z.object({ baseUrl: z.string().min(1), apiKeyEnv: z.string().min(1) }),
  ),
  roles: z.object({
    writer: roleModelSchema.nullable().optional(),
    planner: roleModelSchema.nullable().optional(),
    extractor: roleModelSchema.nullable().optional(),
    auditor: roleModelSchema.nullable().optional(),
    embedding: roleModelSchema.nullable().optional(),
  }),
  deepestPromptScope: z.enum(["creative", "all"]),
  singleBudgetUsd: z.number().positive(),
  masterPrompt: z.string().optional(),
});

// 回退链(SPEC §5):planner/auditor → extractor → writer;writer 是根,embedding 独立无回退。
const FALLBACK: Record<Role, Role[]> = {
  writer: ["writer"],
  planner: ["planner", "extractor", "writer"],
  extractor: ["extractor", "writer"],
  auditor: ["auditor", "extractor", "writer"],
  embedding: ["embedding"],
};

export function resolveRole(config: Config, role: Role): RoleModel | null {
  for (const candidate of FALLBACK[role]) {
    const model = config.roles[candidate];
    if (model) return model;
  }
  if (role === "embedding") return null;
  throw new Error(`角色 ${role} 未配置模型且回退链已到尽头(role_not_configured)`);
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

export interface LoadedConfig {
  config: Config;
  secrets: Record<string, string>;
  apiKeyFor(providerName: string): string;
}

export function loadConfigFrom(dir: string): LoadedConfig {
  const configPath = path.join(dir, "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `读取 ${configPath} 失败:${err instanceof Error ? err.message : String(err)}(config_unreadable)`,
    );
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<根>"}: ${i.message}`)
      .join(";");
    throw new Error(`config.json 形状不合法:${detail}(config_invalid)`);
  }
  const config: Config = parsed.data;

  const secretsPath = path.join(dir, "secrets.env");
  const secrets = fs.existsSync(secretsPath)
    ? parseEnvFile(fs.readFileSync(secretsPath, "utf8"))
    : {};

  const keyOf = (envName: string): string | undefined =>
    secrets[envName] ?? process.env[envName];

  for (const [name, provider] of Object.entries(config.providers)) {
    if (!keyOf(provider.apiKeyEnv)) {
      throw new Error(
        `provider「${name}」缺少密钥 ${provider.apiKeyEnv},请写入 secrets.env(missing_api_key)`,
      );
    }
  }

  return {
    config,
    secrets,
    apiKeyFor(providerName: string): string {
      const provider = config.providers[providerName];
      if (!provider) {
        throw new Error(`未知 provider「${providerName}」(unknown_provider)`);
      }
      const key = keyOf(provider.apiKeyEnv);
      if (!key) {
        throw new Error(
          `provider「${providerName}」缺少密钥 ${provider.apiKeyEnv}(missing_api_key)`,
        );
      }
      return key;
    },
  };
}
