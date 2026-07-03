import { describe, expect, it } from "vitest";
import type { EmbeddingModel } from "ai";
import type { Chunk } from "../../src/types.js";
import { retrieve } from "../../src/memory/retrieve.js";

let seq = 0;
function chunk(partial: Partial<Chunk> & { type: Chunk["type"] }): Chunk {
  seq += 1;
  return {
    id: partial.id ?? `${partial.type}:c${seq}`,
    type: partial.type,
    text: partial.text ?? `文本${seq}`,
    keys: partial.keys ?? [],
    updatedAt: 0,
    ...(partial.chapterNo !== undefined ? { chapterNo: partial.chapterNo } : {}),
    ...(partial.embedding !== undefined ? { embedding: partial.embedding } : {}),
  };
}

/** 返回固定向量的假嵌入器(查询用)。 */
function fixedEmbedder(vector: number[]): EmbeddingModel<string> {
  return {
    specificationVersion: "v1", provider: "fake", modelId: "fake",
    maxEmbeddingsPerCall: 10, supportsParallelCalls: true,
    async doEmbed({ values }: { values: string[] }) {
      return { embeddings: values.map(() => vector) };
    },
  } as never;
}

describe("retrieve 混合打分", () => {
  it("1) 纯关键词模式:查询实体命中 keys 的世界书排第一", async () => {
    const index = [
      chunk({ type: "worldbook", id: "worldbook:黑水镇", keys: ["黑水镇", "镇子"] }),
      chunk({ type: "worldbook", id: "worldbook:青云宗", keys: ["青云宗"] }),
      chunk({ type: "summary", chapterNo: 2, keys: ["无关事件"] }),
    ];
    const out = await retrieve({
      index, query: { text: "林尘去黑水镇", entities: ["黑水镇"] },
      currentChapter: 10, embedder: null,
    });
    expect(out[0]!.chunk.id).toBe("worldbook:黑水镇");
  });

  it("2) 多实体命中得分高于单命中", async () => {
    const index = [
      chunk({ type: "foreshadow", id: "foreshadow:双中", keys: ["林尘", "黑剑"], chapterNo: 9 }),
      chunk({ type: "foreshadow", id: "foreshadow:单中", keys: ["林尘"], chapterNo: 9 }),
    ];
    const out = await retrieve({
      index, query: { text: "", entities: ["林尘", "黑剑"] },
      currentChapter: 10, embedder: null,
    });
    expect(out[0]!.chunk.id).toBe("foreshadow:双中");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it("3) recency:同分 summary 第48章排第3章前;character/worldbook 恒 recency=1", async () => {
    const index = [
      chunk({ type: "summary", id: "summary:3", keys: ["灯会"], chapterNo: 3 }),
      chunk({ type: "summary", id: "summary:48", keys: ["灯会"], chapterNo: 48 }),
      chunk({ type: "character", id: "character:老人", keys: ["灯会"] }),
      chunk({ type: "worldbook", id: "worldbook:灯会", keys: ["灯会"] }),
    ];
    const out = await retrieve({
      index, query: { text: "", entities: ["灯会"] }, currentChapter: 50, embedder: null,
    });
    const rank = out.map((s) => s.chunk.id);
    expect(rank.indexOf("summary:48")).toBeLessThan(rank.indexOf("summary:3"));
    expect(out.find((s) => s.chunk.id === "character:老人")!.recency).toBe(1);
    expect(out.find((s) => s.chunk.id === "worldbook:灯会")!.recency).toBe(1);
  });

  it("4) 类型配额:同类高分只出 quota 条,不同类不互挤", async () => {
    const index = [
      ...Array.from({ length: 10 }, (_, i) =>
        chunk({ type: "summary", id: `summary:${i}`, keys: ["林尘"], chapterNo: 50 })),
      chunk({ type: "worldbook", id: "worldbook:榜外也进", keys: ["林尘"] }),
    ];
    const out = await retrieve({
      index, query: { text: "", entities: ["林尘"] }, currentChapter: 50, embedder: null,
      quotas: { summary: 6 },
    });
    expect(out.filter((s) => s.chunk.type === "summary")).toHaveLength(6);
    expect(out.some((s) => s.chunk.id === "worldbook:榜外也进")).toBe(true);
  });

  it("5) 阈值:全不相关返回空,不硬凑", async () => {
    const index = [
      chunk({ type: "worldbook", keys: ["青云宗"] }),
      chunk({ type: "summary", keys: ["灯会"], chapterNo: 1 }),
    ];
    const out = await retrieve({
      index, query: { text: "完全无关的查询", entities: ["火星"] },
      currentChapter: 50, embedder: null,
    });
    expect(out).toHaveLength(0);
  });

  it("6) 向量模式:keys 无命中的语义近邻也能捞回", async () => {
    const index = [
      chunk({ type: "worldbook", id: "worldbook:语义近邻", keys: ["完全不相关的键"], embedding: [1, 0, 0] }),
      chunk({ type: "worldbook", id: "worldbook:反向", keys: ["也不相关"], embedding: [0, 1, 0] }),
    ];
    const out = await retrieve({
      index, query: { text: "语义查询", entities: [] },
      currentChapter: 10, embedder: fixedEmbedder([1, 0, 0]),
    });
    expect(out[0]!.chunk.id).toBe("worldbook:语义近邻");
    expect(out.some((s) => s.chunk.id === "worldbook:反向")).toBe(false); // cos=0 低于阈值
  });

  it("7) charactersOnStage:对应 character_state 无条件置顶", async () => {
    const index = [
      chunk({ type: "worldbook", id: "worldbook:高分", keys: ["黑水镇"] }),
      chunk({ type: "character_state", id: "character_state:苏芸", keys: ["苏芸"] }),
    ];
    const out = await retrieve({
      index, query: { text: "黑水镇", entities: ["黑水镇"], charactersOnStage: ["苏芸"] },
      currentChapter: 10, embedder: null,
    });
    expect(out[0]!.chunk.id).toBe("character_state:苏芸");
  });
});
