import type { ImportReport, PromptBlock } from "@scribe/shared";

type NormalizedPromptBlock = Omit<
  PromptBlock,
  "id" | "presetId" | "createdAt" | "updatedAt"
>;

export interface NormalizedPresetImport {
  preset: {
    name: string;
    enabled: boolean;
    sourceImportId: string | null;
    generationSettings: Record<string, unknown>;
    extensions: Record<string, unknown>;
    regexScriptsEnabled: boolean;
  };
  blocks: NormalizedPromptBlock[];
  report: ImportReport;
}

interface OrderedPrompt {
  identifier?: unknown;
  enabled?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNullableInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function promptRole(value: unknown): "system" | "user" | "assistant" {
  return value === "user" || value === "assistant" || value === "system"
    ? value
    : "system";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function filenameToName(filename: string): string {
  return filename.replace(/\.json$/i, "") || "Imported SillyTavern Preset";
}

function generationSettingsOf(raw: Record<string, unknown>): Record<string, unknown> {
  const omitted = new Set(["prompts", "prompt_order", "extensions"]);
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (omitted.has(key)) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      settings[key] = value;
    }
  }
  return settings;
}

function makeBlock(
  prompt: Record<string, unknown>,
  order: { enabled: boolean | null; stackIndex: number | null },
  warnings: ImportReport["warnings"],
): NormalizedPromptBlock {
  const sourceIdentifier = asString(prompt.identifier, `prompt-${order.stackIndex ?? "unreferenced"}`);
  const sourcePromptEnabled = typeof prompt.enabled === "boolean" ? prompt.enabled : null;
  const enabled = order.enabled ?? false;
  if (
    sourcePromptEnabled !== null &&
    order.enabled !== null &&
    sourcePromptEnabled !== order.enabled
  ) {
    warnings.push({
      code: "prompt_enabled_mismatch",
      message: `Prompt "${sourceIdentifier}" has enabled=${sourcePromptEnabled} but prompt_order enabled=${order.enabled}.`,
      path: `prompts.${sourceIdentifier}.enabled`,
    });
  }
  const content = asString(prompt.content);
  if (enabled && !content.trim()) {
    warnings.push({
      code: "empty_prompt_content",
      message: `Enabled prompt "${sourceIdentifier}" has empty content.`,
      path: `prompts.${sourceIdentifier}.content`,
    });
  }

  return {
    sourceIdentifier,
    name: asString(prompt.name, sourceIdentifier),
    role: promptRole(prompt.role),
    content,
    enabled,
    stackIndex: order.stackIndex,
    injectionPosition: asNullableInt(prompt.injection_position),
    injectionDepth: asNullableInt(prompt.injection_depth),
    injectionOrder: asNullableInt(prompt.injection_order),
    systemPrompt: asBoolean(prompt.system_prompt),
    marker: asBoolean(prompt.marker),
    forbidOverrides: asBoolean(prompt.forbid_overrides),
    injectionTrigger: stringArray(prompt.injection_trigger),
    sourcePromptEnabled,
    sourceOrderEnabled: order.enabled,
    metadata: { sillytavern: { rawPrompt: prompt } },
  };
}

export function normalizeSillyTavernPreset(
  value: unknown,
  filename: string,
): NormalizedPresetImport {
  if (!isRecord(value)) {
    throw new Error("SillyTavern preset import must be a JSON object");
  }
  const rawPrompts = Array.isArray(value.prompts) ? value.prompts.filter(isRecord) : [];
  const promptMap = new Map<string, Record<string, unknown>>();
  for (const prompt of rawPrompts) {
    const identifier = asString(prompt.identifier);
    if (identifier) promptMap.set(identifier, prompt);
  }

  const orderGroup = Array.isArray(value.prompt_order)
    ? value.prompt_order.find((item) => isRecord(item) && Array.isArray(item.order))
    : undefined;
  const ordered = isRecord(orderGroup) && Array.isArray(orderGroup.order)
    ? (orderGroup.order as OrderedPrompt[])
    : [];
  const warnings: ImportReport["warnings"] = [];
  const blocks: NormalizedPromptBlock[] = [];
  const seen = new Set<string>();

  ordered.forEach((item, stackIndex) => {
    const identifier = asString(item.identifier);
    if (!identifier) {
      warnings.push({
        code: "missing_order_identifier",
        message: `Prompt order item at index ${stackIndex} is missing an identifier.`,
        path: `prompt_order.0.order.${stackIndex}`,
      });
      return;
    }
    const prompt = promptMap.get(identifier);
    if (!prompt) {
      warnings.push({
        code: "missing_order_prompt",
        message: `Prompt order references missing prompt "${identifier}".`,
        path: `prompt_order.0.order.${stackIndex}`,
      });
      return;
    }
    seen.add(identifier);
    blocks.push(makeBlock(prompt, {
      enabled: asBoolean(item.enabled),
      stackIndex,
    }, warnings));
  });

  for (const prompt of rawPrompts) {
    const identifier = asString(prompt.identifier);
    if (!identifier || seen.has(identifier)) continue;
    blocks.push(makeBlock(prompt, {
      enabled: false,
      stackIndex: null,
    }, warnings));
  }

  const activeBlocks = blocks.filter((block) => block.enabled && block.stackIndex !== null);
  const roleCounts = activeBlocks.reduce<Record<string, number>>((acc, block) => {
    acc[block.role] = (acc[block.role] ?? 0) + 1;
    return acc;
  }, {});

  const extensions = isRecord(value.extensions) ? value.extensions : {};
  const regexScriptCount = Array.isArray(extensions.regex_scripts)
    ? extensions.regex_scripts.length
    : 0;
  return {
    preset: {
      name: filenameToName(filename),
      enabled: true,
      sourceImportId: null,
      generationSettings: generationSettingsOf(value),
      extensions,
      regexScriptsEnabled: regexScriptCount > 0,
    },
    blocks,
    report: {
      warnings,
      stats: {
        promptCount: rawPrompts.length,
        orderedPromptCount: ordered.length,
        activePromptCount: activeBlocks.length,
        roleCounts,
        regexScriptCount,
      },
    },
  };
}
