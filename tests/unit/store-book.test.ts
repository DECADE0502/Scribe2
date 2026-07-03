import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";

function tmpBook(): BookStore {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2book-")), "演示书");
  return BookStore.create(dir, { name: "演示书", pov: "第一人称", genre: "都市异能" });
}

describe("BookStore.create", () => {
  it("建立完整目录骨架", () => {
    const store = tmpBook();
    for (const f of ["book.md", "设定.md", "记录规则.md", "大纲.md", "伏笔.md", "时间线.md", "状态.md", "问题.md"]) {
      expect(fs.existsSync(path.join(store.dir, f)), f).toBe(true);
    }
    for (const d of ["角色", "世界书", "章节", "摘要", "弧"]) {
      expect(fs.statSync(path.join(store.dir, d)).isDirectory(), d).toBe(true);
    }
  });
});

describe("meta", () => {
  it("readMeta 读出建书时写入的值;writeMeta 局部更新不丢其他字段", () => {
    const store = tmpBook();
    expect(store.readMeta().pov).toBe("第一人称");
    store.writeMeta({ targetWords: 1200 });
    const meta = store.readMeta();
    expect(meta.targetWords).toBe(1200);
    expect(meta.pov).toBe("第一人称");
    expect(meta.name).toBe("演示书");
  });
});

describe("章节", () => {
  it("writeChapter → 章节/005.md 带 frontmatter,readChapter round-trip,listChapters 升序", () => {
    const store = tmpBook();
    store.writeChapter(5, "这是正文内容。", "风起");
    store.writeChapter(1, "第一章正文。", "开端");
    const raw = fs.readFileSync(path.join(store.dir, "章节", "005.md"), "utf8");
    expect(raw).toContain("标题: 风起");
    const ch = store.readChapter(5);
    expect(ch.title).toBe("风起");
    expect(ch.text).toBe("这是正文内容。");
    expect(ch.words).toBe("这是正文内容。".length);
    expect(store.listChapters()).toEqual([1, 5]);
  });
});

describe("角色", () => {
  it("upsertCharacter 新建:frontmatter 有 role/aliases,基底与状态节齐全", () => {
    const store = tmpBook();
    store.upsertCharacter({ name: "林尘", role: "主角", aliases: ["小尘"], base: "冷静果决。", state: "初到黑水镇。" });
    const c = store.readCharacter("林尘");
    expect(c.role).toBe("主角");
    expect(c.aliases).toEqual(["小尘"]);
    expect(c.base).toContain("冷静果决");
    expect(c.state).toContain("黑水镇");
  });
  it("二次调用只更新状态节,基底不动;新 alias 合并", () => {
    const store = tmpBook();
    store.upsertCharacter({ name: "林尘", role: "主角", base: "冷静果决。", state: "初到黑水镇。" });
    store.upsertCharacter({ name: "林尘", base: "试图覆盖基底(应被忽略)", state: "身受重伤。", aliases: ["尘哥"] });
    const c = store.readCharacter("林尘");
    expect(c.base).toContain("冷静果决");
    expect(c.base).not.toContain("覆盖基底");
    expect(c.state).toContain("身受重伤");
    expect(c.state).not.toContain("黑水镇");
    expect(c.aliases).toContain("尘哥");
  });
});

describe("世界书", () => {
  it("upsertWorldbook/readWorldbook round-trip(keys/constant)", () => {
    const store = tmpBook();
    store.upsertWorldbook({ title: "黑水镇", keys: ["黑水镇", "镇子"], constant: false, body: "南疆边陲小镇。" });
    const w = store.readWorldbook("黑水镇");
    expect(w.keys).toEqual(["黑水镇", "镇子"]);
    expect(w.constant).toBe(false);
    expect(w.body).toContain("南疆");
    expect(store.listWorldbooks().map((x) => x.title)).toContain("黑水镇");
  });
});

describe("伏笔", () => {
  it("新增行格式正确,label 归一化 dedup", () => {
    const store = tmpBook();
    store.applyForeshadow({ new: [{ label: "黑剑来历", chapterNo: 3, note: "剑上刻着古字", characters: ["林尘"] }] });
    store.applyForeshadow({ new: [{ label: " 黑剑来历 ", chapterNo: 4, note: "重复的应被忽略", characters: [] }] });
    const list = store.listForeshadows();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "active", label: "黑剑来历", chapterNo: 3 });
    const raw = fs.readFileSync(path.join(store.dir, "伏笔.md"), "utf8");
    expect(raw).toContain("- [active] 黑剑来历 | 埋于第3章 | 剑上刻着古字 | 关联:林尘");
  });
  it("paid 翻转 [active]→[paid]", () => {
    const store = tmpBook();
    store.applyForeshadow({ new: [{ label: "黑剑来历", chapterNo: 3, note: "x", characters: [] }] });
    store.applyForeshadow({ paid: ["黑剑来历"] });
    expect(store.listForeshadows()[0]!.status).toBe("paid");
  });
});

describe("时间线", () => {
  it("追加且 (storyTime,event) 去重,chapterNo 解析正确", () => {
    const store = tmpBook();
    store.appendTimeline({ chapterNo: 5, storyTime: "第七日夜", event: "灯会遇袭", participants: ["林尘", "赵三"] });
    store.appendTimeline({ chapterNo: 5, storyTime: "第七日夜", event: "灯会遇袭", participants: ["林尘"] });
    store.appendTimeline({ chapterNo: 6, storyTime: "第八日晨", event: "离镇", participants: ["林尘"] });
    const lines = store.listTimeline();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ chapterNo: 5, storyTime: "第七日夜", event: "灯会遇袭" });
    expect(lines[0]!.participants).toEqual(["林尘", "赵三"]);
  });
});

describe("状态(动态记录)", () => {
  it("writeRecords 整节替换,其他节保留", () => {
    const store = tmpBook();
    store.writeRecords({ 境界: "炼气三层", 资产: "灵石 12 枚" });
    store.writeRecords({ 境界: "炼气四层" });
    const records = store.readRecords();
    expect(records["境界"]).toBe("炼气四层");
    expect(records["资产"]).toBe("灵石 12 枚");
  });
});

describe("摘要与弧", () => {
  it("writeSummary/readSummary round-trip", () => {
    const store = tmpBook();
    store.writeSummary(5, { brief: "林尘抵达黑水镇。", paragraph: "长段落摘要。", events: ["遇见赵三", "发现黑剑"] });
    const s = store.readSummary(5);
    expect(s.brief).toBe("林尘抵达黑水镇。");
    expect(s.paragraph).toBe("长段落摘要。");
    expect(s.events).toEqual(["遇见赵三", "发现黑剑"]);
    expect(store.listSummaries()).toEqual([5]);
  });
  it("writeArc/readArc round-trip", () => {
    const store = tmpBook();
    store.writeArc(1, "第一弧:复仇的种子。");
    expect(store.readArc(1)).toContain("复仇的种子");
    expect(store.listArcs()).toEqual([1]);
  });
});

describe("问题", () => {
  it("addIssues/listOpenIssues/resolveIssue 流转,重复添加不翻倍", () => {
    const store = tmpBook();
    const added = store.addIssues([{ type: "逻辑", chapterNo: 5, note: "时间线冲突:第七日重复" }]);
    store.addIssues([{ type: "逻辑", chapterNo: 5, note: "时间线冲突:第七日重复" }]);
    expect(store.listOpenIssues()).toHaveLength(1);
    const id = added[0]!.id;
    store.resolveIssue(id);
    expect(store.listOpenIssues()).toHaveLength(0);
  });
});

describe("手工编辑容错", () => {
  it("无 frontmatter 的章节旧文件、伏笔/时间线坏行都不炸", () => {
    const store = tmpBook();
    fs.writeFileSync(path.join(store.dir, "章节", "007.md"), "没有 frontmatter 的旧正文");
    fs.appendFileSync(path.join(store.dir, "伏笔.md"), "\n这是一条坏行,不符合格式\n- [active] 好行 | 埋于第1章 | x | 关联:\n");
    fs.appendFileSync(path.join(store.dir, "时间线.md"), "\n乱七八糟\n");
    expect(store.readChapter(7).text).toContain("旧正文");
    expect(store.readChapter(7).title).toBe("");
    expect(store.listChapters()).toContain(7);
    expect(store.listForeshadows().map((f) => f.label)).toContain("好行");
    expect(() => store.listTimeline()).not.toThrow();
  });
});
