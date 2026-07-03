import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { initRepo, commitAll, log } from "../../src/store/git.js";
import { rebuildIndex, loadIndex } from "../../src/memory/index.js";
import { retrieve } from "../../src/memory/retrieve.js";
import { writeChapter, type WriteDeps } from "../../src/engine/write.js";
import type { StreamEvent, Usage } from "../../src/types.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "fixtures", "demo-book");

const PLAN_JSON = JSON.stringify({
  goal: "林尘到镖局对质赵三",
  scenes: ["场景1:镖局后院,林尘出示拓文", "场景2:赵三吐露镖单一角"],
  charactersOnStage: ["林尘", "赵三"],
  foreshadowToTouch: ["黑剑来历"],
  queryTerms: ["镖局", "黑剑", "灭门夜火"],
});

const EXTRACT_JSON = JSON.stringify({
  characterStates: { 林尘: "拿到镖单残页,确认纵火者有修为在身;决意离镇。" },
  records: { 境界: "炼气四层(临近突破)" },
  newForeshadow: [{ label: "镖单残页", description: "残页上的货主签押是个变体古字", relatedCharacters: ["赵三"] }],
  foreshadowPaid: ["赵三的秘密"],
  timeline: [{ storyTime: "第十日午", event: "林尘与赵三对质,取得镖单残页", participants: ["林尘", "赵三"] }],
  summary: {
    oneLiner: "对质赵三,取得镖单残页。",
    paragraph: "林尘以断碑拓文逼赵三摊牌,赵三交出当年镖单的残页,货主签押是变体古字。",
    keyEvents: [{ event: "取得镖单残页", characters: ["林尘", "赵三"], foreshadowingRefs: ["赵三的秘密"] }],
  },
});

const 千字正文 = "我把拓文拍在桌上。赵三的脸色变了又变,终于把当年的镖单残页推了过来。".repeat(30);

function usage(): Usage {
  return { promptTokens: 10, completionTokens: 10, cachedTokens: 0 };
}

async function* streamOf(text: string, onUsage?: (u: Usage) => void): AsyncGenerator<StreamEvent> {
  yield { type: "text_delta", delta: text.slice(0, 5) };
  yield { type: "text_delta", delta: text.slice(5) };
  onUsage?.(usage());
}

interface RigOptions {
  writerTexts?: string[]; // 按调用次序吐的正文
  writerError?: boolean;
  extractorFails?: boolean;
}

async function makeRig(opts: RigOptions = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2write-")), "演示书");
  fs.cpSync(fixtureDir, dir, { recursive: true });
  const store = new BookStore(dir);
  initRepo(dir);
  commitAll(dir, "init");
  await rebuildIndex(store, null);

  const writerCalls: Array<{ messages: unknown }> = [];
  const texts = opts.writerTexts ?? [千字正文];
  let writerCallNo = 0;

  const onUsage = vi.fn();
  const retrieveSpy = vi.fn(retrieve);
  const compressor = vi.fn(async (input: { messages: unknown; onUsage?: (u: Usage) => void }) => {
    input.onUsage?.(usage());
    return { text: "弧2纲要:黑水镇线收束,林尘取得镖单残页并离镇南下。" };
  });

  const deps: WriteDeps = {
    planner: async (input) => {
      input.onUsage?.(usage());
      return { text: PLAN_JSON };
    },
    writer: (input) => {
      writerCalls.push({ messages: input.messages });
      const idx = writerCallNo++;
      if (opts.writerError) {
        return (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: "text_delta", delta: "半截" };
          throw new Error("stream boom");
        })();
      }
      return streamOf(texts[Math.min(idx, texts.length - 1)]!, input.onUsage);
    },
    extractor: async (input) => {
      input.onUsage?.(usage());
      if (opts.extractorFails) throw new Error("extract boom");
      return { text: EXTRACT_JSON };
    },
    compressor,
    retrieve: retrieveSpy,
    embedder: null,
    config: {
      providers: { ds: { baseUrl: "x", apiKeyEnv: "K" } },
      roles: { writer: { provider: "ds", modelId: "m" } },
      deepestPromptScope: "creative",
      singleBudgetUsd: 5,
    },
    onUsage,
  };
  return { dir, store, deps, onUsage, retrieveSpy, writerCalls, compressor };
}

function gitClean(dir: string): boolean {
  return log(dir).length === 1 && !fs.readdirSync(path.join(dir, "章节")).some((f) => f.includes("005"));
}

describe("writeChapter 六步管线", () => {
  it("1) 幸福路径:正文/摘要/状态/伏笔/时间线落盘,索引更新,commit ch005,onUsage×3", async () => {
    const { dir, store, deps, onUsage } = await makeRig();
    const result = await writeChapter(store, 5, "让赵三交出镖单", deps);

    expect(result.text.length).toBeGreaterThan(800);
    expect(store.readChapter(5).text).toBe(result.text);
    expect(store.readSummary(5).brief).toContain("镖单残页");
    expect(store.readCharacter("林尘").state).toContain("镖单残页");
    expect(store.readRecords()["境界"]).toContain("临近突破");
    expect(store.listForeshadows().find((f) => f.label === "镖单残页")).toBeTruthy();
    expect(store.listForeshadows().find((f) => f.label === "赵三的秘密")!.status).toBe("paid");
    expect(store.listTimeline().some((t) => t.event.includes("镖单残页"))).toBe(true);

    const index = loadIndex(store);
    expect(index.some((c) => c.id === "summary:5")).toBe(true);
    expect(index.find((c) => c.id === "character_state:林尘")!.text).toContain("镖单残页");

    expect(log(dir)[0]!.message).toMatch(/^ch005/);
    expect(onUsage.mock.calls.map((c) => c[0]).sort()).toEqual(["extractor", "planner", "writer"]);
  });

  it("2) planner 的 queryTerms 真的传给了 retrieve", async () => {
    const { store, deps, retrieveSpy } = await makeRig();
    await writeChapter(store, 5, "", deps);
    const arg = retrieveSpy.mock.calls[0]![0];
    expect(arg.query.entities).toEqual(expect.arrayContaining(["镖局", "黑剑", "灭门夜火"]));
    expect(arg.query.charactersOnStage).toEqual(expect.arrayContaining(["林尘", "赵三"]));
    expect(arg.currentChapter).toBe(5);
  });

  it("3) writer 流中 error → 抛出,无文件落盘、无 commit", async () => {
    const { dir, store, deps } = await makeRig({ writerError: true });
    await expect(writeChapter(store, 5, "", deps)).rejects.toThrow(/stream boom/);
    expect(gitClean(dir)).toBe(true);
    // fixture 预置的第 5 章前情摘要未被覆写
    expect(store.readSummary(5).brief).toContain("断碑铭文");
  });

  it("4a) lint 失败自动带因重写:第二次成功", async () => {
    const { store, deps, writerCalls } = await makeRig({ writerTexts: ["太短的稿子。", 千字正文] });
    await writeChapter(store, 5, "", deps);
    expect(writerCalls).toHaveLength(2);
    expect(JSON.stringify(writerCalls[1]!.messages)).toContain("too_short");
    expect(store.readChapter(5).text.length).toBeGreaterThan(800);
  });

  it("4b) 两次都违规 → 抛错且留稿 章节/005.draft.md,不 commit", async () => {
    const { dir, store, deps } = await makeRig({ writerTexts: ["太短。", "还是太短。"] });
    await expect(writeChapter(store, 5, "", deps)).rejects.toThrow(/lint_failed/);
    const draft = path.join(store.dir, "章节", "005.draft.md");
    expect(fs.existsSync(draft)).toBe(true);
    expect(fs.readFileSync(draft, "utf8")).toContain("还是太短");
    expect(log(dir)[0]!.message).toBe("init");
  });

  it("5) extractor 抛错 → 正文不落盘不 commit,git 干净", async () => {
    const { dir, store, deps } = await makeRig({ extractorFails: true });
    await expect(writeChapter(store, 5, "", deps)).rejects.toThrow(/extract boom/);
    expect(gitClean(dir)).toBe(true);
  });

  it("6) 第10章写完触发弧压缩:弧/001.md 被压缩产出覆写(而非追加新弧)", async () => {
    const { store, deps, compressor } = await makeRig();
    // fixture 已有 1-4 章 + 弧1、弧2;补 5-9 章摘要,再写第 10 章
    for (let n = 5; n <= 9; n++) {
      store.writeChapter(n, `第${n}章占位正文。`.repeat(60), `占位${n}`);
      store.writeSummary(n, { brief: `第${n}章简述。`, paragraph: `第${n}章段落摘要。`, events: [] });
    }
    await writeChapter(store, 10, "", deps);
    expect(compressor).toHaveBeenCalledTimes(1);
    expect(store.readArc(1)).toContain("镖单残页"); // 压缩产出
    expect(store.readArc(1)).not.toContain("以药铺为掩护"); // fixture 旧弧1已被覆写
  });

  it("6b) 弧文件缺失(此前压缩失败)→ 第10章写完自动补齐;压缩抛错不阻断成章", async () => {
    const { dir, store, deps, compressor } = await makeRig();
    for (let n = 5; n <= 9; n++) {
      store.writeChapter(n, `第${n}章占位正文。`.repeat(60), `占位${n}`);
      store.writeSummary(n, { brief: `第${n}章简述。`, paragraph: `段落。`, events: [] });
    }
    // 模拟历史空洞:把 fixture 预置的弧全删掉
    for (const f of fs.readdirSync(path.join(dir, "弧"))) fs.rmSync(path.join(dir, "弧", f));
    // 压缩器第一次抛错,之后正常
    compressor.mockRejectedValueOnce(new Error("压缩临时失败"));
    await writeChapter(store, 10, "", deps);
    // 抛错被吞(警告),成章照常
    expect(log(dir)[0]!.message).toMatch(/^ch010/);
    expect(store.readChapter(10).text.length).toBeGreaterThan(800);
  });

  it("7) 落盘阶段中途失败 → 工作区整体回滚,git 干净,不留半套记忆", async () => {
    const { dir, store, deps } = await makeRig();
    // 正文/摘要/角色/状态都已写入之后,时间线写入失败(模拟磁盘故障)
    (store as { appendTimeline: unknown }).appendTimeline = () => {
      throw new Error("磁盘写入失败模拟");
    };
    await expect(writeChapter(store, 5, "", deps)).rejects.toThrow(/persist_failed/);
    // 回滚后:第 5 章正文不存在,已写的半套记忆(状态/摘要/角色)全部还原,无新 commit
    const clean = new BookStore(dir);
    expect(fs.existsSync(path.join(dir, "章节", "005.md"))).toBe(false);
    expect(clean.readRecords()["境界"]).not.toContain("临近突破");
    expect(clean.readCharacter("林尘").state).not.toContain("镖单残页");
    expect(log(dir)[0]!.message).toBe("init");
  });

  it("8) 上次 lint 双败留下的 .draft.md,在本章成功写作时被清理,不混进 commit", async () => {
    const { dir, store, deps } = await makeRig({ writerTexts: ["太短。", "又短。", 千字正文] });
    await expect(writeChapter(store, 5, "", deps)).rejects.toThrow(/lint_failed/);
    const draft = path.join(dir, "章节", "005.draft.md");
    expect(fs.existsSync(draft)).toBe(true);
    await writeChapter(store, 5, "", deps); // 第三次 writer 调用吐千字 → 成功
    expect(fs.existsSync(draft)).toBe(false);
    expect(log(dir)[0]!.message).toMatch(/^ch005/);
  });
});
