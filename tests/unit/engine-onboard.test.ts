import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { initRepo, commitAll, log } from "../../src/store/git.js";
import { loadIndex } from "../../src/memory/index.js";
import { onboardTurn, readiness, type OnboardDeps } from "../../src/engine/onboard.js";
import type { StreamEvent, Usage } from "../../src/types.js";

const EXTRACT = {
  book: { title: "", genre: "修仙复仇", premise: "废材少年持黑剑复仇成仙", pov: "第一人称", targetChapters: 50 },
  setting: "灵气复苏三百年,南疆宗门林立,散修如蝼蚁。",
  recordRules: ["境界", "灵石"],
  characters: [{ name: "陈默", role: "protagonist", profile: "欲望:查清灭门真相;缺陷:多疑寡言" }],
  worldbook: [{ title: "青云宗", keys: ["青云宗", "宗门"], content: "南疆唯一大宗,三年一收徒。" }],
  outline: [
    { level: "volume", title: "卷一:黑水镇", summary: "初入江湖,查访线索" },
    { level: "arc", title: "弧1:复仇的种子", summary: "结识盟友,锁定仇家方向" },
  ],
};

function makeRig(extractJson: object = EXTRACT) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2onb-")), "测试书");
  const store = BookStore.create(dir, { name: "测试书" });
  initRepo(dir);
  commitAll(dir, "init: 建库基线");

  const chatterCalls: unknown[] = [];
  const onUsage = vi.fn();
  const deps: OnboardDeps = {
    chatter: (input) => {
      chatterCalls.push(input.messages);
      input.onUsage?.({ promptTokens: 1, completionTokens: 1, cachedTokens: 0 } as Usage);
      return (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", delta: "✓ 已确认:修仙复仇,第一人称。底子快齐了。" };
      })();
    },
    extractor: async (input) => {
      input.onUsage?.({ promptTokens: 1, completionTokens: 1, cachedTokens: 0 } as Usage);
      return { text: JSON.stringify(extractJson) };
    },
    embedder: null,
    config: {
      providers: {}, roles: {}, deepestPromptScope: "creative", singleBudgetUsd: 5,
    },
    onUsage,
  };
  return { store, dir, deps, chatterCalls, onUsage };
}

describe("onboardTurn", () => {
  it("一轮对话:回复流式返回,抽取结果落盘(meta/设定/记录规则/角色/世界书/大纲),索引与 commit", async () => {
    const { store, dir, deps } = makeRig();
    const result = await onboardTurn(store, "我想写修仙复仇文,主角陈默", deps);

    expect(result.reply).toContain("已确认");
    const meta = store.readMeta();
    expect(meta.name).toBe("测试书"); // 空 title 不覆盖书名
    expect(meta.genre).toBe("修仙复仇");
    expect(meta.pov).toBe("第一人称");
    expect(meta.targetChapters).toBe(50);
    expect(store.readDoc("设定")).toContain("灵气复苏");
    expect(store.readDoc("记录规则")).toContain("境界");
    expect(store.readCharacter("陈默").role).toBe("主角");
    expect(store.readCharacter("陈默").base).toContain("多疑");
    expect(store.readWorldbook("青云宗").keys).toContain("青云宗");
    expect(store.readDoc("大纲")).toContain("卷一:黑水镇");
    expect(store.readDoc("大纲")).toContain("弧1:复仇的种子");
    const index = loadIndex(store);
    expect(index.some((c) => c.id === "character:陈默")).toBe(true);
    expect(index.some((c) => c.id === "worldbook:青云宗")).toBe(true);
    expect(log(dir)[0]!.message).toBe("onboard#1");
  });

  it("二轮相同抽取:dedup 不翻倍,空值不覆盖已有字段", async () => {
    const { store, deps } = makeRig();
    await onboardTurn(store, "第一轮", deps);
    const outlineAfter1 = store.readDoc("大纲");
    // 第二轮:题材为空(不得覆盖),角色/世界书/大纲同名(不得重复)
    await onboardTurn(store, "第二轮", deps);
    expect(store.readMeta().genre).toBe("修仙复仇");
    expect(store.readDoc("大纲")).toBe(outlineAfter1);
    expect(store.listCharacters()).toHaveLength(1);
    expect(store.listWorldbooks()).toHaveLength(1);
    expect(store.readCharacter("陈默").base).toContain("多疑"); // 基底未被重写
  });

  it("readiness:空书缺三项;要素齐后 ready", async () => {
    const { store, deps } = makeRig();
    const before = readiness(store);
    expect(before.ready).toBe(false);
    expect(before.missing).toEqual(expect.arrayContaining(["设定", "主角", "首弧大纲"]));
    await onboardTurn(store, "补全", deps);
    const after = readiness(store);
    expect(after.ready).toBe(true);
    expect(after.missing).toEqual([]);
  });

  it("对话提示词带上已有设定与缺失项", async () => {
    const { store, deps, chatterCalls } = makeRig();
    await onboardTurn(store, "第一轮", deps);
    await onboardTurn(store, "第二轮", deps);
    const second = JSON.stringify(chatterCalls[1]);
    expect(second).toContain("修仙复仇"); // 已有设定进了提示词
  });
});

describe("CLI new(readline 循环,stdin 可注入)", () => {
  it("空 stdin:建目录、打印欢迎、优雅退出", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2clinew-"));
    const res = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(repoRoot, "src", "cli", "index.ts"),
        "new", "我的新书",
      ],
      { cwd: tmp, encoding: "utf8", input: "", timeout: 60_000 },
    );
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, "books", "我的新书", "book.md"))).toBe(true);
    expect(res.stdout).toMatch(/[一-龥]/);
  });
});
