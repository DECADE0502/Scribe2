// SillyTavern 角色卡/世界书导入(解析逻辑移植自旧仓 docs/reference/,输出端改写文件)。
// 预设(preset)与本产品的提示词文件体系不对应,明确报"暂不支持"。
import type { EmbeddingModel } from "ai";
import type { BookStore } from "./../store/book.js";
import { updateChunks } from "./../memory/index.js";

export type StJsonType = "character" | "worldbook" | "preset" | "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function detectStJson(value: unknown): StJsonType {
  if (!isRecord(value)) return "unknown";
  // 角色卡 v2/v3:spec 标记;v1:顶层 name + description/personality
  const spec = asString(value["spec"]);
  if (spec.startsWith("chara_card")) return "character";
  if (
    typeof value["name"] === "string" &&
    ("description" in value || "personality" in value || "first_mes" in value)
  ) {
    return "character";
  }
  if (Array.isArray(value["prompts"]) && Array.isArray(value["prompt_order"])) return "preset";
  if (isRecord(value["entries"])) {
    const first = Object.values(value["entries"]).find(isRecord);
    if (first && ("content" in first || "comment" in first || "key" in first)) return "worldbook";
  }
  return "unknown";
}

export interface ImportReport {
  type: StJsonType;
  imported: { characters: number; worldbooks: number };
  warnings: string[];
}

function importCharacter(store: BookStore, json: Record<string, unknown>, report: ImportReport): string[] {
  const data = isRecord(json["data"]) ? json["data"] : json; // v2 在 data 下,v1 平铺
  const name = asString(data["name"]).trim();
  if (!name) {
    throw new Error("角色卡缺少 name 字段(invalid_character_card)");
  }
  const base = [asString(data["description"]).trim(), asString(data["personality"]).trim()]
    .filter(Boolean)
    .join("\n");
  if (store.listCharacters().some((c) => c.name === name)) {
    report.warnings.push(`角色「${name}」已存在,跳过不覆盖`);
    return [];
  }
  store.upsertCharacter({ name, role: "配角", base, state: "" });
  report.imported.characters += 1;
  return [`character:${name}`, `character_state:${name}`];
}

function importWorldbook(store: BookStore, json: Record<string, unknown>, report: ImportReport): string[] {
  const entries = json["entries"] as Record<string, unknown>;
  const existing = new Set(store.listWorldbooks().map((w) => w.title));
  const changed: string[] = [];
  for (const [uid, raw] of Object.entries(entries)) {
    if (!isRecord(raw)) continue;
    const title = (asString(raw["comment"]) || asString(raw["name"]) || `条目${uid}`).trim();
    const content = asString(raw["content"]).trim();
    if (raw["disable"] === true) {
      report.warnings.push(`条目「${title}」在源文件中已停用,跳过`);
      continue;
    }
    if (!content) {
      report.warnings.push(`条目「${title}」没有正文,跳过`);
      continue;
    }
    if (existing.has(title)) {
      report.warnings.push(`世界书「${title}」已存在,跳过不覆盖`);
      continue;
    }
    const keys = [...stringArray(raw["key"]), ...stringArray(raw["keysecondary"])];
    const constant = raw["constant"] === true;
    if (!constant && keys.length === 0) {
      report.warnings.push(`触发型条目「${title}」没有触发词,只能靠语义检索命中`);
    }
    store.upsertWorldbook({ title, keys: keys.length ? keys : [title], constant, body: content });
    existing.add(title);
    report.imported.worldbooks += 1;
    changed.push(`worldbook:${title}`);
  }
  return changed;
}

/** 导入 SillyTavern JSON:检测 → 写文件(同名跳过)→ 索引增量。未知形状先报错,不落任何盘。 */
export async function importSillyTavern(
  store: BookStore,
  embedder: EmbeddingModel<string> | null,
  json: unknown,
): Promise<ImportReport> {
  const type = detectStJson(json);
  if (type === "unknown") {
    throw new Error("无法识别的 JSON:既不是 SillyTavern 角色卡也不是世界书(unknown_import_json)");
  }
  if (type === "preset") {
    throw new Error(
      "这是 SillyTavern 预设(preset);本引擎的提示词是 prompts/ 下的 md 文件,请手工改写,暂不支持自动导入(unsupported_import)",
    );
  }
  const report: ImportReport = { type, imported: { characters: 0, worldbooks: 0 }, warnings: [] };
  const changed =
    type === "character"
      ? importCharacter(store, json as Record<string, unknown>, report)
      : importWorldbook(store, json as Record<string, unknown>, report);
  if (changed.length) await updateChunks(store, embedder, changed);
  return report;
}
