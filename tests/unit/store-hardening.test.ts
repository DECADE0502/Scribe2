// 评审修复的回归测试:LLM 产出即输入——存储层写入前必须消毒(REVIEW-2026-07-03 store 三件套 + 边角)。
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore, sanitizeEntityName } from "../../src/store/book.js";

function tmpBook(): BookStore {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2hard-")), "加固书");
  return BookStore.create(dir, { name: "加固书" });
}

describe("实体名文件名消毒(路径穿越/非法字符)", () => {
  it("角色名含 / \\ : ? 等 → 清洗后落单层文件,listCharacters 可见", () => {
    const store = tmpBook();
    store.upsertCharacter({ name: "赵三/赵老三", role: "配角", base: "b", state: "s" });
    const names = store.listCharacters().map((c) => c.name);
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain("/");
    // 没有产生子目录
    const entries = fs.readdirSync(path.join(store.dir, "角色"), { withFileTypes: true });
    expect(entries.every((e) => e.isFile())).toBe(true);
  });

  it("角色名 ../设定 不会覆盖书根的 设定.md", () => {
    const store = tmpBook();
    store.writeDoc("设定", "原始设定内容");
    store.upsertCharacter({ name: "../设定", base: "恶意", state: "" });
    expect(store.readDoc("设定")).toBe("原始设定内容");
  });

  it("空名/纯点名 → 中文报错含错误码", () => {
    expect(() => sanitizeEntityName("   ")).toThrow(/invalid_entity_name/);
    expect(() => sanitizeEntityName("..")).toThrow(/invalid_entity_name/);
  });

  it("世界书题含 Windows 非法字符 → 清洗后可写可读", () => {
    const store = tmpBook();
    store.upsertWorldbook({ title: "黑水:镇?", keys: ["黑水镇"], constant: false, body: "内容" });
    const titles = store.listWorldbooks().map((w) => w.title);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain("黑水");
    expect(store.readWorldbook(titles[0]!).body).toBe("内容");
  });
});

describe("节内容含 ## 行:降级保内容,不撕节", () => {
  it("角色状态含 '## 伤势' 行 → 内容保留,二次 upsert 不丢", () => {
    const store = tmpBook();
    store.upsertCharacter({ name: "林尘", role: "主角", base: "基底", state: "重伤。\n## 伤势\n左臂断裂。" });
    const first = store.readCharacter("林尘");
    expect(first.state).toContain("伤势");
    expect(first.state).toContain("左臂断裂");
    // 二次 upsert(只动状态)后,基底与旧状态语义仍完整
    store.upsertCharacter({ name: "林尘", state: first.state + "\n新增一行。" });
    const second = store.readCharacter("林尘");
    expect(second.base).toBe("基底");
    expect(second.state).toContain("左臂断裂");
    expect(second.state).toContain("新增一行");
  });

  it("writeRecords 值含 '## 偷跑节' → 不产生新节,内容保留", () => {
    const store = tmpBook();
    store.writeRecords({ 境界: "炼气四层\n## 偷跑节\n这段属于境界", 资产: "灵石" });
    const records = store.readRecords();
    expect(Object.keys(records).sort()).toEqual(["境界", "资产"]);
    expect(records["境界"]).toContain("偷跑节");
    expect(records["境界"]).toContain("这段属于境界");
  });
});

describe("行格式字段清洗换行", () => {
  it("伏笔 label/note 含换行 → 单行落盘,解析完整,二次回写不损坏", () => {
    const store = tmpBook();
    store.applyForeshadow({
      new: [{ label: "黑剑\n来历", chapterNo: 3, note: "第一行\n第二行", characters: ["林尘"] }],
    });
    let list = store.listForeshadows();
    expect(list).toHaveLength(1);
    expect(list[0]!.note).toContain("第一行");
    expect(list[0]!.note).toContain("第二行");
    // 全量回写一次(applyForeshadow 的固有行为)后仍完整
    store.applyForeshadow({ new: [{ label: "另一条", chapterNo: 4, note: "x", characters: [] }] });
    list = store.listForeshadows();
    expect(list).toHaveLength(2);
    expect(list[0]!.note).toContain("第二行");
  });

  it("时间线 event 含换行 → 单行落盘", () => {
    const store = tmpBook();
    store.appendTimeline({ chapterNo: 1, storyTime: "第一日", event: "遇袭\n且受伤", participants: ["林尘"] });
    const lines = store.listTimeline();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.event).toContain("受伤");
  });
});

describe("issue id:全量 note 哈希 + resolved 重开", () => {
  it("同章同类型、前 20 字相同但后文不同 → 两条都收", () => {
    const store = tmpBook();
    const prefix = "时间线冲突:第七日夜灯会——";
    store.addIssues([
      { type: "continuity", chapterNo: 5, note: `${prefix}A 先到场` },
      { type: "continuity", chapterNo: 5, note: `${prefix}B 未出场` },
    ]);
    expect(store.listOpenIssues()).toHaveLength(2);
  });

  it("与 resolved 旧条目同 id 的复发问题 → 翻回 open", () => {
    const store = tmpBook();
    const [added] = store.addIssues([{ type: "pacing", chapterNo: 2, note: "连续两章无推进" }]);
    store.resolveIssue(added!.id);
    expect(store.listOpenIssues()).toHaveLength(0);
    store.addIssues([{ type: "pacing", chapterNo: 2, note: "连续两章无推进" }]);
    expect(store.listOpenIssues()).toHaveLength(1);
  });
});
