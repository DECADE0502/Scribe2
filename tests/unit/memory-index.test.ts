import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EmbeddingModel } from "ai";
import { BookStore } from "../../src/store/book.js";
import { rebuildIndex, updateChunks, loadIndex } from "../../src/memory/index.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "fixtures", "demo-book");

/** 复制 fixture 到 tmp,避免测试污染仓库内文件。 */
function tmpStore(): BookStore {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2idx-")), "演示书");
  fs.cpSync(fixtureDir, dir, { recursive: true });
  return new BookStore(dir);
}

function fakeEmbedder(counter: { calls: number; embedded: string[] }): EmbeddingModel<string> {
  return {
    specificationVersion: "v1", provider: "fake", modelId: "fake-embed",
    maxEmbeddingsPerCall: 100, supportsParallelCalls: true,
    async doEmbed({ values }: { values: string[] }) {
      counter.calls += 1;
      counter.embedded.push(...values);
      return { embeddings: values.map((v) => [v.length % 7, 1, 0]) };
    },
  } as never;
}

describe("memory/index", () => {
  it("rebuildIndex 写 .index/chunks.jsonl,loadIndex round-trip", async () => {
    const store = tmpStore();
    const written = await rebuildIndex(store, null);
    const file = path.join(store.dir, ".index", "chunks.jsonl");
    expect(fs.existsSync(file)).toBe(true);
    const loaded = loadIndex(store);
    expect(loaded).toHaveLength(written.length);
    expect(new Set(loaded.map((c) => c.id))).toEqual(new Set(written.map((c) => c.id)));
    // embedder=null → embedding 字段缺省
    expect(loaded.every((c) => c.embedding === undefined)).toBe(true);
  });

  it("带 embedder 时全量嵌入;updateChunks 只重嵌入指定 id", async () => {
    const store = tmpStore();
    const counter = { calls: 0, embedded: [] as string[] };
    const all = await rebuildIndex(store, fakeEmbedder(counter));
    expect(counter.embedded).toHaveLength(all.length);
    expect(loadIndex(store).every((c) => Array.isArray(c.embedding))).toBe(true);

    // 改一个角色状态 → 只重嵌入这 1 条
    counter.embedded = [];
    store.upsertCharacter({ name: "林尘", state: "重伤,躲进瘴林边缘。" });
    const updated = await updateChunks(store, fakeEmbedder(counter), ["character_state:林尘"]);
    expect(counter.embedded).toHaveLength(1);
    expect(counter.embedded[0]).toContain("重伤");
    const after = loadIndex(store);
    expect(after.find((c) => c.id === "character_state:林尘")!.text).toContain("重伤");
    // 其他条目的 embedding 原样保留
    expect(after.filter((c) => Array.isArray(c.embedding))).toHaveLength(updated.length);
  });

  it("文件里的坏行跳过,不炸;合法 JSON 但缺 keys/type 的行同样跳过", async () => {
    const store = tmpStore();
    await rebuildIndex(store, null);
    const file = path.join(store.dir, ".index", "chunks.jsonl");
    const before = loadIndex(store).length;
    fs.appendFileSync(file, "不是json的坏行\n", "utf8");
    fs.appendFileSync(file, '{"id":"x:1","text":"缺 keys 与 type 的行"}\n', "utf8");
    fs.appendFileSync(file, '{"id":"x:2","text":"type 非法","keys":[],"type":123}\n', "utf8");
    expect(loadIndex(store)).toHaveLength(before);
  });

  it("updateChunks 处理消失的 id(条目被删除后索引同步删除)", async () => {
    const store = tmpStore();
    await rebuildIndex(store, null);
    fs.rmSync(path.join(store.dir, "角色", "苏芸.md"));
    const after = await updateChunks(store, null, ["character:苏芸", "character_state:苏芸"]);
    expect(after.some((c) => c.id === "character:苏芸")).toBe(false);
    const ids = new Set(loadIndex(store).map((c) => c.id));
    expect(ids.has("character:苏芸")).toBe(false);
    expect(ids.has("character_state:苏芸")).toBe(false);
  });
});
