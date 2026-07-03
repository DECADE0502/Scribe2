#!/usr/bin/env node
import { Command, type Help } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfigFrom, type LoadedConfig } from "./../config.js";
import { embeddingModelFor } from "./../llm/provider.js";
import { summarizeUsage } from "./../llm/usage.js";
import { BookStore } from "./../store/book.js";
import { initRepo, commitAll } from "./../store/git.js";
import { loadIndex, rebuildIndex } from "./../memory/index.js";
import { retrieve } from "./../memory/retrieve.js";
import { writeChapter } from "./../engine/write.js";
import { onboardTurn, readiness } from "./../engine/onboard.js";
import { chatTurn, type ChatDeps } from "./../engine/chat.js";
import { runAudit } from "./../engine/audit.js";
import { reviseSegment } from "./../engine/revise.js";
import { writeMany, fixLatest } from "./../engine/many.js";
import { importSillyTavern } from "./../import/sillytavern.js";
import { exportBook, exportChapter, rollbackBook, type ExportFormat } from "./../engine/export.js";
import { buildDeps as buildBaseDeps, type AppDeps } from "./../deps.js";
import * as readline from "node:readline";

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

/** CLI 版 deps = 共享装配 + 终端打印(规划行 / 流式 delta)。 */
function buildDeps(store: BookStore, loaded: LoadedConfig): AppDeps {
  return {
    ...buildBaseDeps(store, loaded),
    onPlan: (plan) => {
      console.log(
        `规划:${plan.goal}\n  出场:${plan.charactersOnStage.join("、") || "-"}` +
          `|触碰伏笔:${plan.foreshadowToTouch.join("、") || "-"}|检索词:${plan.queryTerms.join("、") || "-"}`,
      );
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

/**
 * 输入行来源:TTY 走 readline 交互(带提示符);管道/重定向则整读 stdin 逐行产出——
 * readline 的 prompt() 在管道 EOF 后会抛 "readline was closed",且慢轮次里易丢后续行。
 */
async function* inputLines(promptLabel: string): AsyncGenerator<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    for (const line of Buffer.concat(chunks).toString("utf8").split(/\r?\n/)) yield line;
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(promptLabel);
  rl.prompt();
  try {
    for await (const line of rl) {
      yield line;
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

async function onboardLoop(store: BookStore): Promise<void> {
  const first = readiness(store);
  console.log(
    first.ready
      ? "底子已齐,可以直接开写;也可以继续补充设定。"
      : `建书对话开始,还缺:${first.missing.join("、")}。`,
  );
  console.log("一行一轮;输入「退出」或 Ctrl+C 结束。");
  for await (const line of inputLines("你:")) {
    const message = line.trim();
    if (!message || message === "退出" || message === "exit") break;
    const deps = buildDeps(store, loadConfig());
    process.stdout.write("小克:");
    const result = await onboardTurn(store, message, {
      chatter: deps.chatter,
      extractor: deps.extractor,
      embedder: deps.embedder,
      config: deps.config,
      ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
      onDelta: (d) => process.stdout.write(d),
    });
    console.log(
      `\n${result.readiness.ready ? "✓ 底子齐了,可以开写:scribe write <书> 1" : `还缺:${result.readiness.missing.join("、")}`}`,
    );
  }
  console.log("建书对话结束。");
}

program
  .command("new")
  .description("建书:落目录骨架并进入建书对话")
  .argument("<书名>", "新书名称")
  .action(async (bookName: string) => {
    const dir = path.join(process.cwd(), "books", bookName);
    if (!fs.existsSync(path.join(dir, "book.md"))) {
      BookStore.create(dir, { name: bookName });
      initRepo(dir);
      commitAll(dir, "init: 建库基线");
      console.log(`已建书 books/${bookName}/`);
    } else {
      console.log(`书「${bookName}」已存在,继续建书对话。`);
    }
    await onboardLoop(new BookStore(dir));
  });

program
  .command("onboard")
  .description("继续建书对话(补设定/角色/大纲)")
  .argument("<书名>", "books/ 下的书目录名")
  .action(async (bookName: string) => {
    await onboardLoop(resolveBook(bookName));
  });

program
  .command("chat")
  .description("与责编助手讨论本书(零副作用,不改任何文件)")
  .argument("<书名>", "books/ 下的书目录名")
  .argument("[消息...]", "一次性提问;省略则进入对话循环")
  .action(async (bookName: string, messageParts: string[]) => {
    const store = resolveBook(bookName);
    const deps = buildDeps(store, loadConfig());
    const chatDeps: ChatDeps = {
      chatter: deps.chatter,
      retrieve,
      embedder: deps.embedder,
      config: deps.config,
      ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
      onDelta: (d) => process.stdout.write(d),
    };
    const oneShot = (messageParts ?? []).join(" ").trim();
    if (oneShot) {
      await chatTurn(store, oneShot, chatDeps);
      console.log("");
      return;
    }
    console.log("进入对话(输入「退出」或 Ctrl+C 结束):");
    for await (const line of inputLines("你:")) {
      const message = line.trim();
      if (!message || message === "退出" || message === "exit") break;
      process.stdout.write("助手:");
      await chatTurn(store, message, chatDeps);
      console.log("");
    }
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
    if (!fs.existsSync(path.join(store.dir, ".git"))) {
      initRepo(store.dir);
      commitAll(store.dir, "init: 建库基线");
    }
    if (loadIndex(store).length === 0) {
      console.log("索引为空,先重建……");
      await rebuildIndex(store, embeddingModelFor(loaded));
    }
    const deps = buildDeps(store, loaded);
    if (from === to) {
      console.log(`\n—— 第 ${from} 章 ——`);
      const result = await writeChapter(store, from, opts.message, deps);
      console.log(
        `\n✔ 第 ${from} 章完成:${result.text.length} 字` +
          (result.rewritten ? "(经一次带因重写)" : "") +
          (result.dropped.length ? `,预算裁剪:${result.dropped.join("、")}` : ""),
      );
      return;
    }
    if (opts.message) console.log("提示:连写模式按大纲驱动,-m 指令已忽略。");
    const startCost = summarizeUsage(store.dir).totalCostUsd;
    const result = await writeMany(store, from, to, {
      ...deps,
      runBudgetUsd: loaded.config.singleBudgetUsd,
      costProbe: () => summarizeUsage(store.dir).totalCostUsd - startCost,
      onChapterStart: (no) => console.log(`\n—— 第 ${no} 章 ——`),
      onChapterDone: (no, r) => console.log(`\n✔ 第 ${no} 章完成:${r.text.length} 字`),
    });
    if (result.stoppedAt !== undefined) {
      console.log(`\n⚠ 连写停在第 ${result.stoppedAt} 章之前:${result.reason}`);
      console.log(`已完成:${result.completed.length ? result.completed.join("、") : "(无)"}`);
    } else {
      console.log(`\n✔ 连写完成:第 ${from}..${to} 章(共 ${result.completed.length} 章)`);
    }
  });

program
  .command("fix")
  .description("修复最新章:git reset 该章 commit,带 open 问题重跑写章管线")
  .argument("<书名>", "books/ 下的书目录名")
  .action(async (bookName: string) => {
    const store = resolveBook(bookName);
    const deps = buildDeps(store, loadConfig());
    const latest = store.listChapters().at(-1);
    console.log(`重写最新章(第 ${latest ?? "?"} 章)……`);
    const result = await fixLatest(store, deps);
    console.log(`\n✔ 第 ${result.chapterNo} 章已重写:${result.text.length} 字,新 commit ch${String(result.chapterNo).padStart(3, "0")}`);
  });

program
  .command("audit")
  .description("审查近 N 章的一致性问题,写入 问题.md(open)")
  .argument("<书名>", "books/ 下的书目录名")
  .option("--last <N>", "审查最近 N 章", "5")
  .action(async (bookName: string, opts: { last: string }) => {
    const store = resolveBook(bookName);
    const deps = buildDeps(store, loadConfig());
    const report = await runAudit(store, { lastN: Number(opts.last) || 5 }, {
      auditor: deps.auditor,
      retrieve,
      embedder: deps.embedder,
      config: deps.config,
      ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
    });
    console.log(report.summary || "审查完成。");
    for (const line of report.lines) console.log(line);
    if (!report.issues.length) console.log("未发现确凿问题。");
    else console.log(`已写入 问题.md:新增 ${report.added.length} 条(重复问题自动去重)。`);
  });

program
  .command("revise")
  .description("选段改写:--find 原样给出选段,-m 给改写指令")
  .argument("<书名>", "books/ 下的书目录名")
  .argument("<章号>", "要改写的章")
  .requiredOption("--find <选段>", "要重写的正文片段(原样复制)")
  .option("-m, --message <指令>", "改写指令", "")
  .option("--occurrence <序号>", "选段重复时的出现序号(0 起)")
  .action(async (bookName: string, chapterRaw: string, opts: { find: string; message: string; occurrence?: string }) => {
    const store = resolveBook(bookName);
    const { from } = parseRange(chapterRaw);
    const deps = buildDeps(store, loadConfig());
    const result = await reviseSegment(
      store,
      {
        chapterNo: from,
        selected: opts.find,
        instruction: opts.message,
        ...(opts.occurrence !== undefined ? { occurrenceIndex: Number(opts.occurrence) } : {}),
      },
      {
        rewriter: deps.writer,
        config: deps.config,
        ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
        onDelta: (d) => process.stdout.write(d),
      },
    );
    console.log(`\n✔ 第 ${from} 章选段已改写(新段 ${result.newSegment.length} 字),commit ch${String(from).padStart(3, "0")}-revise`);
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
    const ready = readiness(store);
    console.log(`书名:${meta.name}`);
    console.log(`就绪度:${ready.ready ? "✓ 可写作" : `未就绪,还缺 ${ready.missing.join("、")}`}`);
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
  .command("import")
  .description("导入 SillyTavern 角色卡/世界书 JSON")
  .argument("<书名>", "books/ 下的书目录名")
  .argument("<文件>", "SillyTavern 导出的 .json 文件路径")
  .action(async (bookName: string, file: string) => {
    const store = resolveBook(bookName);
    if (!fs.existsSync(file)) fail(`找不到文件 ${file}(file_not_found)`);
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fail(`${file} 不是合法 JSON(invalid_json)`);
    }
    let embedder = null;
    try {
      embedder = embeddingModelFor(loadConfig());
    } catch {
      /* 无配置也能导入,只是不做向量 */
    }
    const report = await importSillyTavern(store, embedder, json);
    if (fs.existsSync(path.join(store.dir, ".git"))) {
      commitAll(store.dir, `import: ${path.basename(file)}`);
    }
    console.log(
      `导入完成(${report.type === "character" ? "角色卡" : "世界书"}):角色 ${report.imported.characters} 个,世界书 ${report.imported.worldbooks} 条`,
    );
    for (const w of report.warnings) console.log(`  提醒:${w}`);
  });

program
  .command("export")
  .description("导出全书或单章(默认 md,--txt 纯文本)")
  .argument("<书名>", "books/ 下的书目录名")
  .option("--txt", "导出为纯文本", false)
  .option("--chapter <章号>", "只导出这一章")
  .option("-o, --out <文件>", "输出文件路径(默认 <书名>.md/.txt)")
  .action((bookName: string, opts: { txt: boolean; chapter?: string; out?: string }) => {
    const store = resolveBook(bookName);
    const format: ExportFormat = opts.txt ? "txt" : "md";
    const content = opts.chapter
      ? exportChapter(store, parseRange(opts.chapter).from, format)
      : exportBook(store, format);
    const outFile = path.resolve(opts.out ?? `${bookName}${opts.chapter ? `-第${opts.chapter}章` : ""}.${format}`);
    fs.writeFileSync(outFile, content, "utf8");
    console.log(`已导出 ${content.length} 字 → ${outFile}`);
  });

program
  .command("rollback")
  .description("回滚:reset 到指定章的 commit 之前(正文与记忆级联回退,自动重建索引)")
  .argument("<书名>", "books/ 下的书目录名")
  .argument("<章号>", "回滚点:该章及其后全部撤销")
  .action(async (bookName: string, chapterRaw: string) => {
    const store = resolveBook(bookName);
    const { from } = parseRange(chapterRaw);
    let embedder = null;
    try {
      embedder = embeddingModelFor(loadConfig());
    } catch {
      /* 无配置则无向量重建 */
    }
    await rollbackBook(store, from, embedder);
    const chapters = store.listChapters();
    console.log(`已回滚到第 ${from} 章之前;当前章数 ${chapters.length}${chapters.length ? `(最新 第${chapters.at(-1)}章)` : ""},索引已重建`);
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
