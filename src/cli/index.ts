#!/usr/bin/env node
import { Command, type Help } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfigFrom, type LoadedConfig } from "./../config.js";
import { modelFor, embeddingModelFor } from "./../llm/provider.js";
import { streamCall, generateCall } from "./../llm/call.js";
import { recordUsage, summarizeUsage } from "./../llm/usage.js";
import { BookStore } from "./../store/book.js";
import { initRepo } from "./../store/git.js";
import { loadIndex, rebuildIndex } from "./../memory/index.js";
import { retrieve } from "./../memory/retrieve.js";
import { writeChapter, type WriteDeps } from "./../engine/write.js";
import type { Usage } from "./../types.js";

// ---------- 通用 ----------

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function resolveBook(name: string): BookStore {
  const dir = path.join(process.cwd(), "books", name);
  if (!fs.existsSync(path.join(dir))) {
    fail(`找不到书「${name}」,应位于 ${dir}(book_not_found)`);
  }
  return new BookStore(dir);
}

function loadConfig(): LoadedConfig {
  return loadConfigFrom(process.cwd());
}

/** DeepSeek 系价目(美元/百万 token)估算;未知模型按同价记,账本只求量级正确。 */
const PRICE = { promptMiss: 0.28, promptCacheHit: 0.028, completion: 0.42 };

function costOf(usage: Usage): number {
  const miss = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (
    (miss * PRICE.promptMiss +
      usage.cachedTokens * PRICE.promptCacheHit +
      usage.completionTokens * PRICE.completion) / 1_000_000
  );
}

/** 生产 deps 装配:config → 各角色模型 → usage 记账。 */
function buildDeps(store: BookStore, loaded: LoadedConfig): WriteDeps {
  const writerModel = modelFor(loaded, "writer");
  const plannerModel = modelFor(loaded, "planner");
  const extractorModel = modelFor(loaded, "extractor");
  const modelIdOf = (role: "writer" | "planner" | "extractor") =>
    ({ writer: writerModel, planner: plannerModel, extractor: extractorModel })[role].modelId;

  return {
    planner: (input) => generateCall({ model: plannerModel, messages: input.messages, ...(input.onUsage ? { onUsage: input.onUsage } : {}) }),
    writer: (input) => streamCall({ model: writerModel, messages: input.messages, ...(input.onUsage ? { onUsage: input.onUsage } : {}) }),
    extractor: (input) => generateCall({ model: extractorModel, messages: input.messages, ...(input.onUsage ? { onUsage: input.onUsage } : {}) }),
    retrieve,
    embedder: embeddingModelFor(loaded),
    config: loaded.config,
    onUsage: (role, usage) => {
      recordUsage(store.dir, {
        role,
        model: modelIdOf(role === "planner" ? "planner" : role === "writer" ? "writer" : "extractor"),
        usage,
        costUsd: costOf(usage),
      });
    },
    onDelta: (delta) => process.stdout.write(delta),
  };
}

/** 单次 run 预算检查(SPEC §5):历史章均成本 × 本次章数,超 singleBudgetUsd 拒绝。 */
function checkBudget(store: BookStore, loaded: LoadedConfig, chapterCount: number): void {
  const summary = summarizeUsage(store.dir);
  const written = store.listChapters().length;
  if (written === 0 || summary.totalCostUsd === 0) return;
  const estimate = (summary.totalCostUsd / written) * chapterCount;
  if (estimate > loaded.config.singleBudgetUsd) {
    fail(
      `本次预计成本 $${estimate.toFixed(2)} 超过单次预算 $${loaded.config.singleBudgetUsd}(config.json singleBudgetUsd),已拒绝(budget_exceeded)`,
    );
  }
}

function parseRange(raw: string): { from: number; to: number } {
  const m = /^(\d+)(?:\.\.(\d+))?$/.exec(raw.trim());
  if (!m) fail(`章号「${raw}」格式不对,应为 5 或 5..30(bad_chapter_range)`);
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from < 1 || to < from) fail(`章号范围「${raw}」不合法(bad_chapter_range)`);
  return { from, to };
}

// ---------- 命令 ----------

const program = new Command();

program
  .name("scribe")
  .description("长篇小说写作引擎:文件即记忆,检索即注入,提示词一等公民")
  .usage("[选项] [命令]")
  .helpOption("-h, --help", "显示帮助")
  .version("0.1.0", "-V, --version", "输出版本号")
  .helpCommand("help [命令]", "显示指定命令的帮助")
  .configureHelp({
    formatHelp: (cmd, helper: Help) => {
      const pad = (s: string) => `  ${s.padEnd(30)}`;
      const lines: string[] = [`用法:${cmd.name()} ${cmd.usage()}`, ""];
      const description = helper.commandDescription(cmd);
      if (description) lines.push(description, "");
      const commands = helper.visibleCommands(cmd);
      if (commands.length) {
        lines.push("命令:");
        for (const c of commands) lines.push(pad(helper.subcommandTerm(c)) + helper.subcommandDescription(c));
        lines.push("");
      }
      const args = helper.visibleArguments(cmd);
      if (args.length) {
        lines.push("参数:");
        for (const a of args) lines.push(pad(helper.argumentTerm(a)) + helper.argumentDescription(a));
        lines.push("");
      }
      lines.push("选项:");
      for (const o of helper.visibleOptions(cmd)) lines.push(pad(helper.optionTerm(o)) + helper.optionDescription(o));
      return `${lines.join("\n")}\n`;
    },
  });

program
  .command("write")
  .description("写作:单章(5)或连写(5..30),-m 附加本章指令")
  .argument("<书名>", "books/ 下的书目录名")
  .argument("<章号>", "如 5 或 5..30")
  .option("-m, --message <指令>", "本章写作指令", "")
  .action(async (bookName: string, rangeRaw: string, opts: { message: string }) => {
    const store = resolveBook(bookName);
    const { from, to } = parseRange(rangeRaw);
    const loaded = loadConfig();
    checkBudget(store, loaded, to - from + 1);
    if (!fs.existsSync(path.join(store.dir, ".git"))) initRepo(store.dir);
    if (loadIndex(store).length === 0) {
      console.log("索引为空,先重建……");
      await rebuildIndex(store, embeddingModelFor(loaded));
    }
    const deps = buildDeps(store, loaded);
    for (let no = from; no <= to; no++) {
      console.log(`\n—— 第 ${no} 章 ——`);
      const result = await writeChapter(store, no, opts.message, deps);
      console.log(
        `\n✔ 第 ${no} 章完成:${result.text.length} 字` +
          (result.rewritten ? "(经一次带因重写)" : "") +
          (result.dropped.length ? `,预算裁剪:${result.dropped.join("、")}` : ""),
      );
    }
  });

program
  .command("status")
  .description("书籍状态:章数/成本/各角色调用/索引健康")
  .argument("<书名>", "books/ 下的书目录名")
  .action((bookName: string) => {
    const store = resolveBook(bookName);
    const meta = store.readMeta();
    const chapters = store.listChapters();
    const usage = summarizeUsage(store.dir);
    const index = loadIndex(store);
    console.log(`书名:${meta.name}`);
    if (meta.genre) console.log(`题材:${meta.genre}`);
    if (meta.pov) console.log(`视角:${meta.pov}`);
    console.log(`章节:${chapters.length} 章${chapters.length ? `(最新 第${chapters.at(-1)}章)` : ""}`);
    console.log(`开放问题:${store.listOpenIssues().length} 条`);
    console.log(`记忆索引:${index.length} 条${index.length === 0 ? "(空,建议先 reindex)" : ""}`);
    console.log(`成本合计:$${usage.totalCostUsd.toFixed(4)}`);
    for (const [role, s] of Object.entries(usage.byRole)) {
      console.log(`  ${role}:${s.calls} 次调用,$${s.costUsd.toFixed(4)},缓存命中 ${s.cachedTokens} tok`);
    }
  });

program
  .command("reindex")
  .description("重建记忆索引(.index/chunks.jsonl)")
  .argument("<书名>", "books/ 下的书目录名")
  .action(async (bookName: string) => {
    const store = resolveBook(bookName);
    let embedder = null;
    try {
      embedder = embeddingModelFor(loadConfig());
    } catch {
      console.log("未读到可用配置,以无向量模式重建(关键词+时近检索)。");
    }
    const chunks = await rebuildIndex(store, embedder);
    console.log(`索引已重建:${chunks.length} 条记忆块${embedder ? "(含向量)" : "(无向量,关键词+时近模式)"}`);
  });

program.parseAsync().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e));
});
