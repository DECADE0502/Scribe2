import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { readiness } from "../../src/engine/onboard.js";
import { summarizeUsage } from "../../src/llm/usage.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = path.join(repoRoot, "src", "cli", "index.ts");

const CONFIG = {
  providers: { deepseek: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" } },
  roles: { writer: { provider: "deepseek", modelId: "deepseek-chat" } },
  deepestPromptScope: "creative",
  singleBudgetUsd: 5,
};

function runCli(cwd: string, args: string[], opts: { input?: string; timeout?: number; allowFail?: boolean } = {}) {
  const res = spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: opts.timeout ?? 300_000,
    env: process.env,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`CLI 失败(${args.join(" ")}):\n${res.stdout}\n${res.stderr}`);
  }
  return res;
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)("Gate D: 全流程 live 剧本(真 DeepSeek)", () => {
  it("new+onboard三轮 → 连写1..6(护栏) → chat → audit → revise → status", { timeout: 1_800_000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "s2gateD-"));
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(CONFIG), "utf8");
    const bookDir = path.join(root, "books", "测试书");

    // —— 步 1:scribe new + 三轮罐头 onboard ——
    console.log("[live] 步1:scribe new 测试书(三轮建书对话)");
    const onboardLines = [
      "都市异能复仇文,主角陈默,一个在旧书店打工的青年,父亲三年前死于一场被定性为意外的火灾",
      "第一人称,目标50章;世界观:灵气复苏后的现代都市,异能者由『异管局』暗中管理,普通人不知情",
      "第一卷就写陈默觉醒『过目不忘』异能、进入异管局外围、查出父亲死因不是意外,就这样,开始吧",
    ].join("\n");
    runCli(root, ["new", "测试书"], { input: `${onboardLines}\n`, timeout: 600_000 });
    const store = new BookStore(bookDir);
    let r = readiness(store);
    // 兜底(抽取有 LLM 方差):缺什么就逐项用可确认的原话重述,最多两轮
    const restate: Record<string, string> = {
      设定: "世界观确认:灵气复苏后的现代都市,异能者由『异管局』暗中管理,普通人毫不知情",
      主角: "主角确认:陈默,旧书店打工的青年,父亲三年前死于被定性为意外的火灾",
      首弧大纲: "第一卷大纲确认:第一幕陈默觉醒『过目不忘』被异管局盯上;第二幕混入档案室拼出父亲死前最后任务;第三幕遭灭口袭击,证实父亲之死不是意外",
    };
    for (let attempt = 0; !r.ready && attempt < 2; attempt++) {
      console.log(`[live] 还缺:${r.missing.join("、")},补第 ${attempt + 1} 轮`);
      const line = `${r.missing.map((m) => restate[m] ?? "").filter(Boolean).join(";")}。就这么定稿,开始吧`;
      runCli(root, ["onboard", "测试书"], { input: `${line}\n`, timeout: 300_000 });
      r = readiness(store);
    }
    expect(r.ready, `readiness 应为 ready,仍缺:${r.missing.join("、")}`).toBe(true);
    expect(store.listCharacters().length).toBeGreaterThan(0);
    expect(store.readDoc("设定").trim().length).toBeGreaterThan(0);
    expect(store.readDoc("大纲").trim().length).toBeGreaterThan(0);
    console.log(`[live] onboard 完成:角色 ${store.listCharacters().map((c) => c.name).join("、")}`);

    // 控成本:目标字数压到 1200
    store.writeMeta({ targetWords: 1200 });

    // —— 步 2:连写 1..6(第 5 章触发护栏)——
    console.log("[live] 步2:write 测试书 1..6(连写+护栏)");
    const writeRes = runCli(root, ["write", "测试书", "1..6"], { timeout: 1_200_000, allowFail: true });
    console.log(`[live] 连写结果:${writeRes.stdout.match(/[⚠✔] 连写[^\n]*/)?.[0] ?? writeRes.stdout.slice(-120)}`);
    // 停下时报告必须可读,然后按范围续写(范围模式才会在第 5 章触发护栏)
    if (!store.listChapters().includes(6)) {
      expect(writeRes.stdout).toMatch(/停在|失败/);
      for (let attempt = 0; !store.listChapters().includes(6) && attempt < 4; attempt++) {
        const next = (store.listChapters().at(-1) ?? 0) + 1;
        console.log(`[live] 续写 ${next}..6`);
        const res = runCli(root, ["write", "测试书", next === 6 ? "6" : `${next}..6`], {
          timeout: 1_200_000, allowFail: true,
        });
        if ((store.listChapters().at(-1) ?? 0) < next) {
          throw new Error(`续写无进展:\n${res.stdout.slice(-400)}\n${res.stderr.slice(-400)}`);
        }
      }
    }
    expect(store.listChapters()).toEqual([1, 2, 3, 4, 5, 6]);
    const usage = summarizeUsage(bookDir);
    expect(usage.byRole["auditor"]?.calls, "护栏 auditor 应有 usage 行").toBeGreaterThanOrEqual(1);

    // —— 步 3:chat 提及近况实体 ——
    console.log("[live] 步3:chat");
    const chatRes = runCli(root, ["chat", "测试书", "主角现在什么处境?"], { timeout: 300_000 });
    console.log(`[live] chat 回答:${chatRes.stdout.slice(0, 160)}`);
    expect(chatRes.stdout).toContain("陈默");

    // —— 步 4:audit ——
    console.log("[live] 步4:audit");
    const auditRes = runCli(root, ["audit", "测试书"], { timeout: 600_000 });
    expect(auditRes.stdout).toMatch(/未发现|审查|critical|warning|严重|提醒/);
    expect(fs.existsSync(path.join(bookDir, "问题.md"))).toBe(true);

    // —— 步 5:revise 第 6 章某段,diff 只动该段 ——
    console.log("[live] 步5:revise 第 6 章");
    const ch6Before = store.readChapter(6).text;
    const sentence = ch6Before.split(/(?<=。)/).find((s) => s.trim().length >= 12 && s.trim().length <= 80)!.trim();
    const idx = ch6Before.indexOf(sentence);
    runCli(root, ["revise", "测试书", "6", "--find", sentence, "-m", "把这句写得更有压迫感"], { timeout: 300_000 });
    const ch6After = store.readChapter(6).text;
    expect(ch6After).not.toBe(ch6Before);
    expect(ch6After.startsWith(ch6Before.slice(0, idx))).toBe(true); // 选段之前逐字未动
    expect(ch6After.endsWith(ch6Before.slice(idx + sentence.length))).toBe(true); // 选段之后逐字未动

    // —— 步 6:status ——
    console.log("[live] 步6:status");
    const statusRes = runCli(root, ["status", "测试书"], { timeout: 120_000 });
    console.log(statusRes.stdout);
    expect(statusRes.stdout).toContain("章节:6 章");
    expect(statusRes.stdout).toMatch(/成本合计:\$0\.\d*[1-9]/); // >0
    for (const role of ["writer", "planner", "extractor", "auditor"]) {
      expect(statusRes.stdout).toContain(role);
    }
    console.log(`[live] 全流程完成,总成本 $${summarizeUsage(bookDir).totalCostUsd.toFixed(4)},书目录:${bookDir}`);
  });
});
