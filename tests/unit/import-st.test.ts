import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { rebuildIndex, loadIndex } from "../../src/memory/index.js";
import { detectStJson, importSillyTavern } from "../../src/import/sillytavern.js";

const fixtures = path.resolve(import.meta.dirname, "..", "fixtures");
const charJson = JSON.parse(fs.readFileSync(path.join(fixtures, "st-character.json"), "utf8"));
const wbJson = JSON.parse(fs.readFileSync(path.join(fixtures, "st-worldbook.json"), "utf8"));

async function makeRig() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2imp-")), "导入书");
  const store = BookStore.create(dir, { name: "导入书" });
  await rebuildIndex(store, null);
  return { store, dir };
}

describe("detectStJson", () => {
  it("识别角色卡/世界书/预设/未知", () => {
    expect(detectStJson(charJson)).toBe("character");
    expect(detectStJson(wbJson)).toBe("worldbook");
    expect(detectStJson({ prompts: [], prompt_order: [] })).toBe("preset");
    expect(detectStJson({ whatever: 1 })).toBe("unknown");
    expect(detectStJson("字符串")).toBe("unknown");
  });
});

describe("importSillyTavern", () => {
  it("角色卡 → 角色/<名>.md,description/personality 进基底,索引更新", async () => {
    const { store } = await makeRig();
    const report = await importSillyTavern(store, null, charJson);
    expect(report.imported.characters).toBe(1);
    const c = store.readCharacter("沈青璃");
    expect(c.base).toContain("守墓人");
    expect(c.base).toContain("外冷内热");
    expect(loadIndex(store).some((chunk) => chunk.id === "character:沈青璃")).toBe(true);
  });

  it("世界书 → 世界书/*.md,key→keys(含副键),constant 保留,停用条目跳过", async () => {
    const { store } = await makeRig();
    const report = await importSillyTavern(store, null, wbJson);
    expect(report.imported.worldbooks).toBe(2);
    const wb = store.readWorldbook("青璃剑冢");
    expect(wb.keys).toEqual(["剑冢", "青璃", "守墓人"]);
    expect(wb.constant).toBe(false);
    expect(wb.body).toContain("剑鸣如潮");
    expect(store.readWorldbook("北境常识").constant).toBe(true);
    expect(store.listWorldbooks().map((w) => w.title)).not.toContain("停用条目");
    expect(report.warnings.join("\n")).toContain("停用条目");
    expect(loadIndex(store).some((chunk) => chunk.id === "worldbook:青璃剑冢")).toBe(true);
  });

  it("同名条目再导入:跳过不覆盖,报 warning", async () => {
    const { store } = await makeRig();
    await importSillyTavern(store, null, wbJson);
    store.upsertWorldbook({ title: "青璃剑冢", keys: ["改过"], constant: false, body: "手工改过的版本" });
    const report = await importSillyTavern(store, null, wbJson);
    expect(report.imported.worldbooks).toBe(0);
    expect(store.readWorldbook("青璃剑冢").body).toContain("手工改过");
  });

  it("未知 json → 中文报错不落盘;preset → 明确报暂不支持", async () => {
    const { store } = await makeRig();
    const charsBefore = store.listCharacters().length;
    const wbBefore = store.listWorldbooks().length;
    await expect(importSillyTavern(store, null, { foo: 1 })).rejects.toThrow(/unknown_import_json/);
    await expect(importSillyTavern(store, null, { prompts: [], prompt_order: [] })).rejects.toThrow(
      /unsupported_import/,
    );
    expect(store.listCharacters().length).toBe(charsBefore);
    expect(store.listWorldbooks().length).toBe(wbBefore);
  });
});
