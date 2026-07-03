import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { summarizeUsage } from "../../src/llm/usage.js";
import { log } from "../../src/store/git.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = path.join(repoRoot, "src", "cli", "index.ts");
const fixtureDir = path.join(repoRoot, "tests", "fixtures", "demo-book");

const CONFIG = {
  providers: { deepseek: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" } },
  roles: { writer: { provider: "deepseek", modelId: "deepseek-chat" } },
  deepestPromptScope: "creative",
  singleBudgetUsd: 5,
};

function runCli(cwd: string, args: string[]) {
  const res = spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 240_000,
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`CLI 失败(${args.join(" ")}):\n${res.stdout}\n${res.stderr}`);
  }
  return res;
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)("Gate C: 首次真写作(模拟人类剧本)", () => {
  it("写第1章(带指令)→ 写第2章(纯大纲驱动),记忆闭环成立", { timeout: 600_000 }, () => {
    // 剧本步 1:布置书房 —— fixture 复制到 tmp books/,目标字数压到 1200
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "s2gateC-"));
    const bookDir = path.join(root, "books", "演示书");
    fs.cpSync(fixtureDir, bookDir, { recursive: true });
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
    const store = new BookStore(bookDir);
    store.writeMeta({ targetWords: 1200 });
    const foreshadowsBefore = new Set(store.listForeshadows().map((f) => f.label));
    const charactersBefore = new Set(store.listCharacters().map((c) => c.name));
    const recordsBefore = JSON.stringify(store.readRecords());
    const stateBefore = store.readCharacter("林尘").state;

    // 剧本步 2:如人类般敲命令写第 1 章
    const res1 = runCli(root, ["write", "演示书", "1", "-m", "林尘初到黑水镇,结尾埋一个陌生人跟踪的钩子"]);
    console.log(`[live] 第1章 CLI 输出尾部:${res1.stdout.slice(-200)}`);

    // 剧本步 3:机器断言第 1 章
    const ch1 = store.readChapter(1);
    expect(ch1.text.length).toBeGreaterThanOrEqual(800);
    expect(ch1.text.slice(-30)).not.toMatch(/待续|未完|下一章/);
    // fixture 设第一人称;与 lint 契约一致:首两段至少一段有「我」
    expect(ch1.text.split(/\n\s*\n/).slice(0, 2).join("")).toContain("我");
    expect(store.readSummary(1).paragraph.length).toBeGreaterThan(0);
    const recordsChanged = JSON.stringify(store.readRecords()) !== recordsBefore;
    const stateChanged = store.readCharacter("林尘").state !== stateBefore;
    expect(recordsChanged || stateChanged, "状态.md 或主角状态应有变化").toBe(true);
    const usage = summarizeUsage(bookDir);
    for (const role of ["planner", "writer", "extractor"]) {
      expect(usage.byRole[role]?.calls, role).toBeGreaterThanOrEqual(1);
    }
    expect(log(bookDir).some((e) => e.message.startsWith("ch001"))).toBe(true);

    // 第 1 章抽取产出的新实体(伏笔 label / 新角色)
    const newEntities = [
      ...store.listForeshadows().map((f) => f.label).filter((l) => !foreshadowsBefore.has(l)),
      ...store.listCharacters().map((c) => c.name).filter((n) => !charactersBefore.has(n)),
    ];
    console.log(`[live] 第1章新实体:${newEntities.join("、") || "(无)"}`);
    expect(newEntities.length, "指令明确要求埋钩子,extractor 应产出新实体").toBeGreaterThan(0);

    // 剧本步 4:第 2 章无指令,纯大纲驱动;
    // 检索闭环 = 新实体在第 2 章正文/摘要、或其规划(CLI 输出里的规划行)中出现
    const res2 = runCli(root, ["write", "演示书", "2"]);
    const ch2 = store.readChapter(2);
    const ch2Corpus =
      ch2.text + store.readSummary(2).paragraph + store.readSummary(2).brief + res2.stdout;
    const hit = newEntities.find((e) => {
      const clean = e.replace(/[((].*[))]/, "").trim();
      return ch2Corpus.includes(clean) || ch2Corpus.includes(clean.slice(0, 4)) || ch2Corpus.includes(clean.slice(0, 3));
    });
    console.log(`[live] 检索闭环命中实体:${hit ?? "(未命中)"}`);
    expect(hit, `第2章应提及第1章埋的实体之一(候选:${newEntities.join("、")})`).toBeTruthy();

    console.log(`[live] 书目录:${bookDir}`);
    console.log(`[live] 成本合计:$${usage.totalCostUsd.toFixed(4)}`);
  });
});
