import { z } from "zod";
import type { EmbeddingModel } from "ai";
import type { Config, Usage } from "./../types.js";
import type { BookStore, Issue } from "./../store/book.js";
import { commitAll } from "./../store/git.js";
import { loadIndex, updateChunks } from "./../memory/index.js";
import type { retrieve as retrieveFn } from "./../memory/retrieve.js";
import { loadPrompt, renderTemplate } from "./../template.js";
import { deepestPromptFor } from "./context.js";
import { entitiesFromText } from "./chat.js";
import { generateStructured } from "./../llm/json.js";
import type { GenerateRole } from "./write.js";

const auditSchema = z.object({
  issues: z
    .array(
      z.object({
        type: z
          .enum(["continuity", "character", "foreshadow", "setting", "perspective", "pacing"])
          .catch("continuity"),
        severity: z.enum(["warning", "critical"]).catch("warning"),
        chapterNo: z.number().default(1),
        note: z.string(),
        suggestedFix: z.string().optional(),
      }),
    )
    .default([]),
  summary: z.string().default(""),
});
export type AuditFinding = z.infer<typeof auditSchema>["issues"][number];

export interface AuditDeps {
  auditor: GenerateRole;
  retrieve: typeof retrieveFn;
  embedder: EmbeddingModel<string> | null;
  config: Config;
  onUsage?: (role: string, usage: Usage) => void;
}

export interface AuditCollectResult {
  issues: AuditFinding[];
  summary: string;
}

/** 只跑审查 LLM 并解析,不写盘——连写护栏(§3.3)需要先裁决再决定落盘还是 reset。 */
export async function collectAuditIssues(
  store: BookStore,
  lastN: number,
  deps: AuditDeps,
): Promise<AuditCollectResult> {
  const chapters = store.listChapters();
  const range = chapters.slice(-lastN);
  if (range.length === 0) return { issues: [], summary: "本书还没有章节,无可审查" };
  const from = range[0]!;
  const to = range.at(-1)!;
  const latest = chapters.at(-1)!;

  const proseParts = range.map((n) => {
    const c = store.readChapter(n);
    return `## 第${n}章 ${c.title}\n${c.text}`;
  });
  const prose = proseParts.join("\n\n");

  const index = loadIndex(store);
  const scored = await deps.retrieve({
    index,
    query: { text: prose.slice(0, 2000), entities: entitiesFromText(index, prose) },
    currentChapter: latest,
    embedder: deps.embedder,
  });

  const prompt = renderTemplate(loadPrompt("audit", store.dir), {
    审查范围: `近 ${range.length} 章(第${from}-${to}章)`,
    资料: scored.length
      ? scored.map((s) => `- [${s.chunk.type}] ${s.chunk.text.replace(/\n+/g, " ")}`).join("\n")
      : "(无检索资料)",
    近章正文: prose,
  });

  const meta = store.readMeta();
  const envelope = deepestPromptFor("structured", deps.config, meta);
  const parsed = await generateStructured({
    schema: auditSchema,
    messages: [...envelope.prefix, { role: "user", content: prompt }, ...envelope.suffix],
    generate: (input) =>
      deps.auditor({ messages: input.messages, onUsage: (u) => deps.onUsage?.("auditor", u) }),
  });

  // 章号 clamp 到 [1, 最新章]
  const issues = parsed.issues.map((i) => ({
    ...i,
    chapterNo: Math.min(Math.max(1, Math.round(i.chapterNo)), latest),
  }));
  return { issues, summary: parsed.summary };
}

export function issueInputOf(finding: AuditFinding): { type: string; chapterNo: number; note: string } {
  return {
    type: finding.type,
    chapterNo: finding.chapterNo,
    note: finding.note + (finding.suggestedFix ? ` 建议:${finding.suggestedFix}` : ""),
  };
}

export function renderIssueLine(finding: AuditFinding): string {
  const severity = finding.severity === "critical" ? "严重(critical)" : "提醒(warning)";
  return `- [${severity}] 第${finding.chapterNo}章 ${finding.type}:${finding.note}${finding.suggestedFix ? `(建议:${finding.suggestedFix})` : ""}`;
}

export interface AuditReport {
  issues: AuditFinding[];
  added: Issue[];
  summary: string;
  lines: string[];
}

/** 审查(SPEC §3.5):collect → 问题.md(open,稳定 id dedup)→ 索引 → commit → 逐条报告。 */
export async function runAudit(
  store: BookStore,
  options: { lastN?: number },
  deps: AuditDeps,
): Promise<AuditReport> {
  const { issues, summary } = await collectAuditIssues(store, options.lastN ?? 5, deps);
  const added = store.addIssues(issues.map(issueInputOf));
  if (added.length) {
    await updateChunks(store, deps.embedder, added.map((i) => `issue:${i.id}`));
  }
  commitAll(store.dir, `audit: ${issues.length} 条问题(新增 ${added.length})`);
  return { issues, added, summary, lines: issues.map(renderIssueLine) };
}
