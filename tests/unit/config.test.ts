import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveRole, loadConfigFrom } from "../../src/config.js";

const base = {
  providers: { ds: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" } },
  roles: { writer: { provider: "ds", modelId: "deepseek-chat" } },
  deepestPromptScope: "creative" as const,
  singleBudgetUsd: 5,
};

describe("角色回退链", () => {
  it("planner 未配 → extractor → writer", () => {
    expect(resolveRole(base, "planner")).toEqual({ provider: "ds", modelId: "deepseek-chat" });
  });
  it("auditor 走 extractor 优先", () => {
    const c = { ...base, roles: { ...base.roles, extractor: { provider: "ds", modelId: "cheap" } } };
    expect(resolveRole(c, "auditor")!.modelId).toBe("cheap");
  });
  it("embedding 无回退,未配返回 null", () => {
    expect(resolveRole(base, "embedding")).toBeNull();
  });
  it("writer 未配直接抛错", () => {
    expect(() => resolveRole({ ...base, roles: {} }, "writer")).toThrow(/writer/);
  });
});

describe("loadConfigFrom", () => {
  function makeDir(secrets: string, config: object = base): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2cfg-"));
    fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify(config), "utf8");
    fs.writeFileSync(path.join(tmp, "secrets.env"), secrets, "utf8");
    return tmp;
  }

  it("解析 secrets.env 并校验 provider 的 key 存在", () => {
    const tmp = makeDir("# 注释行\n\nDEEPSEEK_API_KEY=sk-test-123\nOTHER=x\n");
    const loaded = loadConfigFrom(tmp);
    expect(loaded.config.roles.writer!.modelId).toBe("deepseek-chat");
    expect(loaded.secrets.DEEPSEEK_API_KEY).toBe("sk-test-123");
    expect(loaded.apiKeyFor("ds")).toBe("sk-test-123");
  });

  it("provider 的 key 缺失 → 中文报错含错误码", () => {
    const cfg = {
      ...base,
      providers: { ds: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "S2_TEST_MISSING_KEY" } },
    };
    const tmp = makeDir("UNRELATED=1\n", cfg);
    expect(() => loadConfigFrom(tmp)).toThrow(/missing_api_key/);
    expect(() => loadConfigFrom(tmp)).toThrow(/S2_TEST_MISSING_KEY/);
  });
});
