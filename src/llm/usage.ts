import * as fs from "node:fs";
import * as path from "node:path";
import type { Usage } from "./../types.js";

export interface UsageEntry {
  role: string;
  model: string;
  usage: Usage;
  costUsd: number;
}

export interface RoleSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  byRole: Record<string, RoleSummary>;
  totalCostUsd: number;
}

/** 成本账本:书目录下 usage.jsonl,append-only,一行一次调用。 */
export function recordUsage(bookDir: string, entry: UsageEntry): void {
  const line = JSON.stringify({
    ts: Date.now(),
    role: entry.role,
    model: entry.model,
    promptTokens: entry.usage.promptTokens,
    completionTokens: entry.usage.completionTokens,
    cachedTokens: entry.usage.cachedTokens,
    costUsd: entry.costUsd,
  });
  fs.appendFileSync(path.join(bookDir, "usage.jsonl"), `${line}\n`, "utf8");
}

export function summarizeUsage(bookDir: string): UsageSummary {
  const file = path.join(bookDir, "usage.jsonl");
  const byRole: Record<string, RoleSummary> = {};
  let totalCostUsd = 0;
  if (!fs.existsSync(file)) return { byRole, totalCostUsd };
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // 坏行跳过,账本不因手工损坏而失效
    }
    const role = typeof row["role"] === "string" ? row["role"] : "unknown";
    const bucket = (byRole[role] ??= {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    });
    const num = (key: string) => (typeof row[key] === "number" ? (row[key] as number) : 0);
    bucket.calls += 1;
    bucket.promptTokens += num("promptTokens");
    bucket.completionTokens += num("completionTokens");
    bucket.cachedTokens += num("cachedTokens");
    bucket.costUsd += num("costUsd");
    totalCostUsd += num("costUsd");
  }
  return { byRole, totalCostUsd };
}
