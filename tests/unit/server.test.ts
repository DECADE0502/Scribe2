import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createApp } from "../../src/server/index.js";
import { retrieve } from "../../src/memory/retrieve.js";
import type { AppDeps } from "../../src/deps.js";
import type { StreamEvent } from "../../src/types.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "fixtures", "demo-book");

function fakeDeps(): AppDeps {
  return {
    planner: async () => ({ text: "{}" }),
    writer: () =>
      (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", delta: "正文片段" };
      })(),
    extractor: async () => ({ text: "{}" }),
    chatter: (input) =>
      (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", delta: "他在" };
        yield { type: "text_delta", delta: "黑水镇。" };
        input.onUsage?.({ promptTokens: 7, completionTokens: 3, cachedTokens: 0 });
      })(),
    auditor: async () => ({ text: '{"issues":[],"summary":"未发现确凿矛盾"}' }),
    retrieve,
    embedder: null,
    config: { providers: {}, roles: {}, deepestPromptScope: "creative", singleBudgetUsd: 5 },
  };
}

function makeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s2srv-"));
  const booksRoot = path.join(root, "books");
  fs.cpSync(fixtureDir, path.join(booksRoot, "演示书"), { recursive: true });
  const app = createApp({ booksRoot, depsFor: () => fakeDeps() });
  return { app, booksRoot };
}

const B = encodeURIComponent("演示书");

describe("server", () => {
  it("GET /api/books 列出书与就绪度", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/books");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ name: string; chapters: number; ready: boolean }>;
    const demo = list.find((b) => b.name === "演示书")!;
    expect(demo.chapters).toBe(4);
    expect(demo.ready).toBe(true);
  });

  it("GET /api/books/:b/status;书不存在 404 中文", async () => {
    const { app } = makeApp();
    const res = await app.request(`/api/books/${B}/status`);
    expect(res.status).toBe(200);
    const status = (await res.json()) as { name: string; chapters: number[]; openIssues: number };
    expect(status.name).toBe("演示书");
    expect(status.chapters).toEqual([1, 2, 3, 4]);

    const missing = await app.request(`/api/books/${encodeURIComponent("不存在")}/status`);
    expect(missing.status).toBe(404);
    expect(JSON.stringify(await missing.json())).toContain("book_not_found");
  });

  it("章节 GET/PUT round-trip", async () => {
    const { app } = makeApp();
    const before = await app.request(`/api/books/${B}/chapters/2`);
    expect(((await before.json()) as { text: string }).text).toContain("浊酒");

    const put = await app.request(`/api/books/${B}/chapters/2`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "网页里改过的正文。", title: "改" }),
    });
    expect(put.status).toBe(200);
    const after = (await (await app.request(`/api/books/${B}/chapters/2`)).json()) as {
      text: string;
      title: string;
    };
    expect(after.text).toBe("网页里改过的正文。");
    expect(after.title).toBe("改");
  });

  it("记忆文件 GET/PUT,路径穿越被拒", async () => {
    const { app } = makeApp();
    const get = await app.request(`/api/books/${B}/file?path=${encodeURIComponent("设定.md")}`);
    expect(((await get.json()) as { content: string }).content).toContain("炼气");

    const put = await app.request(`/api/books/${B}/file?path=${encodeURIComponent("设定.md")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "全新设定。" }),
    });
    expect(put.status).toBe(200);
    const again = await app.request(`/api/books/${B}/file?path=${encodeURIComponent("设定.md")}`);
    expect(((await again.json()) as { content: string }).content).toBe("全新设定。");

    const evil = await app.request(
      `/api/books/${B}/file?path=${encodeURIComponent("../../secrets.env")}`,
    );
    expect(evil.status).toBe(400);
    const sub = await app.request(
      `/api/books/${B}/file?path=${encodeURIComponent("角色/林尘.md")}`,
    );
    expect(sub.status).toBe(200);
  });

  it("POST run(chat)→ SSE:text_delta/usage/done 三类事件", async () => {
    const { app } = makeApp();
    const res = await app.request(`/api/books/${B}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "chat", args: { message: "主角在哪?" } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: text_delta");
    expect(body).toContain("黑水镇");
    expect(body).toContain("event: usage");
    expect(body).toContain("event: done");
  });

  it("未知 workflow → 400;工作流内部出错 → SSE error 事件", async () => {
    const { app } = makeApp();
    const bad = await app.request(`/api/books/${B}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "冲咖啡" }),
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain("unknown_workflow");

    // revise 选段不存在 → 流内 error 事件(不是 HTTP 错)
    const res = await app.request(`/api/books/${B}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "revise",
        args: { chapterNo: 2, selected: "根本不存在的选段", instruction: "改" },
      }),
    });
    const body = await res.text();
    expect(body).toContain("event: error");
    expect(body).toContain("selection_not_found");
  });
});
