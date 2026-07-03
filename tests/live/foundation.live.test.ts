import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { modelFor } from "../../src/llm/provider.js";
import { streamCall, generateCall } from "../../src/llm/call.js";
import { generateStructured } from "../../src/llm/json.js";
import { recordUsage, summarizeUsage } from "../../src/llm/usage.js";
import type { LoadedConfig } from "../../src/config.js";
import type { Usage } from "../../src/types.js";

const loaded: LoadedConfig = {
  config: {
    providers: { ds: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" } },
    roles: { writer: { provider: "ds", modelId: "deepseek-chat" } },
    deepestPromptScope: "creative",
    singleBudgetUsd: 5,
  },
  secrets: {},
  apiKeyFor: () => process.env.DEEPSEEK_API_KEY ?? "",
};

const bookDir = fs.mkdtempSync(path.join(os.tmpdir(), "s2gateA-"));

describe.skipIf(!process.env.DEEPSEEK_API_KEY)("Gate A: 地基 live 验收(真 DeepSeek)", () => {
  it("streamCall 真流式:≥2 个 delta,onUsage 拿到 promptTokens>0", async () => {
    let usage: Usage | undefined;
    const deltas: string[] = [];
    for await (const ev of streamCall({
      model: modelFor(loaded, "writer"),
      messages: [{ role: "user", content: "用中文从一数到五,每个数字单独一行,不要其他内容。" }],
      onUsage: (u) => (usage = u),
    })) {
      deltas.push(ev.delta);
    }
    console.log(`[live] 流式输出 ${deltas.length} 个 delta:${deltas.join("").slice(0, 50)}`);
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(usage).toBeDefined();
    expect(usage!.promptTokens).toBeGreaterThan(0);
    recordUsage(bookDir, { role: "writer", model: "deepseek-chat", usage: usage!, costUsd: 0 });
  });

  it("generateStructured:模型随意作答也能靠硬化解析拿到合法对象", async () => {
    let usage: Usage | undefined;
    const out = await generateStructured({
      schema: z.object({ a: z.number() }),
      messages: [
        {
          role: "user",
          content:
            '请回复一个 JSON 对象 {"a": <你随便选的整数>}。' +
            "格式随意:可以加代码围栏、加寒暄、加 emoji 装饰——用你喜欢的任何格式。",
        },
      ],
      generate: ({ messages }) =>
        generateCall({ model: modelFor(loaded, "writer"), messages, onUsage: (u) => (usage = u) }),
    });
    console.log(`[live] 硬化解析结果 a=${out.a}`);
    expect(typeof out.a).toBe("number");
    recordUsage(bookDir, { role: "extractor", model: "deepseek-chat", usage: usage!, costUsd: 0 });
  });

  it("usage.jsonl 落了两行,role 字段正确", () => {
    const lines = fs.readFileSync(path.join(bookDir, "usage.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const summary = summarizeUsage(bookDir);
    expect(summary.byRole["writer"]!.calls).toBe(1);
    expect(summary.byRole["extractor"]!.calls).toBe(1);
    expect(summary.byRole["writer"]!.promptTokens).toBeGreaterThan(0);
  });
});
