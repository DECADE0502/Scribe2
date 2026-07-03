import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as fs from "node:fs";
import * as path from "node:path";
import { BookStore } from "./../store/book.js";
import { commitAll } from "./../store/git.js";
import { loadIndex, syncIndex } from "./../memory/index.js";
import { summarizeUsage } from "./../llm/usage.js";
import { loadConfigFrom } from "./../config.js";
import { buildDeps, type AppDeps } from "./../deps.js";
import { writeChapter } from "./../engine/write.js";
import { writeMany, fixLatest } from "./../engine/many.js";
import { chatTurn } from "./../engine/chat.js";
import { runAudit } from "./../engine/audit.js";
import { reviseSegment } from "./../engine/revise.js";
import { onboardTurn, readiness } from "./../engine/onboard.js";
import type { Usage } from "./../types.js";

export interface ServerOptions {
  /** books/ 目录(每本书一个子目录) */
  booksRoot: string;
  /** deps 工厂;缺省从 booksRoot 上一级读 config.json + secrets.env */
  depsFor?: (store: BookStore) => AppDeps;
}

const pad3 = (n: number) => String(n).padStart(3, "0");

/** 文件 API 白名单:书内固定 md 文件,或 角色/世界书/章节/摘要/弧 下一层的 md。 */
const FILE_RE =
  /^(设定|记录规则|大纲|状态|伏笔|时间线|问题|book)\.md$|^(角色|世界书|章节|摘要|弧)\/[^/\\]+\.md$/;

interface RunIo {
  onUsage: (role: string, usage: Usage) => void;
  onDelta: (delta: string) => void;
}

type Runner = (
  store: BookStore,
  deps: AppDeps,
  args: Record<string, unknown>,
  io: RunIo,
) => Promise<unknown>;

/** 工作流 → engine 调用(零新逻辑),返回可 JSON 化的小结。 */
const RUNNERS: Record<string, Runner> = {
  chat: async (store, deps, args, io) => {
    const result = await chatTurn(store, String(args["message"] ?? ""), {
      chatter: deps.chatter,
      retrieve: deps.retrieve,
      embedder: deps.embedder,
      config: deps.config,
      onUsage: io.onUsage,
      onDelta: io.onDelta,
    });
    return { retrievedCount: result.retrievedCount };
  },
  write: async (store, deps, args, io) => {
    const from = Number(args["from"] ?? args["chapterNo"]);
    const to = Number(args["to"] ?? from);
    if (!Number.isInteger(from) || from < 1 || to < from) {
      throw new Error("章号参数不合法(bad_chapter_range)");
    }
    const wired = { ...deps, onUsage: io.onUsage, onDelta: io.onDelta };
    if (from === to) {
      const result = await writeChapter(store, from, String(args["instruction"] ?? ""), wired);
      return { chapterNo: from, words: result.text.length, rewritten: result.rewritten, dropped: result.dropped };
    }
    return writeMany(store, from, to, wired);
  },
  audit: async (store, deps, args, io) => {
    const report = await runAudit(store, { lastN: Number(args["lastN"] ?? 5) || 5 }, {
      auditor: deps.auditor,
      retrieve: deps.retrieve,
      embedder: deps.embedder,
      config: deps.config,
      onUsage: io.onUsage,
    });
    return { summary: report.summary, lines: report.lines, added: report.added.length };
  },
  revise: async (store, deps, args, io) => {
    const result = await reviseSegment(
      store,
      {
        chapterNo: Number(args["chapterNo"]),
        selected: String(args["selected"] ?? ""),
        instruction: String(args["instruction"] ?? ""),
        ...(args["occurrenceIndex"] !== undefined
          ? { occurrenceIndex: Number(args["occurrenceIndex"]) }
          : {}),
      },
      { rewriter: deps.writer, config: deps.config, onUsage: io.onUsage, onDelta: io.onDelta },
    );
    return { newSegmentLength: result.newSegment.length };
  },
  fix: async (store, deps, _args, io) => {
    const result = await fixLatest(store, { ...deps, onUsage: io.onUsage, onDelta: io.onDelta });
    return { chapterNo: result.chapterNo, words: result.text.length };
  },
  onboard: async (store, deps, args, io) => {
    const result = await onboardTurn(store, String(args["message"] ?? ""), {
      chatter: deps.chatter,
      extractor: deps.extractor,
      embedder: deps.embedder,
      config: deps.config,
      onUsage: io.onUsage,
      onDelta: io.onDelta,
    });
    return { readiness: result.readiness };
  },
};

export function createApp(options: ServerOptions): Hono {
  const app = new Hono();
  const depsFor =
    options.depsFor ??
    ((store: BookStore) => buildDeps(store, loadConfigFrom(path.dirname(options.booksRoot))));

  const bookDirOf = (name: string) => path.join(options.booksRoot, name);
  const hasGit = (store: BookStore) => fs.existsSync(path.join(store.dir, ".git"));

  const storeOf = (name: string): BookStore | null => {
    const dir = bookDirOf(name);
    return fs.existsSync(path.join(dir, "book.md")) ? new BookStore(dir) : null;
  };

  // —— 书列表 ——
  app.get("/api/books", (c) => {
    if (!fs.existsSync(options.booksRoot)) return c.json([]);
    const books = fs
      .readdirSync(options.booksRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => storeOf(e.name))
      .filter((s): s is BookStore => s !== null)
      .map((store) => {
        const meta = store.readMeta();
        return {
          name: meta.name,
          genre: meta.genre ?? "",
          chapters: store.listChapters().length,
          ready: readiness(store).ready,
        };
      });
    return c.json(books);
  });

  // —— 状态 ——
  app.get("/api/books/:book/status", (c) => {
    const store = storeOf(c.req.param("book"));
    if (!store) return c.json({ error: "找不到这本书(book_not_found)" }, 404);
    const meta = store.readMeta();
    const ready = readiness(store);
    const usage = summarizeUsage(store.dir);
    return c.json({
      name: meta.name,
      genre: meta.genre ?? "",
      pov: meta.pov ?? "",
      ready: ready.ready,
      missing: ready.missing,
      chapters: store.listChapters(),
      openIssues: store.listOpenIssues().length,
      indexCount: loadIndex(store).length,
      cost: usage,
    });
  });

  // —— 文件清单(工作台侧栏)——
  app.get("/api/books/:book/files", (c) => {
    const store = storeOf(c.req.param("book"));
    if (!store) return c.json({ error: "找不到这本书(book_not_found)" }, 404);
    const fixed = ["设定.md", "记录规则.md", "大纲.md", "状态.md", "伏笔.md", "时间线.md", "问题.md"].filter(
      (f) => fs.existsSync(path.join(store.dir, f)),
    );
    return c.json({
      memory: fixed,
      characters: store.listCharacters().map((x) => `角色/${x.name}.md`),
      worldbooks: store.listWorldbooks().map((x) => `世界书/${x.title}.md`),
      summaries: store.listSummaries().map((n) => `摘要/${pad3(n)}.md`),
      arcs: store.listArcs().map((n) => `弧/${pad3(n)}.md`),
    });
  });

  // —— 章节 ——
  app.get("/api/books/:book/chapters", (c) => {
    const store = storeOf(c.req.param("book"));
    if (!store) return c.json({ error: "找不到这本书(book_not_found)" }, 404);
    return c.json(
      store.listChapters().map((no) => {
        const ch = store.readChapter(no);
        return { no, title: ch.title, words: ch.words };
      }),
    );
  });

  app.get("/api/books/:book/chapters/:no", (c) => {
    const store = storeOf(c.req.param("book"));
    if (!store) return c.json({ error: "找不到这本书(book_not_found)" }, 404);
    const no = Number(c.req.param("no"));
    try {
      return c.json(store.readChapter(no));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
    }
  });

  app.put("/api/books/:book/chapters/:no", async (c) => {
    const store = storeOf(c.req.param("book"));
    if (!store) return c.json({ error: "找不到这本书(book_not_found)" }, 404);
    const no = Number(c.req.param("no"));
    if (!Number.isInteger(no) || no < 1) return c.json({ error: "章号不合法(bad_chapter_range)" }, 400);
    const body = (await c.req.json().catch(() => null)) as { text?: string; title?: string } | null;
    if (!body || typeof body.text !== "string") {
      return c.json({ error: "缺少 text 字段(bad_request)" }, 400);
    }
    const title = body.title ?? (store.listChapters().includes(no) ? store.readChapter(no).title : "");
    store.writeChapter(no, body.text, title);
    if (hasGit(store)) commitAll(store.dir, `ch${pad3(no)}-edit: 网页编辑`);
    return c.json({ ok: true, words: body.text.length });
  });

  // —— 记忆文件 ——
  app.get("/api/books/:book/file", (c) => {
    const store = storeOf(c.req.param("book"));
    if (!store) return c.json({ error: "找不到这本书(book_not_found)" }, 404);
    const rel = c.req.query("path") ?? "";
    if (!FILE_RE.test(rel)) return c.json({ error: `路径不合法:${rel}(bad_path)` }, 400);
    const full = path.join(store.dir, rel);
    if (!fs.existsSync(full)) return c.json({ error: `文件不存在:${rel}(file_not_found)` }, 404);
    return c.json({ path: rel, content: fs.readFileSync(full, "utf8") });
  });

  app.put("/api/books/:book/file", async (c) => {
    const store = storeOf(c.req.param("book"));
    if (!store) return c.json({ error: "找不到这本书(book_not_found)" }, 404);
    const rel = c.req.query("path") ?? "";
    if (!FILE_RE.test(rel)) return c.json({ error: `路径不合法:${rel}(bad_path)` }, 400);
    const body = (await c.req.json().catch(() => null)) as { content?: string } | null;
    if (!body || typeof body.content !== "string") {
      return c.json({ error: "缺少 content 字段(bad_request)" }, 400);
    }
    fs.mkdirSync(path.dirname(path.join(store.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(store.dir, rel), body.content, "utf8");
    // 编辑可能改动记忆内容:按文本差异增量同步索引(拿不到 embedder 就走无向量)
    let embedder = null;
    try {
      embedder = depsFor(store).embedder;
    } catch {
      /* 无配置时仍可保存 */
    }
    await syncIndex(store, embedder).catch(() => undefined);
    if (hasGit(store)) commitAll(store.dir, `edit: ${rel}`);
    return c.json({ ok: true });
  });

  // —— 工作流(SSE:text_delta / usage / done / error)——
  app.post("/api/books/:book/run", async (c) => {
    const store = storeOf(c.req.param("book"));
    if (!store) return c.json({ error: "找不到这本书(book_not_found)" }, 404);
    const body = (await c.req.json().catch(() => null)) as
      | { workflow?: string; args?: Record<string, unknown> }
      | null;
    const workflow = body?.workflow ?? "";
    const runner = RUNNERS[workflow];
    if (!runner) {
      return c.json({ error: `未知工作流「${workflow}」(unknown_workflow)` }, 400);
    }
    const args = body?.args ?? {};

    return streamSSE(c, async (stream) => {
      // SSE 写入排队,保证事件顺序
      let queue: Promise<void> = Promise.resolve();
      const send = (event: string, data: unknown): Promise<void> => {
        queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
        return queue;
      };
      try {
        const deps = depsFor(store);
        const io: RunIo = {
          onUsage: (role, usage) => {
            deps.onUsage?.(role, usage);
            void send("usage", { role, usage });
          },
          onDelta: (delta) => {
            void send("text_delta", { delta });
          },
        };
        const result = await runner(store, deps, args, io);
        await send("done", { workflow, result });
      } catch (e) {
        await send("error", { message: e instanceof Error ? e.message : String(e) });
      }
      await queue;
    });
  });

  return app;
}
