import type { ImportSourceType } from "@scribe/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function detectSillyTavernJson(value: unknown): ImportSourceType {
  if (!isRecord(value)) return "unknown_json";
  if (Array.isArray(value.prompts) && Array.isArray(value.prompt_order)) {
    return "sillytavern_preset";
  }
  if (isRecord(value.entries)) {
    const first = Object.values(value.entries).find(isRecord);
    if (first && ("content" in first || "comment" in first || "key" in first)) {
      return "sillytavern_worldbook";
    }
  }
  return "unknown_json";
}
