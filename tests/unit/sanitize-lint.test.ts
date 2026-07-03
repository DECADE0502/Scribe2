import { describe, expect, it } from "vitest";
import { sanitizeProse } from "../../src/engine/sanitize.js";
import { lintProse } from "../../src/engine/lint.js";

const 正常正文 =
  "我推开客栈的门,雨水顺着蓑衣往下淌。\n\n掌柜抬起头看了我一眼,又低下头拨算盘。\n\n黑水镇的夜,比传闻中更冷。";

describe("sanitizeProse(表驱动)", () => {
  const cases: Array<{ name: string; input: string; expected: string }> = [
    {
      name: "剥全文 ``` 围栏",
      input: "```\n" + 正常正文 + "\n```",
      expected: 正常正文,
    },
    {
      name: "删首部元话语行(好的,以下是第5章正文:)",
      input: "好的,以下是第5章正文:\n\n" + 正常正文,
      expected: 正常正文,
    },
    {
      name: "删重复章节台头(### 第五章 风起)",
      input: "### 第五章 风起\n\n" + 正常正文,
      expected: 正常正文,
    },
    {
      name: "取【正文开始】…【正文结束】内部",
      input: "一些前导说明\n【正文开始】\n" + 正常正文 + "\n【正文结束】\n后记说明",
      expected: 正常正文,
    },
    {
      name: "正常文本原样返回(恒等)",
      input: 正常正文,
      expected: 正常正文,
    },
    {
      name: "章末「本章完」不动(归 lint 管)",
      input: 正常正文 + "\n\n本章完",
      expected: 正常正文 + "\n\n本章完",
    },
    {
      name: "```json 围栏也剥",
      input: "```markdown\n" + 正常正文 + "\n```",
      expected: 正常正文,
    },
    {
      name: "多行元话语连删(寒暄+台头)",
      input: "好的,没问题!\n以下是本章内容:\n# 第五章\n\n" + 正常正文,
      expected: 正常正文,
    },
  ];
  for (const c of cases) {
    it(c.name, () => expect(sanitizeProse(c.input)).toBe(c.expected));
  }
});

describe("lintProse(表驱动)", () => {
  const 千字文 = ("我沿着青石板路往前走。雨已经停了,檐角还在滴水。".repeat(50)).slice(0, 1000);
  const opts = { pov: "第一人称", minChars: 800, allowTailMarkers: false };

  it("过短 → too_short", () => {
    const r = lintProse("我太短了。", opts);
    expect(r).toEqual({ ok: false, reason: "too_short", detail: expect.any(String) });
  });
  it("结尾「未完待续」→ tail_marker", () => {
    const r = lintProse(千字文 + "\n\n(未完待续)", opts);
    expect(r).toMatchObject({ ok: false, reason: "tail_marker" });
  });
  it("结尾「下一章预告」→ tail_marker", () => {
    const r = lintProse(千字文 + "\n\n下一章预告:大战将起", opts);
    expect(r).toMatchObject({ ok: false, reason: "tail_marker" });
  });
  it("结尾「本章完」→ tail_marker", () => {
    const r = lintProse(千字文 + "\n\n本章完", opts);
    expect(r).toMatchObject({ ok: false, reason: "tail_marker" });
  });
  it("allowTailMarkers: true 时尾标记放行", () => {
    const r = lintProse(千字文 + "\n\n(未完待续)", { ...opts, allowTailMarkers: true });
    expect(r).toEqual({ ok: true });
  });
  it("第一人称但首两段无「我」→ pov_drift", () => {
    const 三人称 = ("林尘沿着青石板路往前走。雨停了。".repeat(60)).slice(0, 1000);
    const r = lintProse(三人称, opts);
    expect(r).toMatchObject({ ok: false, reason: "pov_drift" });
  });
  it("第三人称视角不检查「我」", () => {
    const 三人称 = ("林尘沿着青石板路往前走。雨停了。".repeat(60)).slice(0, 1000);
    const r = lintProse(三人称, { ...opts, pov: "第三人称" });
    expect(r).toEqual({ ok: true });
  });
  it("全过 → {ok:true}", () => {
    expect(lintProse(千字文, opts)).toEqual({ ok: true });
  });
});
