import { describe, expect, it } from "vitest";
import { renderTemplate, loadPrompt } from "../../src/template.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("renderTemplate", () => {
  it("替换 {{var}},缺失变量抛错(拒绝静默空洞)", () => {
    expect(renderTemplate("你好 {{名字}}", { 名字: "林尘" })).toBe("你好 林尘");
    expect(() => renderTemplate("{{没给}}", {})).toThrow(/没给/);
  });
  it("{{#if x}}…{{/if}} 条件段:空串/空数组视为假", () => {
    expect(renderTemplate("A{{#if k}}B{{/if}}C", { k: "" })).toBe("AC");
    expect(renderTemplate("A{{#if k}}B{{k}}{{/if}}C", { k: "有" })).toBe("AB有C");
    expect(renderTemplate("A{{#if k}}B{{/if}}C", { k: [] })).toBe("AC");
  });
  it("剥掉文件头部的 <!-- --> 注释块", () => {
    expect(renderTemplate("<!--说明-->\n正文{{x}}", { x: "1" })).toBe("正文1");
  });
});

describe("loadPrompt(书级覆盖)", () => {
  it("书目录有同名文件则优先于内置 prompts/", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2-"));
    fs.mkdirSync(path.join(tmp, "prompts"));
    fs.writeFileSync(path.join(tmp, "prompts", "chat.md"), "书级覆盖 {{书名}}");
    expect(loadPrompt("chat", tmp)).toContain("书级覆盖");
    expect(loadPrompt("chat")).toContain("责编助手"); // 内置版
  });
  it("9 个内置提示词全部可载入且非空", () => {
    const names = [
      "audit", "chat", "compress-arc", "extract-memory", "onboard-extract",
      "onboard", "plan-chapter", "revise", "write-chapter",
    ];
    for (const name of names) {
      expect(loadPrompt(name).trim().length, name).toBeGreaterThan(0);
    }
  });
  it("不存在的提示词 → 中文报错含错误码", () => {
    expect(() => loadPrompt("不存在的")).toThrow(/prompt_not_found/);
  });
});
