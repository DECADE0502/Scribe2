import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { extractJson, generateStructured } from "../../src/llm/json.js";

const S = z.object({ a: z.number(), b: z.string().default("") });

describe("extractJson(纯函数)", () => {
  it("裸 JSON 直接过", () => expect(extractJson('{"a":1}', S)).toEqual({ a: 1, b: "" }));
  it("剥 ```json 围栏", () => expect(extractJson('```json\n{"a":2}\n```', S).a).toBe(2));
  it("剥前后闲聊(好的,以下是JSON:…谢谢)", () =>
    expect(extractJson('好的,以下是JSON:\n{"a":3}\n希望有帮助!', S).a).toBe(3));
  it("字符串值里的花括号/引号不干扰配平", () =>
    expect(extractJson('{"a":4,"b":"文中有 } 和 \\" 也没事"}', S).b).toContain("}"));
  it("取第一个配平块,忽略后续 JSON", () =>
    expect(extractJson('{"a":5} {"a":99}', S).a).toBe(5));
  it("emoji 装饰行 + 全角引导也能提取", () =>
    expect(extractJson('✨【回复】✨\n{"a":6}', S).a).toBe(6));
  it("完全无 JSON → 抛 no_json_found", () =>
    expect(() => extractJson("这里没有对象", S)).toThrow(/no_json_found/));
  it("JSON 有但 schema 不符 → 抛 zod 错", () =>
    expect(() => extractJson('{"a":"不是数字"}', S)).toThrow());
});

describe("generateStructured(带错重试一次)", () => {
  it("首次坏 JSON → 把原文+zod错误喂回 → 二次成功", async () => {
    const gen = vi.fn()
      .mockResolvedValueOnce({ text: "呃我忘了格式" })
      .mockResolvedValueOnce({ text: '{"a":7}' });
    const out = await generateStructured({ generate: gen, schema: S, messages: [] });
    expect(out.a).toBe(7);
    expect(gen).toHaveBeenCalledTimes(2);
    // 第二次调用的 messages 末尾应包含首次原文与错误提示
    const retryMessages = gen.mock.calls[1]?.[0]?.messages;
    expect(JSON.stringify(retryMessages)).toContain("呃我忘了格式");
  });
  it("两次都坏 → 抛 parse 错误", async () => {
    const gen = vi.fn().mockResolvedValue({ text: "永远不是JSON" });
    await expect(generateStructured({ generate: gen, schema: S, messages: [] }))
      .rejects.toThrow(/no_json_found/);
  });
});
