import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { initRepo, commitAll, log } from "../../src/store/git.js";
import { rebuildIndex } from "../../src/memory/index.js";
import { retrieve } from "../../src/memory/retrieve.js";
import { writeChapter } from "../../src/engine/write.js";
import { writeMany, fixLatest, type ManyDeps } from "../../src/engine/many.js";
import type { StreamEvent, Usage } from "../../src/types.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "fixtures", "demo-book");

const PLAN_JSON = JSON.stringify({
  goal: "推进主线", scenes: ["场景:推进"], charactersOnStage: ["林尘"],
  foreshadowToTouch: [], queryTerms: ["黑水镇"],
});
const 千字正文 = "我沿着湿冷的巷子往前走,黑水镇的夜像一口反扣的锅。".repeat(45);

function extractJsonFor(n: number): string {
  return JSON.stringify({
    characterStates: { 林尘: `第${n}章后状态。` },
    records: {},
    newForeshadow: [],
    foreshadowPaid: [],
    timeline: [{ storyTime: `第${n}天`, event: `第${n}章事件`, participants: ["林尘"] }],
    summary: { oneLiner: `第${n}章一句话。`, paragraph: `第${n}章段落。`, keyEvents: [] },
  });
}

type AuditorMode =
  | "clean"
  | "critical-latest"
  | "critical-historical"
  | "fix-then-historical" // 第一轮 critical@最新,修复后第二轮 historical critical
  | "throws";

function auditJsonFor(mode: AuditorMode, latest: number, call: number): string {
  if (mode === "clean") return JSON.stringify({ issues: [], summary: "未发现确凿矛盾" });
  if (mode === "critical-latest") {
    return JSON.stringify({
      issues: [{ type: "continuity", severity: "critical", chapterNo: latest, note: `第${latest}章严重矛盾:主角凭空瞬移` }],
      summary: "1 处严重",
    });
  }
  if (mode === "fix-then-historical") {
    if (call === 1) {
      return JSON.stringify({
        issues: [{ type: "continuity", severity: "critical", chapterNo: latest, note: `第${latest}章严重矛盾:主角凭空瞬移` }],
        summary: "1 处严重",
      });
    }
    return JSON.stringify({
      issues: [{ type: "setting", severity: "critical", chapterNo: 1, note: "修复引入:第1章境界体系被打脸" }],
      summary: "1 处严重(历史)",
    });
  }
  return JSON.stringify({
    issues: [{ type: "continuity", severity: "critical", chapterNo: 2, note: "第2章历史严重矛盾:配角死而复生" }],
    summary: "1 处严重",
  });
}

async function makeRig(auditorMode: AuditorMode = "clean") {
  // 从空书开始(清掉 fixture 的章节/摘要/时间线),1..6 全新写
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2many-")), "演示书");
  fs.cpSync(fixtureDir, dir, { recursive: true });
  for (const sub of ["章节", "摘要"]) {
    for (const f of fs.readdirSync(path.join(dir, sub))) fs.rmSync(path.join(dir, sub, f));
  }
  fs.writeFileSync(path.join(dir, "时间线.md"), "# 时间线\n", "utf8");
  const store = new BookStore(dir);
  initRepo(dir);
  commitAll(dir, "init");
  await rebuildIndex(store, null);

  let chapterCounter = 0;
  const writerCalls: Array<{ messages: unknown }> = [];
  const auditorCalls: unknown[] = [];
  const usage = (): Usage => ({ promptTokens: 1, completionTokens: 1, cachedTokens: 0 });

  const deps: ManyDeps = {
    planner: async (input) => {
      input.onUsage?.(usage());
      return { text: PLAN_JSON };
    },
    writer: (input) => {
      writerCalls.push({ messages: input.messages });
      return (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", delta: 千字正文 };
        input.onUsage?.(usage());
      })();
    },
    extractor: async (input) => {
      input.onUsage?.(usage());
      chapterCounter += 1;
      return { text: extractJsonFor(chapterCounter) };
    },
    auditor: async (input) => {
      auditorCalls.push(input.messages);
      input.onUsage?.(usage());
      if (auditorMode === "throws") throw new Error("审查服务不可用");
      return {
        text: auditJsonFor(auditorMode, new BookStore(dir).listChapters().at(-1) ?? 1, auditorCalls.length),
      };
    },
    retrieve: vi.fn(retrieve),
    embedder: null,
    config: { providers: {}, roles: {}, deepestPromptScope: "creative", singleBudgetUsd: 5 },
  };
  return { store, dir, deps, writerCalls, auditorCalls };
}

describe("writeMany + 护栏", () => {
  it("1) 写 6 章,第 5 章后护栏 auditor 被调一次(范围近5章)", async () => {
    const { store, deps, auditorCalls } = await makeRig("clean");
    const result = await writeMany(store, 1, 6, deps);
    expect(result.completed).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.stoppedAt).toBeUndefined();
    expect(auditorCalls).toHaveLength(1);
    const joined = JSON.stringify(auditorCalls[0]);
    expect(joined).toContain("第1-5章"); // 审查范围近5章
  });

  it("2) critical@最新章 → 自动修复一次 → 再 critical → 停", async () => {
    const { store, dir, deps, writerCalls } = await makeRig("critical-latest");
    const result = await writeMany(store, 1, 6, deps);
    // 1..5 正常写 + fix 重写第 5 章 = 6 次 writer
    expect(writerCalls).toHaveLength(6);
    expect(result.completed).toEqual([1, 2, 3, 4, 5]);
    expect(result.stoppedAt).toBe(6);
    expect(result.reason).toMatch(/critical/);
    // fix 重写时 writer 收到了 issues 注入
    expect(JSON.stringify(writerCalls[5]!.messages)).toContain("凭空瞬移");
    // git 顶部是重写后的 ch005
    expect(log(dir)[0]!.message).toMatch(/^ch005/);
    // 问题留档
    expect(store.listOpenIssues().some((i) => i.note.includes("凭空瞬移"))).toBe(true);
  });

  it("3) critical@历史章 → 停,不 reset,问题入 问题.md", async () => {
    const { store, dir, deps, writerCalls } = await makeRig("critical-historical");
    const result = await writeMany(store, 1, 6, deps);
    expect(writerCalls).toHaveLength(5); // 没有 fix 重写
    expect(result.completed).toEqual([1, 2, 3, 4, 5]);
    expect(result.stoppedAt).toBe(6);
    expect(result.reason).toMatch(/历史|historical/);
    expect(store.listOpenIssues().some((i) => i.note.includes("死而复生"))).toBe(true);
    // 未 reset:5 章俱在
    expect(store.listChapters()).toEqual([1, 2, 3, 4, 5]);
  });

  it("2b) 修复后第二轮审出历史章 critical → 停下并入 问题.md(不再整体丢弃)", async () => {
    const { store, deps } = await makeRig("fix-then-historical");
    const result = await writeMany(store, 1, 6, deps);
    expect(result.stoppedAt).toBe(6);
    expect(result.reason).toMatch(/历史|historical/);
    expect(store.listOpenIssues().some((i) => i.note.includes("境界体系被打脸"))).toBe(true);
  });

  it("2c) 护栏审查自身抛错 → 不崩溃,返回 guard_failed 报告", async () => {
    const { store, deps, writerCalls } = await makeRig("throws");
    const result = await writeMany(store, 1, 6, deps);
    expect(writerCalls).toHaveLength(5);
    expect(result.completed).toEqual([1, 2, 3, 4, 5]);
    expect(result.reason).toMatch(/guard_failed/);
  });

  it("4) 成本超限 → 停在开写前", async () => {
    const { store, deps, writerCalls } = await makeRig("clean");
    const result = await writeMany(store, 1, 6, { ...deps, runBudgetUsd: 1, costProbe: () => 9 });
    expect(writerCalls).toHaveLength(0);
    expect(result.completed).toEqual([]);
    expect(result.stoppedAt).toBe(1);
    expect(result.reason).toMatch(/预算|budget/);
  });
});

describe("fixLatest", () => {
  it("5) reset 最新章 commit → 带 open issues 重跑管线 → 新 commit;无章可修报错", async () => {
    const { store, dir, deps, writerCalls } = await makeRig("clean");
    await writeChapter(store, 1, "", deps);
    store.addIssues([{ type: "perspective", chapterNo: 1, note: "视角漂移严重,后半章成了上帝视角" }]);
    const before = log(dir).length;

    await fixLatest(store, deps);
    // 重写时 writer 收到 open issue
    expect(JSON.stringify(writerCalls.at(-1)!.messages)).toContain("视角漂移严重");
    expect(log(dir)[0]!.message).toMatch(/^ch001/);
    expect(log(dir).length).toBe(before); // reset 掉一个 commit 又新增一个
    expect(store.listChapters()).toEqual([1]);

    // 无章可修:空书报错
    const emptyDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2fix-")), "空书");
    const empty = BookStore.create(emptyDir, { name: "空书" });
    initRepo(emptyDir);
    commitAll(emptyDir, "init");
    await expect(fixLatest(empty, deps)).rejects.toThrow(/no_chapter_to_fix/);
  });

  it("6) fixLatest 重写失败 → 恢复到 reset 前的 HEAD,原章无损", async () => {
    const { dir, store, deps } = await makeRig("clean");
    await writeChapter(store, 1, "", deps);
    const textBefore = store.readChapter(1).text;
    const headBefore = log(dir)[0]!.hash;
    // 让修复时的重写必然 lint 双败:后续 writer 只吐短稿
    (deps as { writer: unknown }).writer = (input: { messages: unknown; onUsage?: (u: Usage) => void }) =>
      (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", delta: "太短的重写稿。" };
        input.onUsage?.({ promptTokens: 1, completionTokens: 1, cachedTokens: 0 });
      })();
    await expect(fixLatest(store, deps)).rejects.toThrow(/fix_failed/);
    // 原章与 HEAD 恢复如初
    expect(store.listChapters()).toEqual([1]);
    expect(store.readChapter(1).text).toBe(textBefore);
    expect(log(dir)[0]!.hash).toBe(headBefore);
  });
});
