// Gate B 人工验收辅助:打印场景题的检索排名表(三项得分)。
// 用法:pnpm exec tsx scripts/show-retrieval.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../src/store/book.js";
import { rebuildIndex } from "../src/memory/index.js";
import { retrieve } from "../src/memory/retrieve.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "tests", "fixtures", "demo-book");
const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2show-")), "演示书");
fs.cpSync(fixtureDir, dir, { recursive: true });

const store = new BookStore(dir);
const index = await rebuildIndex(store, null);
const out = await retrieve({
  index,
  query: { text: "林尘去黑水镇找赵三对质黑剑来历", entities: ["林尘", "黑水镇", "赵三", "黑剑"] },
  currentChapter: 9,
  embedder: null,
});

console.log("查询:林尘去黑水镇找赵三对质黑剑来历");
console.log("实体:林尘 / 黑水镇 / 赵三 / 黑剑;currentChapter=9;无向量(关键词 0.6 + 时近 0.4)\n");
console.log("排名 | 总分 | keyword | recency | chunk");
for (const [i, s] of out.entries()) {
  const text = s.chunk.text.replace(/\n/g, " ").slice(0, 34);
  console.log(
    `${String(i + 1).padStart(2)} | ${s.score.toFixed(3)} | ${s.keyword.toFixed(2)} | ${s.recency.toFixed(2)} | [${s.chunk.type}] ${text}`,
  );
}
console.log(`\n共 ${out.length} 条入榜(索引总量 ${index.length} 条)`);
