import { createHash } from "node:crypto";
import type {
  ImportArtifact,
  ImportReport,
  ImportSourceType,
} from "@scribe/shared";
import type { BookHandle } from "../../http/book-registry.js";
import { detectSillyTavernJson } from "./sillytavern-detect.js";
import { normalizeSillyTavernPreset } from "./sillytavern-preset.js";
import { normalizeSillyTavernWorldbook } from "./sillytavern-worldbook.js";

export interface ImportJsonInput {
  filename: string;
  json: unknown;
}

export interface ImportPreview {
  sourceType: ImportSourceType;
  sourceName: string;
  stats: Record<string, unknown>;
  warnings: ImportReport["warnings"];
}

export interface ImportResult {
  artifact: ImportArtifact;
  sourceType: ImportSourceType;
  imported: {
    promptPresets: number;
    promptBlocks: number;
    worldbookEntries: number;
  };
}

/** 导入体量上限,防止超大 JSON 拖垮服务/库 */
export const MAX_IMPORT_BYTES = 8_000_000; // 8MB(内置样例最大 ~456KB,留足余量)
export const MAX_IMPORT_ENTRIES = 5000;    // prompt blocks / worldbook entries 单次上限

/** 体量超限错误,路由据此返回 413 */
export class ImportTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportTooLargeError";
  }
}

function sourceName(filename: string): string {
  return filename.replace(/\.json$/i, "") || "Imported JSON";
}

function hashJson(rawJson: string): string {
  return createHash("sha256").update(rawJson).digest("hex");
}

function normalizedReport(input: ImportJsonInput): {
  sourceType: ImportSourceType;
  report: ImportReport;
} {
  const sourceType = detectSillyTavernJson(input.json);
  if (sourceType === "sillytavern_preset") {
    return {
      sourceType,
      report: normalizeSillyTavernPreset(input.json, input.filename).report,
    };
  }
  if (sourceType === "sillytavern_worldbook") {
    return {
      sourceType,
      report: normalizeSillyTavernWorldbook(input.json).report,
    };
  }
  return {
    sourceType,
    report: {
      warnings: [{
        code: "unknown_import_json",
        message: "JSON shape is not a recognized SillyTavern preset or worldbook.",
      }],
      stats: {},
    },
  };
}

export function previewSillyTavernImport(input: ImportJsonInput): ImportPreview {
  const { sourceType, report } = normalizedReport(input);
  return {
    sourceType,
    sourceName: sourceName(input.filename),
    stats: report.stats,
    warnings: report.warnings,
  };
}

export function importSillyTavernJson(
  handle: BookHandle,
  input: ImportJsonInput,
): ImportResult {
  const rawJson = JSON.stringify(input.json);
  if (rawJson.length > MAX_IMPORT_BYTES) {
    throw new ImportTooLargeError(`导入 JSON 过大:${rawJson.length} 字节,上限 ${MAX_IMPORT_BYTES}`);
  }
  const { sourceType, report } = normalizedReport(input);

  // 先归一化并做条数上限检查,再开事务写库(避免半导入)
  const preset = sourceType === "sillytavern_preset"
    ? normalizeSillyTavernPreset(input.json, input.filename)
    : null;
  const worldbook = sourceType === "sillytavern_worldbook"
    ? normalizeSillyTavernWorldbook(input.json)
    : null;
  if (preset && preset.blocks.length > MAX_IMPORT_ENTRIES) {
    throw new ImportTooLargeError(`预设条目过多:${preset.blocks.length},上限 ${MAX_IMPORT_ENTRIES}`);
  }
  if (worldbook && worldbook.entries.length > MAX_IMPORT_ENTRIES) {
    throw new ImportTooLargeError(`世界书条目过多:${worldbook.entries.length},上限 ${MAX_IMPORT_ENTRIES}`);
  }

  // 事务:artifact + preset/blocks + worldbook entries 要么全成、要么全回滚,不留半导入
  const run = handle.workspaceDb.transaction((): ImportResult => {
    const artifact = handle.importArtifactsRepo.create({
      sourceType,
      sourceName: sourceName(input.filename),
      sourceFilename: input.filename,
      rawJson,
      rawHash: hashJson(rawJson),
      importReport: report,
    });
    const imported = { promptPresets: 0, promptBlocks: 0, worldbookEntries: 0 };

    if (preset) {
      const created = handle.promptPresetsRepo.createPreset({
        ...preset.preset,
        sourceImportId: artifact.id,
      });
      imported.promptPresets = 1;
      for (const block of preset.blocks) {
        handle.promptPresetsRepo.createBlock({ ...block, presetId: created.id });
        imported.promptBlocks += 1;
      }
    }

    if (worldbook) {
      for (const entry of worldbook.entries) {
        handle.worldbookRepo.create({
          ...entry,
          metadata: { ...(entry.metadata ?? {}), sourceImportId: artifact.id },
        });
        imported.worldbookEntries += 1;
      }
    }

    return { artifact, sourceType, imported };
  });

  return run();
}
