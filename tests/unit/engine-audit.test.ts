import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BookStore } from "../../src/store/book.js";
import { initRepo, commitAll } from "../../src/store/git.js";
import { rebuildIndex, loadIndex } from "../../src/memory/index.js";
import { retrieve } from "../../src/memory/retrieve.js";
import { runAudit, type AuditDeps } from "../../src/engine/audit.js";

const fixtureDir = path.resolve(import.meta.dirname, "..", "fixtures", "demo-book");

const AUDIT_JSON = JSON.stringify({
  issues: [
    {
      type: "continuity", severity: "critical", chapterNo: 3,
      note: "第3章黑剑在包袱里,第4章却说藏于床板夹层且无转移交代",
      suggestedFix: "第4章开头补一句转移动作",
    },
    { type: "pacing", severity: "warning", chapterNo: 4, note: "连续两章没有主线推进" },
  ],
  summary: "共发现 2 处问题,其中严重 1 处",
});

async function makeRig(auditJson = AUDIT_JSON) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2audit-")), "演示书");
  fs.cpSync(fixtureDir, dir, { recursive: true });
  const store = new BookStore(dir);
  initRepo(dir);
  commitAll(dir, "init");
  await rebuildIndex(store, null);

  const auditorCalls: unknown[] = [];
  const deps: AuditDeps = {
    auditor: async (input) => {
      auditorCalls.push(input.messages);
      input.onUsage?.({ promptTokens: 1, completionTokens: 1, cachedTokens: 0 });
      return { text: auditJson };
    },
    retrieve: vi.fn(retrieve),
    embedder: null,
    config: { providers: {}, roles: {}, deepestPromptScope: "creative", singleBudgetUsd: 5 },
  };
  return { store, dir, deps, auditorCalls };
}

describe("runAudit", () => {
  it("issues 落 问题.md(open,稳定 id),索引更新,返回逐条中文文本", async () => {
    const { store, deps } = await makeRig();
    const report = await runAudit(store, { lastN: 4 }, deps);
    expect(report.issues).toHaveLength(2);
    const open = store.listOpenIssues();
    expect(open).toHaveLength(4); // fixture 自带 2 条 open + 新增 2 条
    const added = open.find((i) => i.note.includes("床板夹层"))!;
    expect(added.type).toBe("continuity");
    expect(added.chapterNo).toBe(3);
    expect(loadIndex(store).some((c) => c.id === `issue:${added.id}`)).toBe(true);
    expect(report.lines.join("\n")).toMatch(/critical|严重/);
    expect(report.lines.join("\n")).toContain("床板夹层");
  });

  it("重复 audit 相同 issue 不翻倍;resolveIssue 后流转", async () => {
    const { store, deps } = await makeRig();
    await runAudit(store, { lastN: 4 }, deps);
    const countAfter1 = store.listOpenIssues().length;
    await runAudit(store, { lastN: 4 }, deps);
    expect(store.listOpenIssues()).toHaveLength(countAfter1);
    const target = store.listOpenIssues().find((i) => i.note.includes("床板夹层"))!;
    store.resolveIssue(target.id);
    expect(store.listOpenIssues()).toHaveLength(countAfter1 - 1);
  });

  it("范围参数只送对应正文:lastN=2 → 只含第3、4章,不含第1章", async () => {
    const { store, deps, auditorCalls } = await makeRig();
    await runAudit(store, { lastN: 2 }, deps);
    const joined = JSON.stringify(auditorCalls[0]);
    expect(joined).toContain("药堂识破"); // 第3章正文标志
    expect(joined).toContain("三短,一长"); // 第4章正文标志
    expect(joined).not.toContain("我数出三枚铜钱"); // 第1章正文标志
  });

  it("chapterNo 越界 clamp 到 [1, 最新章]", async () => {
    const bad = JSON.stringify({
      issues: [{ type: "setting", severity: "warning", chapterNo: 99, note: "越界章号问题" }],
      summary: "1 处",
    });
    const { store, deps } = await makeRig(bad);
    await runAudit(store, { lastN: 4 }, deps);
    expect(store.listOpenIssues().find((i) => i.note.includes("越界"))!.chapterNo).toBe(4);
  });
});
