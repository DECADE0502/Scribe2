import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { chunksFromBook } from "../../src/memory/chunks.js";
import type { Chunk } from "../../src/types.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "fixtures", "demo-book");
const store = new BookStore(fixtureDir);

function byType(chunks: Chunk[], type: Chunk["type"]): Chunk[] {
  return chunks.filter((c) => c.type === type);
}

describe("chunksFromBook(demo-book fixture)", () => {
  const chunks = chunksFromBook(store);

  it("全类型计数正确", () => {
    expect(byType(chunks, "character")).toHaveLength(3);
    expect(byType(chunks, "character_state")).toHaveLength(3);
    expect(byType(chunks, "worldbook")).toHaveLength(4);
    expect(byType(chunks, "foreshadow")).toHaveLength(6);
    expect(byType(chunks, "timeline")).toHaveLength(10);
    expect(byType(chunks, "summary")).toHaveLength(8);
    expect(byType(chunks, "record")).toHaveLength(3);
    expect(byType(chunks, "issue")).toHaveLength(2); // 只出 open,resolved 不索引
  });

  it("角色两块:基底与状态,keys=[名+aliases]", () => {
    const base = chunks.find((c) => c.id === "character:林尘")!;
    const state = chunks.find((c) => c.id === "character_state:林尘")!;
    expect(base.keys).toEqual(expect.arrayContaining(["林尘", "小尘", "尘哥"]));
    expect(state.keys).toEqual(expect.arrayContaining(["林尘", "小尘", "尘哥"]));
    expect(base.text).toContain("药铺学徒");
    expect(state.text).toContain("炼气四层");
  });

  it("世界书 keys 取 frontmatter keys", () => {
    const wb = chunks.find((c) => c.id === "worldbook:黑水镇")!;
    expect(wb.keys).toEqual(["黑水镇", "镇子"]);
    expect(wb.text).toContain("南疆边陲");
  });

  it("伏笔 keys=[label+关联角色],chapterNo=埋设章", () => {
    const f = chunks.find((c) => c.id === "foreshadow:黑剑来历")!;
    expect(f.keys).toEqual(expect.arrayContaining(["黑剑来历", "林尘"]));
    expect(f.chapterNo).toBe(3);
  });

  it("时间线/摘要 chapterNo 正确", () => {
    const t = byType(chunks, "timeline").find((c) => c.text.includes("灯会遇袭"))!;
    expect(t.chapterNo).toBe(6);
    const s = byType(chunks, "summary").find((c) => c.text.includes("断碑铭文的笔画"))!;
    expect(s.chapterNo).toBe(5);
  });

  it("记录每节一块,keys=[节名]", () => {
    const r = chunks.find((c) => c.id === "record:境界")!;
    expect(r.text).toContain("炼气四层");
    expect(r.keys).toContain("境界");
  });

  it("id 稳定:两次生成同一 id 集合,格式为 type:名称", () => {
    const again = chunksFromBook(store);
    expect(new Set(again.map((c) => c.id))).toEqual(new Set(chunks.map((c) => c.id)));
    for (const c of chunks) expect(c.id).toMatch(/^[a-z_]+:.+/);
  });
});
