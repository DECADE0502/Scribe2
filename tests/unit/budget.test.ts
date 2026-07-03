// PLAN Task 14 补测(评审测试缺口):预算估算与价目。
import { describe, expect, it } from "vitest";
import { costOf, estimateWriteCost, pricingFor } from "../../src/deps.js";
import type { UsageSummary } from "../../src/llm/usage.js";

function summary(byRole: UsageSummary["byRole"]): UsageSummary {
  const totalCostUsd = Object.values(byRole).reduce((s, r) => s + r.costUsd, 0);
  return { byRole, totalCostUsd };
}
const roleRow = (costUsd: number) => ({ calls: 1, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd });

describe("estimateWriteCost", () => {
  it("只摊写作角色成本,chat/onboard 不进章均", () => {
    const s = summary({
      writer: roleRow(0.4), planner: roleRow(0.1), extractor: roleRow(0.1), auditor: roleRow(0.1),
      chat: roleRow(9.9), onboard: roleRow(9.9),
    });
    // 写作成本 0.7 / 7 章 = 0.1/章;写 10 章估 1.0(若混入对话成本会是 ~29)
    expect(estimateWriteCost(s, 7, 10)).toBeCloseTo(1.0);
  });
  it("无历史(0 章)→ 0,放行", () => {
    expect(estimateWriteCost(summary({}), 0, 30)).toBe(0);
  });
});

describe("costOf / pricingFor", () => {
  it("按传入价目计价;默认 DeepSeek 价", () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 0 };
    expect(costOf(usage)).toBeCloseTo(0.28 + 0.42);
    expect(costOf(usage, { prompt: 10, cachedPrompt: 1, completion: 30 })).toBeCloseTo(40);
  });
  it("provider 配了 pricing 用配置;deepseek 域名默认价不警告", () => {
    const pricing = { prompt: 3, cachedPrompt: 0.3, completion: 15 };
    expect(pricingFor({ x: { baseUrl: "https://api.example.com", apiKeyEnv: "K", pricing } }, "x")).toEqual(pricing);
    expect(pricingFor({ ds: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "K" } }, "ds").prompt).toBe(0.28);
  });
});
