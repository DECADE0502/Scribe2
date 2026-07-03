import { z } from "zod";
import type { EmbeddingModel } from "ai";
import type { Config, Usage } from "./../types.js";
import type { BookStore } from "./../store/book.js";
import { commitAll, log } from "./../store/git.js";
import { updateChunks } from "./../memory/index.js";
import { loadPrompt, renderTemplate } from "./../template.js";
import { deepestPromptFor } from "./context.js";
import { generateStructured } from "./../llm/json.js";
import type { GenerateRole, StreamRole } from "./write.js";

const onboardExtractSchema = z.object({
  book: z
    .object({
      title: z.string().default(""),
      genre: z.string().default(""),
      premise: z.string().default(""),
      pov: z.string().default(""),
      targetChapters: z.number().default(0),
    })
    .default({ title: "", genre: "", premise: "", pov: "", targetChapters: 0 }),
  setting: z.string().default(""),
  recordRules: z.array(z.string()).default([]),
  characters: z
    .array(
      z.object({
        name: z.string(),
        role: z.string().default("supporting"),
        profile: z.string().default(""),
      }),
    )
    .default([]),
  worldbook: z
    .array(
      z.object({
        title: z.string(),
        keys: z.array(z.string()).default([]),
        content: z.string().default(""),
      }),
    )
    .default([]),
  outline: z
    .array(
      z.object({
        level: z.string().default("arc"),
        title: z.string(),
        summary: z.string().default(""),
      }),
    )
    .default([]),
});
export type OnboardExtract = z.infer<typeof onboardExtractSchema>;

const ROLE_MAP: Record<string, string> = {
  protagonist: "主角",
  antagonist: "反派",
  supporting: "配角",
};

export interface OnboardDeps {
  chatter: StreamRole;
  extractor: GenerateRole;
  embedder: EmbeddingModel<string> | null;
  config: Config;
  onUsage?: (role: string, usage: Usage) => void;
  onDelta?: (delta: string) => void;
}

export interface Readiness {
  ready: boolean;
  missing: string[];
}

/** 就绪判定(SPEC §3.1):设定 + 主角 + 首弧大纲齐 → ready。 */
export function readiness(store: BookStore): Readiness {
  const missing: string[] = [];
  if (!store.readDoc("设定").trim()) missing.push("设定");
  if (!store.listCharacters().some((c) => c.role === "主角")) missing.push("主角");
  if (!store.readDoc("大纲").trim()) missing.push("首弧大纲");
  return { ready: missing.length === 0, missing };
}

/** 供 onboard.md 的 {{已有设定}}:把当前书况压成几行。 */
function knownFactsOf(store: BookStore): string {
  const meta = store.readMeta();
  const lines: string[] = [];
  if (meta.genre) lines.push(`题材:${meta.genre}`);
  if (meta.synopsis) lines.push(`简介:${meta.synopsis}`);
  if (meta.pov) lines.push(`视角:${meta.pov}`);
  if (meta.targetChapters) lines.push(`目标章数:${meta.targetChapters}`);
  const chars = store.listCharacters();
  if (chars.length) lines.push(`角色:${chars.map((c) => `${c.name}(${c.role})`).join("、")}`);
  const outline = store.readDoc("大纲").trim();
  if (outline) lines.push(`大纲:\n${outline}`);
  const setting = store.readDoc("设定").trim();
  if (setting) lines.push(`设定:${setting.slice(0, 200)}`);
  return lines.join("\n");
}

export interface OnboardTurnResult {
  reply: string;
  extracted: OnboardExtract;
  readiness: Readiness;
}

/** 建书一轮(SPEC §3.1):对话回复 → 抽取 → 合并落盘(dedup,空值不覆盖)→ 索引 → commit。 */
export async function onboardTurn(
  store: BookStore,
  userMessage: string,
  deps: OnboardDeps,
): Promise<OnboardTurnResult> {
  const meta = store.readMeta();
  const creativeEnv = deepestPromptFor("creative", deps.config, meta);
  const structuredEnv = deepestPromptFor("structured", deps.config, meta);

  // ① 对话(writer,流式)
  const chatPrompt = renderTemplate(loadPrompt("onboard", store.dir), {
    已有设定: knownFactsOf(store),
    缺失项: readiness(store).missing.join("、"),
    用户消息: userMessage,
  });
  let reply = "";
  for await (const ev of deps.chatter({
    messages: [...creativeEnv.prefix, { role: "user", content: chatPrompt }],
    onUsage: (u) => deps.onUsage?.("writer", u),
  })) {
    reply += ev.delta;
    deps.onDelta?.(ev.delta);
  }

  // ② 抽取(extractor,structured)
  const extractPrompt = renderTemplate(loadPrompt("onboard-extract", store.dir), {
    用户消息: userMessage,
    助手回复: reply,
  });
  const extracted = await generateStructured({
    schema: onboardExtractSchema,
    messages: [...structuredEnv.prefix, { role: "user", content: extractPrompt }, ...structuredEnv.suffix],
    generate: (input) =>
      deps.extractor({ messages: input.messages, onUsage: (u) => deps.onUsage?.("extractor", u) }),
  });

  // ③ 合并落盘:空值不覆盖,同名 dedup
  const metaPatch: Parameters<BookStore["writeMeta"]>[0] = {};
  if (extracted.book.title.trim()) metaPatch.name = extracted.book.title.trim();
  if (extracted.book.genre.trim()) metaPatch.genre = extracted.book.genre.trim();
  if (extracted.book.premise.trim()) metaPatch.synopsis = extracted.book.premise.trim();
  if (extracted.book.pov.trim()) metaPatch.pov = extracted.book.pov.trim();
  if (extracted.book.targetChapters > 0) metaPatch.targetChapters = extracted.book.targetChapters;
  if (Object.keys(metaPatch).length) store.writeMeta(metaPatch);

  if (extracted.setting.trim()) {
    const current = store.readDoc("设定");
    if (!current.includes(extracted.setting.trim())) {
      store.writeDoc("设定", `${current.trim()}${current.trim() ? "\n" : ""}${extracted.setting.trim()}\n`);
    }
  }

  if (extracted.recordRules.length && !store.readDoc("记录规则").trim()) {
    store.writeDoc(
      "记录规则",
      extracted.recordRules.map((r) => `## ${r}\n\n(待记录)`).join("\n\n"),
    );
  }

  const changedIds: string[] = [];
  const existingChars = new Set(store.listCharacters().map((c) => c.name));
  for (const c of extracted.characters) {
    const name = c.name.trim();
    if (!name) continue;
    // upsert 本身保证基底不被重写;这里补 role 映射
    store.upsertCharacter({
      name,
      ...(existingChars.has(name) ? {} : { role: ROLE_MAP[c.role] ?? (c.role || "配角") }),
      base: c.profile,
    });
    changedIds.push(`character:${name}`, `character_state:${name}`);
  }

  const existingWb = new Set(store.listWorldbooks().map((w) => w.title));
  for (const w of extracted.worldbook) {
    const title = w.title.trim();
    if (!title || existingWb.has(title)) continue; // dedup:已有条目不覆盖
    store.upsertWorldbook({ title, keys: w.keys.length ? w.keys : [title], constant: false, body: w.content });
    changedIds.push(`worldbook:${title}`);
  }

  if (extracted.outline.length) {
    let outline = store.readDoc("大纲");
    for (const o of extracted.outline) {
      const title = o.title.trim();
      if (!title || outline.includes(title)) continue; // dedup:同题不重复
      const line = o.level === "volume" ? `# ${title} — ${o.summary}` : `- ${title} — ${o.summary}`;
      outline = `${outline.trim()}${outline.trim() ? "\n" : ""}${line}\n`;
    }
    store.writeDoc("大纲", outline);
  }

  // ④ 索引增量 + commit(onboard#N)
  if (changedIds.length) await updateChunks(store, deps.embedder, changedIds);
  const turnNo = log(store.dir).filter((e) => e.message.startsWith("onboard#")).length + 1;
  commitAll(store.dir, `onboard#${turnNo}`);

  return { reply, extracted, readiness: readiness(store) };
}
