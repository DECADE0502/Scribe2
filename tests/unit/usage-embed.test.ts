import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recordUsage, summarizeUsage } from "../../src/llm/usage.js";
import { embedTexts } from "../../src/llm/embed.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "s2usage-"));
}

describe("usage 记账", () => {
  it("recordUsage 追加 JSONL 行,字段完整", () => {
    const dir = tmpDir();
    recordUsage(dir, {
      role: "writer", model: "deepseek-chat",
      usage: { promptTokens: 100, completionTokens: 50, cachedTokens: 30 },
      costUsd: 0.001,
    });
    recordUsage(dir, {
      role: "planner", model: "deepseek-chat",
      usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 },
      costUsd: 0.0001,
    });
    const lines = fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ role: "writer", model: "deepseek-chat", promptTokens: 100, cachedTokens: 30 });
    expect(typeof first.ts).toBe("number");
  });

  it("summarizeUsage 按 role 汇总条数与成本", () => {
    const dir = tmpDir();
    for (let i = 0; i < 3; i++) {
      recordUsage(dir, {
        role: "writer", model: "m",
        usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 0 }, costUsd: 0.01,
      });
    }
    recordUsage(dir, {
      role: "extractor", model: "m",
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 }, costUsd: 0.002,
    });
    const s = summarizeUsage(dir);
    expect(s.byRole["writer"]).toMatchObject({ calls: 3 });
    expect(s.byRole["writer"]!.costUsd).toBeCloseTo(0.03);
    expect(s.byRole["extractor"]).toMatchObject({ calls: 1 });
    expect(s.totalCostUsd).toBeCloseTo(0.032);
  });

  it("坏行跳过,无文件返回空汇总", () => {
    const dir = tmpDir();
    expect(summarizeUsage(dir).totalCostUsd).toBe(0);
    fs.writeFileSync(path.join(dir, "usage.jsonl"), "不是json\n", "utf8");
    recordUsage(dir, {
      role: "writer", model: "m",
      usage: { promptTokens: 1, completionTokens: 1, cachedTokens: 0 }, costUsd: 0.01,
    });
    expect(summarizeUsage(dir).byRole["writer"]!.calls).toBe(1);
  });
});

describe("embedTexts", () => {
  it("embedder 未配置(null)→ 返回 null,不炸", async () => {
    expect(await embedTexts(null, ["a", "b"])).toBeNull();
  });

  it("注入假嵌入器 → 返回逐条向量", async () => {
    const fake = {
      specificationVersion: "v1", provider: "fake", modelId: "fake-embed",
      maxEmbeddingsPerCall: 10, supportsParallelCalls: true,
      async doEmbed({ values }: { values: string[] }) {
        return { embeddings: values.map((v) => [v.length, 1, 0]) };
      },
    } as never;
    const vectors = await embedTexts(fake, ["a", "bb"]);
    expect(vectors).toEqual([[1, 1, 0], [2, 1, 0]]);
  });
});
