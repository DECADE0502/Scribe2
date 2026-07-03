import * as fs from "node:fs";
import * as path from "node:path";
import type { EmbeddingModel } from "ai";
import type { Chunk } from "./../types.js";
import type { BookStore } from "./../store/book.js";
import { chunksFromBook } from "./chunks.js";
import { embedTexts } from "./../llm/embed.js";

function indexFile(store: BookStore): string {
  return path.join(store.dir, ".index", "chunks.jsonl");
}

function writeIndex(store: BookStore, chunks: Chunk[]): void {
  fs.mkdirSync(path.join(store.dir, ".index"), { recursive: true });
  const lines = chunks.map((c) => JSON.stringify(c)).join("\n");
  fs.writeFileSync(indexFile(store), `${lines}\n`, "utf8");
}

/** 读索引;文件不存在返回 [],坏行跳过(索引随时可 rebuild,不值得为它崩溃)。 */
export function loadIndex(store: BookStore): Chunk[] {
  const file = indexFile(store);
  if (!fs.existsSync(file)) return [];
  const out: Chunk[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Chunk;
      if (typeof parsed.id === "string" && typeof parsed.text === "string") out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

/** 全量重建:重新抽取全部 chunk,embedder 存在则全部重嵌入。 */
export async function rebuildIndex(
  store: BookStore,
  embedder: EmbeddingModel<string> | null,
): Promise<Chunk[]> {
  const chunks = chunksFromBook(store);
  const vectors = await embedTexts(embedder, chunks.map((c) => c.text));
  if (vectors) {
    chunks.forEach((c, i) => (c.embedding = vectors[i]));
  }
  writeIndex(store, chunks);
  return chunks;
}

/** 按文本差异自动找出变更 id 再增量更新——手工/网页编辑保存后不知道改了哪些块时用。 */
export async function syncIndex(
  store: BookStore,
  embedder: EmbeddingModel<string> | null,
): Promise<Chunk[]> {
  const fresh = chunksFromBook(store);
  const old = new Map(loadIndex(store).map((c) => [c.id, c]));
  const changed = fresh.filter((c) => old.get(c.id)?.text !== c.text).map((c) => c.id);
  return updateChunks(store, embedder, changed);
}

/**
 * 增量更新:重新抽取全部 chunk(纯本地、便宜),但只对指定 id 重嵌入,
 * 其余条目沿用旧索引里的向量(嵌入才是要省的成本)。
 * 指定 id 已不存在(条目被删)→ 从索引里自然消失。
 */
export async function updateChunks(
  store: BookStore,
  embedder: EmbeddingModel<string> | null,
  ids: string[],
): Promise<Chunk[]> {
  const fresh = chunksFromBook(store);
  const old = new Map(loadIndex(store).map((c) => [c.id, c]));
  const target = new Set(ids);

  const toEmbed = fresh.filter((c) => target.has(c.id));
  const vectors = await embedTexts(embedder, toEmbed.map((c) => c.text));
  const newVector = new Map<string, number[]>();
  if (vectors) {
    toEmbed.forEach((c, i) => newVector.set(c.id, vectors[i]!));
  }

  for (const chunk of fresh) {
    if (newVector.has(chunk.id)) {
      chunk.embedding = newVector.get(chunk.id);
    } else if (!target.has(chunk.id)) {
      const prev = old.get(chunk.id);
      if (prev?.embedding) chunk.embedding = prev.embedding;
      if (prev) chunk.updatedAt = prev.updatedAt;
    }
  }
  writeIndex(store, fresh);
  return fresh;
}
