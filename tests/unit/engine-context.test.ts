import { describe, expect, it } from "vitest";
import {
  assembleWriteContext,
  deepestPromptFor,
  estimateTokens,
  JSON_FIREWALL,
  TEXT_FIREWALL,
  type WriteContextInput,
} from "../../src/engine/context.js";
import { loadPrompt } from "../../src/template.js";
import type { Config } from "../../src/types.js";
import type { BookMeta } from "../../src/store/book.js";

const config: Config = {
  providers: { ds: { baseUrl: "x", apiKeyEnv: "K" } },
  roles: { writer: { provider: "ds", modelId: "m" } },
  deepestPromptScope: "creative",
  singleBudgetUsd: 5,
  masterPrompt: "全局标记:心理描写用短句。",
};

const meta: BookMeta = {
  name: "演示书", pov: "第一人称", style: "冷峻克制", targetWords: 2000,
  deepestPromptEnabled: true, raw: {},
};

function baseInput(): WriteContextInput {
  return {
    chapterNo: 9,
    meta, config,
    promptTemplate: loadPrompt("write-chapter"),
    setting: "设定标记:灵气稀薄的南疆。",
    arcs: ["弧标记:弧1纲要。"],
    characterStates: [{ name: "林尘", state: "状态标记:左臂重伤。" }],
    constantWorldbooks: [{ title: "青云宗", keys: ["青云宗"], constant: true, body: "常驻标记:南疆唯一大宗。" }],
    midSummaries: [{ no: 5, text: "中程标记:" + "断碑铭文拓下。".repeat(600) }],
    triggeredCandidates: [
      { title: "黑市", keys: ["黑市"], constant: false, body: "触发标记:地下黑市每逢初一开市。" },
      { title: "雪山", keys: ["雪山"], constant: false, body: "雪山标记:极北之地。" },
    ],
    retrieved: [{
      chunk: { id: "summary:2", type: "summary", text: "检索标记:第2章结识赵三。", keys: [], updatedAt: 0, chapterNo: 2 },
      score: 0.7, cosine: 0, keyword: 0.5, recency: 0.9, pinned: false,
    }],
    recentChapters: [{ no: 8, title: "夜探", text: "近章标记:我在黑市买回一包金疮药。" }],
    openIssues: [{ id: "i1", status: "open", type: "逻辑", chapterNo: 4, note: "问题标记:时间线冲突。" }],
    plan: {
      goal: "规划标记:对质赵三。", scenes: ["场景1:镖局对质"],
      charactersOnStage: ["林尘", "赵三"], foreshadowToTouch: ["黑剑来历"], queryTerms: ["镖局"],
    },
    instruction: "指令标记:结尾埋一个跟踪钩子。",
  };
}

function joinedOf(messages: Array<{ content: unknown }>): string {
  return messages.map((m) => String(m.content)).join("\n<<<msg>>>\n");
}

describe("assembleWriteContext", () => {
  it("层序按 write-chapter.md 槽位:设定→弧→[状态→常驻→中程→检索]→问题→近章→规划→指令", () => {
    const { messages } = assembleWriteContext(baseInput());
    const joined = joinedOf(messages);
    const markers = ["设定标记", "弧标记", "状态标记", "常驻标记", "中程标记", "检索标记", "问题标记", "近章标记", "规划标记", "指令标记"];
    const positions = markers.map((m) => joined.indexOf(m));
    for (const [i, pos] of positions.entries()) {
      expect(pos, markers[i]).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(pos, `${markers[i - 1]} 应在 ${markers[i]} 前`).toBeGreaterThan(positions[i - 1]!);
    }
    // 视角/文风/目标字数也已渲染进指令头
    expect(joined).toContain("第一人称");
    expect(joined).toContain("冷峻克制");
    expect(joined).toContain("2000");
  });

  it("triggered 世界书:keys 命中近3章或规划文本才注入", () => {
    const { messages } = assembleWriteContext(baseInput());
    const joined = joinedOf(messages);
    expect(joined).toContain("触发标记"); // 近章文本含「黑市」
    expect(joined).not.toContain("雪山标记"); // 无命中
  });

  it("预算充足时不裁;中等预算先丢中程摘要;极小预算再丢检索层;核心层永不裁", () => {
    const full = assembleWriteContext(baseInput());
    expect(full.dropped).toEqual([]);

    const fullTokens = estimateTokens(joinedOf(full.messages));
    const mid = assembleWriteContext({ ...baseInput(), tokenBudget: fullTokens - 100 });
    expect(mid.dropped).toEqual(["中程摘要"]);
    const midJoined = joinedOf(mid.messages);
    expect(midJoined).not.toContain("中程标记");
    expect(midJoined).toContain("检索标记");

    const tiny = assembleWriteContext({ ...baseInput(), tokenBudget: 10 });
    expect(tiny.dropped).toEqual(["中程摘要", "检索层"]);
    const tinyJoined = joinedOf(tiny.messages);
    for (const kept of ["近章标记", "状态标记", "规划标记", "指令标记"]) {
      expect(tinyJoined, kept).toContain(kept);
    }
  });

  it("深层提示词:creative 注入为首条 system,带【作者全局要求】标头", () => {
    const { messages } = assembleWriteContext(baseInput());
    expect(messages[0]!.role).toBe("system");
    expect(String(messages[0]!.content)).toContain("【作者全局要求】");
    expect(String(messages[0]!.content)).toContain("全局标记");
  });

  it("deepestPromptScope=all:structured 注入 + 末位防火墙(可换文本版);creative 作用域下 structured 不注入", () => {
    const allConfig = { ...config, deepestPromptScope: "all" as const };
    const jsonEnv = deepestPromptFor("structured", allConfig, meta);
    expect(String(jsonEnv.prefix[0]!.content)).toContain("【作者全局要求】");
    expect(String(jsonEnv.suffix[0]!.content)).toBe(JSON_FIREWALL);
    expect(String(jsonEnv.suffix[0]!.content)).toContain("JSON");

    const textEnv = deepestPromptFor("structured", allConfig, meta, TEXT_FIREWALL);
    expect(String(textEnv.suffix[0]!.content)).toBe(TEXT_FIREWALL);
    expect(String(textEnv.suffix[0]!.content)).toContain("纯文本");
    expect(String(textEnv.suffix[0]!.content)).not.toContain("只输出规定的 JSON");

    // scope=creative(默认)时 structured 完全不注入
    const noneEnv = deepestPromptFor("structured", config, meta);
    expect(noneEnv.prefix).toHaveLength(0);
    expect(noneEnv.suffix).toHaveLength(0);
  });

  it("book.md 的 master_prompt 覆盖全局;关闭开关时完全不注入", () => {
    const override = assembleWriteContext({
      ...baseInput(),
      meta: { ...meta, masterPrompt: "书级标记:多用environment细节。" },
    });
    const oJoined = String(override.messages[0]!.content);
    expect(oJoined).toContain("书级标记");
    expect(oJoined).not.toContain("全局标记");

    const off = assembleWriteContext({
      ...baseInput(),
      meta: { ...meta, deepestPromptEnabled: false },
    });
    expect(joinedOf(off.messages)).not.toContain("【作者全局要求】");
  });
});
