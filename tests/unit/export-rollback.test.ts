import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { initRepo, commitAll } from "../../src/store/git.js";
import { rebuildIndex, loadIndex } from "../../src/memory/index.js";
import { exportChapter, exportBook, rollbackBook } from "../../src/engine/export.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "fixtures", "demo-book");

function makeStore(): BookStore {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2exp-")), "演示书");
  fs.cpSync(fixtureDir, dir, { recursive: true });
  return new BookStore(dir);
}

describe("export", () => {
  it("单章 md:标题成章节头,无 frontmatter 分隔线", () => {
    const store = makeStore();
    const md = exportChapter(store, 2, "md");
    expect(md).toContain("# 第2章 镖局问旧");
    expect(md).toContain("浊酒");
    expect(md).not.toContain("---");
  });

  it("单章 txt:纯文本,无 markdown 台头", () => {
    const store = makeStore();
    const txt = exportChapter(store, 2, "txt");
    expect(txt).toContain("第2章 镖局问旧");
    expect(txt).toContain("浊酒");
    expect(txt).not.toContain("#");
    expect(txt).not.toContain("---");
  });

  it("全书拼接升序,txt 全程无 frontmatter", () => {
    const store = makeStore();
    const md = exportBook(store, "md");
    expect(md.indexOf("# 第1章")).toBeGreaterThanOrEqual(0);
    expect(md.indexOf("# 第1章")).toBeLessThan(md.indexOf("# 第2章"));
    expect(md.indexOf("# 第3章")).toBeLessThan(md.indexOf("# 第4章"));
    const txt = exportBook(store, "txt");
    expect(txt).not.toContain("---");
    expect(txt).not.toContain("#");
  });

  it("空书导出报错", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2exp0-")), "空书");
    const store = BookStore.create(dir, { name: "空书" });
    expect(() => exportBook(store, "md")).toThrow(/no_chapters/);
  });
});

describe("rollback", () => {
  it("resetToBefore(chNNN) 且自动 reindex,章数回退", async () => {
    const store = makeStore();
    initRepo(store.dir);
    commitAll(store.dir, "init");
    store.writeChapter(5, "第五章新正文。".repeat(20), "第五章");
    store.writeSummary(5, { brief: "第5章。", paragraph: "第5章段落。", events: [] });
    commitAll(store.dir, "ch005: 写作");
    store.writeChapter(6, "第六章新正文。".repeat(20), "第六章");
    store.writeSummary(6, { brief: "第6章。", paragraph: "第6章段落。", events: [] });
    commitAll(store.dir, "ch006: 写作");
    await rebuildIndex(store, null);
    expect(loadIndex(store).find((c) => c.id === "summary:6")!.text).toContain("第6章段落");

    await rollbackBook(store, 6, null);
    // 第 6 章正文撤销;摘要/006 回到 fixture 预置版本(灯会遇袭),索引自动重建跟上
    expect(store.listChapters()).not.toContain(6);
    expect(store.listChapters()).toContain(5);
    const summary6 = loadIndex(store).find((c) => c.id === "summary:6")!;
    expect(summary6.text).toContain("灯会遇袭");
    expect(summary6.text).not.toContain("第6章段落");
  });

  it("目标章 commit 不存在 → 报错", async () => {
    const store = makeStore();
    initRepo(store.dir);
    commitAll(store.dir, "init");
    await expect(rollbackBook(store, 99, null)).rejects.toThrow(/commit_not_found/);
  });
});
