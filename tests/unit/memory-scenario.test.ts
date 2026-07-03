import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { rebuildIndex } from "../../src/memory/index.js";
import { retrieve } from "../../src/memory/retrieve.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "fixtures", "demo-book");

describe("Gate B 场景题:林尘去黑水镇找赵三对质黑剑来历", () => {
  it("检索同时命中:黑水镇世界书 / 赵三状态 / 黑剑伏笔 / 相关时间线;不含无关角色", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2gateB-")), "演示书");
    fs.cpSync(fixtureDir, dir, { recursive: true });
    const store = new BookStore(dir);
    const index = await rebuildIndex(store, null);

    const out = await retrieve({
      index,
      query: {
        text: "林尘去黑水镇找赵三对质黑剑来历",
        entities: ["林尘", "黑水镇", "赵三", "黑剑"],
      },
      currentChapter: 9,
      embedder: null,
    });
    const ids = out.map((s) => s.chunk.id);

    expect(ids).toContain("worldbook:黑水镇");
    expect(ids).toContain("character_state:赵三");
    expect(ids).toContain("foreshadow:黑剑来历");
    // 相关时间线:至少一条以赵三为参与者的事件被捞回
    expect(out.some((s) => s.chunk.type === "timeline" && s.chunk.keys.includes("赵三"))).toBe(true);
    // 无关角色(苏芸)不入榜
    expect(ids).not.toContain("character:苏芸");
    expect(ids).not.toContain("character_state:苏芸");
  });
});
