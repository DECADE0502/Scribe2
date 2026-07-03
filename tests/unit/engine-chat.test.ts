import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { rebuildIndex } from "../../src/memory/index.js";
import { retrieve } from "../../src/memory/retrieve.js";
import { chatTurn, type ChatDeps } from "../../src/engine/chat.js";
import type { StreamEvent } from "../../src/types.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "fixtures", "demo-book");

/** 目录快照:文件相对路径 → 内容,用来断言零写入。 */
function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else map.set(path.relative(dir, full), fs.readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return map;
}

async function makeRig() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2chat-")), "演示书");
  fs.cpSync(fixtureDir, dir, { recursive: true });
  const store = new BookStore(dir);
  await rebuildIndex(store, null);

  const captured: unknown[] = [];
  const retrieveSpy = vi.fn(retrieve);
  const deps: ChatDeps = {
    chatter: (input) => {
      captured.push(input.messages);
      return (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", delta: "他们的关系正在变化。" };
      })();
    },
    retrieve: retrieveSpy,
    embedder: null,
    config: {
      providers: {}, roles: {}, deepestPromptScope: "creative", singleBudgetUsd: 5,
      masterPrompt: "全局标记:回答保持冷峻。",
    },
  };
  return { store, dir, deps, captured, retrieveSpy };
}

describe("chatTurn", () => {
  it("检索被调(查询=用户消息,实体从索引 keys 反查),回复流式返回", async () => {
    const { store, deps, retrieveSpy } = await makeRig();
    const result = await chatTurn(store, "林尘现在和赵三是什么关系?", deps);
    expect(result.reply).toContain("变化");
    const arg = retrieveSpy.mock.calls[0]![0];
    expect(arg.query.text).toBe("林尘现在和赵三是什么关系?");
    expect(arg.query.entities).toEqual(expect.arrayContaining(["林尘", "赵三"]));
  });

  it("messages 含检索结果与近 3 章摘要,深层提示词 creative 注入", async () => {
    const { store, deps, captured } = await makeRig();
    await chatTurn(store, "林尘的黑剑有什么来历?", deps);
    const joined = JSON.stringify(captured[0]);
    expect(joined).toContain("【作者全局要求】");
    expect(joined).toContain("全局标记");
    expect(joined).toContain("黑剑"); // 检索结果(黑剑世界书/伏笔)
    // 近 3 章摘要 = 第 2、3、4 章的一句话(fixture 章节 1-4)
    expect(joined).toContain("苏芸识破假名");
  });

  it("零文件写入:目录快照前后完全一致", async () => {
    const { store, dir, deps } = await makeRig();
    const before = snapshot(dir);
    await chatTurn(store, "主角现在什么处境?", deps);
    expect(snapshot(dir)).toEqual(before);
  });
});
