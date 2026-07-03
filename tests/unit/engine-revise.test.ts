import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { initRepo, commitAll, log } from "../../src/store/git.js";
import { reviseSegment, type ReviseDeps } from "../../src/engine/revise.js";
import type { StreamEvent } from "../../src/types.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "fixtures", "demo-book");

function makeRig(newSegment: string) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2rev-")), "演示书");
  fs.cpSync(fixtureDir, dir, { recursive: true });
  const store = new BookStore(dir);
  initRepo(dir);
  commitAll(dir, "init");
  const captured: unknown[] = [];
  const deps: ReviseDeps = {
    rewriter: (input) => {
      captured.push(input.messages);
      return (async function* (): AsyncGenerator<StreamEvent> {
        if (newSegment) yield { type: "text_delta", delta: newSegment };
      })();
    },
    config: { providers: {}, roles: {}, deepestPromptScope: "creative", singleBudgetUsd: 5 },
  };
  return { store, dir, deps, captured };
}

describe("reviseSegment", () => {
  it("替换精确,前后文进 prompt,commit chNNN-revise", async () => {
    const { store, dir, deps, captured } = makeRig("赵三把酒碗一放,眼神冷了下来。");
    const before = store.readChapter(2).text;
    const selected = "可当我把话头引到三年前那个夜晚,他端碗的手停了半息。";
    expect(before).toContain(selected);

    const result = await reviseSegment(store, { chapterNo: 2, selected, instruction: "把停顿改成明显的敌意" }, deps);
    const after = store.readChapter(2).text;
    expect(after).toContain("眼神冷了下来");
    expect(after).not.toContain("停了半息");
    expect(after).toBe(before.replace(selected, result.newSegment));
    // 前后文进了 prompt
    const joined = JSON.stringify(captured[0]);
    expect(joined).toContain("倒了碗浊酒"); // 前文
    expect(joined).toContain("记了下来"); // 后文
    expect(log(dir)[0]!.message).toMatch(/^ch002-revise/);
  });

  it("选段重复出现:不传 occurrenceIndex 报错,传了则只改指定那处", async () => {
    const { store, deps } = makeRig("改写后的句子。");
    store.writeChapter(9, "同样的句子。中间隔断。同样的句子。结尾。", "重复测试");
    commitAll(store.dir, "ch009: 手工");
    await expect(
      reviseSegment(store, { chapterNo: 9, selected: "同样的句子。", instruction: "改" }, deps),
    ).rejects.toThrow(/ambiguous_selection/);
    await reviseSegment(store, { chapterNo: 9, selected: "同样的句子。", instruction: "改", occurrenceIndex: 1 }, deps);
    expect(store.readChapter(9).text).toBe("同样的句子。中间隔断。改写后的句子。结尾。");
  });

  it("选段不存在 → 报错", async () => {
    const { store, deps } = makeRig("x");
    await expect(
      reviseSegment(store, { chapterNo: 2, selected: "根本没有这句话", instruction: "改" }, deps),
    ).rejects.toThrow(/selection_not_found/);
  });

  it("空输出拒绝,原文不动", async () => {
    const { store, deps } = makeRig("");
    const before = store.readChapter(2).text;
    await expect(
      reviseSegment(store, { chapterNo: 2, selected: "笑声震得房梁落灰", instruction: "改" }, deps),
    ).rejects.toThrow(/empty_revision/);
    expect(store.readChapter(2).text).toBe(before);
  });

  it("尾标记规则同样适用:输出含「未完待续」被拒", async () => {
    const { store, deps } = makeRig("新句子(未完待续)");
    await expect(
      reviseSegment(store, { chapterNo: 2, selected: "笑声震得房梁落灰", instruction: "改" }, deps),
    ).rejects.toThrow(/tail_marker/);
  });
});
