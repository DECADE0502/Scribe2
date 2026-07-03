import { describe, expect, it } from "vitest";
import { outlineSliceFor } from "../../src/engine/write.js";

const 大纲 = [
  "# 卷一:黑水镇(1-10 章)",
  "- 弧1(1-5):初到黑水镇,查访线索。",
  "- 弧2(6-10):黑剑异动,被迫离镇。",
  "# 卷二:瘴林(11-25 章)",
  "- 弧3(11-25):瘴林历练,发现旧案。",
].join("\n");

describe("outlineSliceFor(plan-chapter 的「所属弧」切片)", () => {
  it("第 3 章:含卷一与弧1,不含弧2/卷二", () => {
    const slice = outlineSliceFor(大纲, 3);
    expect(slice).toContain("卷一");
    expect(slice).toContain("弧1");
    expect(slice).not.toContain("弧2");
    expect(slice).not.toContain("卷二");
  });
  it("第 12 章:含卷二与弧3,不含卷一", () => {
    const slice = outlineSliceFor(大纲, 12);
    expect(slice).toContain("弧3");
    expect(slice).toContain("卷二");
    expect(slice).not.toContain("卷一");
  });
  it("认不出区间格式 → 回退整份大纲", () => {
    const plain = "- 第一卷 — 初入江湖\n- 弧:复仇的种子";
    expect(outlineSliceFor(plain, 5)).toBe(plain);
  });
  it("超出全部区间的章号 → 回退整份大纲", () => {
    expect(outlineSliceFor(大纲, 99)).toBe(大纲);
  });
});
