import type { EmbeddingModel } from "ai";
import type { Config, Chunk, Usage } from "./../types.js";
import type { BookStore } from "./../store/book.js";
import { loadIndex } from "./../memory/index.js";
import type { retrieve as retrieveFn } from "./../memory/retrieve.js";
import { loadPrompt, renderTemplate } from "./../template.js";
import { deepestPromptFor } from "./context.js";
import type { StreamRole } from "./write.js";

export interface ChatDeps {
  chatter: StreamRole;
  retrieve: typeof retrieveFn;
  embedder: EmbeddingModel<string> | null;
  config: Config;
  onUsage?: (role: string, usage: Usage) => void;
  onDelta?: (delta: string) => void;
}

/** 无分词的实体识别:拿索引里的 keys 反查用户消息,子串命中即实体(SPEC §2.2)。 */
export function entitiesFromText(index: Chunk[], text: string): string[] {
  const hits = new Set<string>();
  for (const chunk of index) {
    for (const key of chunk.keys) {
      const k = key.trim();
      if (k.length >= 2 && text.includes(k)) hits.add(k);
    }
  }
  return [...hits];
}

export interface ChatResult {
  reply: string;
  retrievedCount: number;
}

/** 聊天(SPEC §3.6):用户消息作查询 → 检索 + 近 3 摘要 → 流式回答。零副作用,不写任何文件。 */
export async function chatTurn(store: BookStore, message: string, deps: ChatDeps): Promise<ChatResult> {
  const meta = store.readMeta();
  const index = loadIndex(store);
  const chapters = store.listChapters();

  const scored = await deps.retrieve({
    index,
    query: { text: message, entities: entitiesFromText(index, message) },
    currentChapter: (chapters.at(-1) ?? 0) + 1,
    embedder: deps.embedder,
  });

  const summaries = store.listSummaries();
  const recentBriefs = chapters
    .slice(-3)
    .filter((n) => summaries.includes(n))
    .map((n) => `第${n}章:${store.readSummary(n).brief}`);

  const prompt = renderTemplate(loadPrompt("chat", store.dir), {
    书名: meta.name,
    简介: meta.synopsis ?? "(未填)",
    检索记忆: scored.length
      ? scored.map((s) => `- [${s.chunk.type}] ${s.chunk.text.replace(/\n+/g, " ")}`).join("\n")
      : "(未检索到相关记忆)",
    近章摘要: recentBriefs.length ? recentBriefs.join("\n") : "(尚无章节)",
    用户消息: message,
  });

  const envelope = deepestPromptFor("creative", deps.config, meta);
  let reply = "";
  for await (const ev of deps.chatter({
    messages: [...envelope.prefix, { role: "user", content: prompt }],
    onUsage: (u) => deps.onUsage?.("writer", u),
  })) {
    reply += ev.delta;
    deps.onDelta?.(ev.delta);
  }
  return { reply, retrievedCount: scored.length };
}
