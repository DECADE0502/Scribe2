import { describe, expect, it } from "vitest";
import { streamCall, generateCall } from "../../src/llm/call.js";

function stubModel(parts: Array<Record<string, unknown>>, genText = "ok") {
  return {
    specificationVersion: "v1", provider: "stub", modelId: "stub",
    async doGenerate() {
      return { text: genText, finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 3 },
        rawCall: { rawPrompt: null, rawSettings: {} } };
    },
    async doStream() {
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }),
        rawCall: { rawPrompt: null, rawSettings: {} } };
    },
  } as never;
}

describe("streamCall", () => {
  it("透传 text-delta,完成后回调 usage", async () => {
    const usages: unknown[] = [];
    const out: string[] = [];
    for await (const ev of streamCall({
      model: stubModel([
        { type: "text-delta", textDelta: "你" }, { type: "text-delta", textDelta: "好" },
        { type: "finish", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 2 } },
      ]),
      messages: [{ role: "user", content: "hi" }],
      onUsage: (u) => usages.push(u),
    })) out.push(ev.delta);
    expect(out.join("")).toBe("你好");
    expect(usages).toHaveLength(1);
  });

  it("流内 error part → 抛异常(绝不静默吞掉)", async () => {
    await expect(async () => {
      for await (const _ of streamCall({
        model: stubModel([{ type: "text-delta", textDelta: "半" }, { type: "error", error: new Error("boom") }]),
        messages: [{ role: "user", content: "hi" }],
      })) { /* drain */ }
    }).rejects.toThrow(/boom/);
  });
});

describe("generateCall", () => {
  it("返回文本 + usage 回调", async () => {
    const usages: unknown[] = [];
    const { text } = await generateCall({
      model: stubModel([], "answer"), messages: [{ role: "user", content: "q" }],
      onUsage: (u) => usages.push(u),
    });
    expect(text).toBe("answer");
    expect(usages).toHaveLength(1);
  });
});
