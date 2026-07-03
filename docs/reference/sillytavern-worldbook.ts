import type { ImportReport, NewWorldbookEntryInput } from "@scribe/shared";

export interface NormalizedWorldbookImport {
  entries: NewWorldbookEntryInput[];
  report: ImportReport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataFrom(uid: string, rawEntry: Record<string, unknown>) {
  return {
    sillytavern: {
      uid,
      role: typeof rawEntry.role === "string" ? rawEntry.role : null,
      position: typeof rawEntry.position === "number" || typeof rawEntry.position === "string"
        ? rawEntry.position
        : null,
      selective: asBoolean(rawEntry.selective),
      selectiveLogic: nullableNumber(rawEntry.selectiveLogic),
      probability: nullableNumber(rawEntry.probability),
      useProbability: asBoolean(rawEntry.useProbability),
      scanDepth: nullableNumber(rawEntry.scanDepth),
      caseSensitive: typeof rawEntry.caseSensitive === "boolean"
        ? rawEntry.caseSensitive
        : null,
      matchWholeWords: typeof rawEntry.matchWholeWords === "boolean"
        ? rawEntry.matchWholeWords
        : null,
      group: typeof rawEntry.group === "string" ? rawEntry.group : null,
      groupOverride: asBoolean(rawEntry.groupOverride),
      groupWeight: nullableNumber(rawEntry.groupWeight),
      sticky: nullableNumber(rawEntry.sticky),
      cooldown: nullableNumber(rawEntry.cooldown),
      delay: nullableNumber(rawEntry.delay),
      preventRecursion: asBoolean(rawEntry.preventRecursion),
      delayUntilRecursion: asBoolean(rawEntry.delayUntilRecursion),
      excludeRecursion: asBoolean(rawEntry.excludeRecursion),
      ignoreBudget: asBoolean(rawEntry.ignoreBudget),
      useGroupScoring: typeof rawEntry.useGroupScoring === "boolean"
        ? rawEntry.useGroupScoring
        : null,
      characterFilter: rawEntry.characterFilter,
      triggers: Array.isArray(rawEntry.triggers) ? rawEntry.triggers : [],
      rawEntry,
    },
  };
}

export function normalizeSillyTavernWorldbook(
  value: unknown,
): NormalizedWorldbookImport {
  if (!isRecord(value) || !isRecord(value.entries)) {
    throw new Error("SillyTavern worldbook import must contain object-shaped entries");
  }

  const warnings: ImportReport["warnings"] = [];
  const entries: NewWorldbookEntryInput[] = [];
  let enabledCount = 0;
  let constantCount = 0;
  let triggerKeyCount = 0;

  for (const [uid, raw] of Object.entries(value.entries)) {
    if (!isRecord(raw)) continue;
    const content = asString(raw.content).trim();
    const title = asString(raw.comment, asString(raw.name, `Worldbook ${uid}`)).trim();
    if (!title || !content) {
      warnings.push({
        code: "invalid_worldbook_entry",
        message: `Worldbook entry "${uid}" is missing title/comment or content.`,
        path: `entries.${uid}`,
      });
      continue;
    }

    const keys = stringArray(raw.key);
    const secondaryKeys = stringArray(raw.keysecondary);
    const constant = asBoolean(raw.constant);
    const enabled = !asBoolean(raw.disable);
    if (enabled) enabledCount += 1;
    if (constant) constantCount += 1;
    triggerKeyCount += keys.length;

    if (!constant && keys.length === 0 && secondaryKeys.length === 0) {
      warnings.push({
        code: "empty_trigger_keys",
        message: `Triggered worldbook entry "${uid}" has no trigger keys.`,
        path: `entries.${uid}.key`,
      });
    }
    if (content.length > 3000) {
      warnings.push({
        code: "large_worldbook_entry",
        message: `Worldbook entry "${uid}" is very large and may exceed retrieval budget.`,
        path: `entries.${uid}.content`,
      });
    }

    entries.push({
      title,
      content,
      enabled,
      activation: constant ? "constant" : "triggered",
      keys,
      secondaryKeys,
      constant,
      priority: asInt(raw.order, 0),
      insertionDepth: Math.max(0, asInt(raw.depth, 0)),
      recursive: !asBoolean(raw.excludeRecursion) && !asBoolean(raw.preventRecursion),
      recursionLimit: asBoolean(raw.preventRecursion) ? 0 : 1,
      tokenBudget: null,
      category: typeof raw.group === "string" && raw.group.trim() ? raw.group : null,
      metadata: metadataFrom(uid, raw),
    });
  }

  return {
    entries,
    report: {
      warnings,
      stats: {
        entryCount: entries.length,
        enabledCount,
        constantCount,
        triggeredCount: entries.length - constantCount,
        triggerKeyCount,
      },
    },
  };
}
