# Scribe2 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/SPEC.md` 从零实现写作引擎:五角色管线 + 混合检索记忆 + 文件即存储 + git 即版本,CLI 先行。

**Architecture:** 纯函数核心(组装器/检索器/消毒器/lint)+ 注入式 LLM 调用(单测全用假模型)+ live 验收用真 DeepSeek。每个大阶段结束跑"模拟人类"live 剧本,并停下等用户验收。

**Tech Stack:** TS5 strict / Node22 / ai@4 + @ai-sdk/openai-compatible / zod / gray-matter / commander / vitest。

**工作目录:** `D:\desktop\scribe2`。命令从仓库根跑。**secrets.env 已含 DEEPSEEK_API_KEY,严禁入库(.gitignore 已覆盖)。**

**参考代码:** `docs/reference/` 内是旧项目验证过的实现(llm-call/retry/deepseek-metadata/
SillyTavern 解析四件套),移植时参考,不参与编译,不 import。

**Live 测试约定:**
- 文件名 `tests/live/*.live.test.ts`,顶部 `describe.skipIf(!process.env.DEEPSEEK_API_KEY)`;
- `pnpm test` 只跑 unit(排除 live);`pnpm test:live` 跑 live(加载 secrets.env);
- live 一律用 `deepseek-chat`(当前指向 v4-flash,便宜快),写作类把书的目标字数压到 1200 控制成本;
- DeepSeek 官方 **无 embeddings 端点** → 全部 live 在"关键词+时近"检索模式下跑(SPEC §2.3 的优雅降级正好被真实验证);向量路径用假嵌入器做单测。

**验收分层:** 每 Task 有机器验收(测试绿);每阶段末有 **Gate**:live 剧本(模拟人类输入,自动断言)→ 全绿后**停下等用户人工验收**,用户点头才进下一阶段。

---

## 文件地图

```
src/config.ts                 # config.json+secrets.env 载入,角色解析+回退链
src/llm/provider.ts           # role → LanguageModel(openai-compatible)
src/llm/call.ts               # stream()/generate():error事件转throw/重试/usage回调
src/llm/json.ts               # 硬化 JSON 提取 + zod + 带错重试
src/llm/embed.ts              # 批量嵌入(角色未配→null)
src/llm/usage.ts              # usage.jsonl 记账/汇总
src/template.ts               # {{var}}/{{#if}} 渲染 + prompts 载入(书级覆盖)
src/store/book.ts             # BookStore:目录约定/frontmatter/记忆文件渲染与解析
src/store/git.ts              # commit/resetToBefore/log(spawn git)
src/memory/chunks.ts          # 书文件 → chunk[](8类,keys 提取)
src/memory/index.ts           # .index/chunks.jsonl 读写/增量/重建
src/memory/retrieve.ts        # 混合打分 + 类型配额
src/engine/sanitize.ts        # 正文消毒器
src/engine/lint.ts            # 硬校验(book.md lint 节可配)
src/engine/context.ts         # 组装器(固定层+检索层,预算裁剪)
src/engine/write.ts           # 写章六步管线
src/engine/{onboard,chat,audit,revise,many,fix}.ts
src/cli/index.ts              # commander 全命令
tests/unit/**  tests/live/**  tests/fixtures/demo-book/**
```

核心公共类型(src/types.ts,T1 建立,后续全部引用):

```ts
export type Role = "writer" | "planner" | "extractor" | "auditor" | "embedding";
export interface RoleModel { provider: string; modelId: string }
export interface Config {
  providers: Record<string, { baseUrl: string; apiKeyEnv: string }>;
  roles: Partial<Record<Role, RoleModel | null>>;
  deepestPromptScope: "creative" | "all";
  singleBudgetUsd: number;
  masterPrompt?: string;
}
export interface StreamEvent { type: "text_delta"; delta: string }
export interface Usage { promptTokens: number; completionTokens: number; cachedTokens: number }
export interface Chunk {
  id: string; type: "character"|"character_state"|"worldbook"|"foreshadow"|"timeline"|"summary"|"record"|"issue";
  text: string; keys: string[]; chapterNo?: number; embedding?: number[]; updatedAt: number;
}
```

---

# 阶段 1:地基(config / llm / template / store / sanitize / lint)

### Task 1: 依赖 + config 载入 + 角色回退链

**Files:** Create `src/types.ts` `src/config.ts`;Test `tests/unit/config.test.ts`

- [ ] **Step 1:** `pnpm add @ai-sdk/openai-compatible@^0.2.0`;vitest.config.ts 排除 live:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/unit/**/*.test.ts"] },
});
```

package.json scripts 增加 `"test:live": "vitest run --config vitest.live.config.ts"`;
`vitest.live.config.ts` include `tests/live/**/*.live.test.ts`,`setupFiles: ["tests/live/setup.ts"]`
(setup.ts 读 secrets.env 注入 process.env)。

- [ ] **Step 2: 写失败测试**

```ts
// tests/unit/config.test.ts
import { describe, expect, it } from "vitest";
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
  it("loadConfigFrom 解析 secrets.env 并校验 provider 的 key 存在", () => {
    // 用临时目录写 config.json + secrets.env 再读回,断言 apiKey 被解析出来
  });
});
```

- [ ] **Step 3:** 跑测确认 FAIL(模块不存在)。
- [ ] **Step 4:** 实现 `config.ts`:zod 校验 config 形状;`resolveRole` 回退链
  `planner→extractor→writer`,`auditor→extractor→writer`,`extractor→writer`,embedding 无回退;
  `loadConfigFrom(dir)` 读 config.json + 逐行解析 secrets.env(`KEY=VALUE`,忽略注释/空行)。
- [ ] **Step 5:** PASS 后提交 `feat(config): roles + fallback chain + secrets loading`。

**验收标准:** 上述 5 用例绿;typecheck 0。

### Task 2: llm/call —— 流式与结构化调用(error 事件转 throw)

**Files:** Create `src/llm/provider.ts` `src/llm/call.ts`;Test `tests/unit/llm-call.test.ts`

- [ ] **Step 1: 写失败测试**(stub LanguageModel 模式,与旧仓验证过的做法一致)

```ts
// tests/unit/llm-call.test.ts
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
```

- [ ] **Step 2:** FAIL 确认。
- [ ] **Step 3:** 实现:
  - `provider.ts`:`modelFor(config, role)` 用 `createOpenAICompatible({ name, baseURL, apiKey })`
    返回 chat model;embedding 用 `.textEmbeddingModel(modelId)`。
  - `call.ts`:`streamCall({model,messages,abortSignal,onUsage})` 包 `streamText`,遍历 fullStream:
    `text-delta`→yield `{type:"text_delta",delta}`;`error`→**throw**;finish 后读
    `await result.usage` 回调 onUsage(cachedTokens 从 providerMetadata 的
    `prompt_cache_hit_tokens` 读,读不到给 0)。
    `generateCall` 包 `generateText` + 同样 usage 回调。
    重试:429/5xx/网络错误指数退避 ×2,abort/auth 不重试(独立小函数 `withRetry`)。
- [ ] **Step 4:** PASS;**Step 5:** 提交 `feat(llm): stream/generate with error-throw + retry + usage callback`。

**验收标准:** 3 用例绿;`grep -c "as any" src/llm/call.ts` = 0。

### Task 3: llm/json —— 硬化 JSON 提取

**Files:** Create `src/llm/json.ts`;Test `tests/unit/llm-json.test.ts`

- [ ] **Step 1: 写失败测试**(这是深层提示词格式污染的最后防线,测试要狠)

```ts
// tests/unit/llm-json.test.ts
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
    const retryMessages = gen.mock.calls[1][0].messages;
    expect(JSON.stringify(retryMessages)).toContain("呃我忘了格式");
  });
  it("两次都坏 → 抛 parse 错误", async () => {
    const gen = vi.fn().mockResolvedValue({ text: "永远不是JSON" });
    await expect(generateStructured({ generate: gen, schema: S, messages: [] }))
      .rejects.toThrow(/no_json_found/);
  });
});
```

- [ ] **Step 2:** FAIL;**Step 3:** 实现:
  `extractJson`:strip 围栏 → 引号感知的括号配平扫描找首个 `{…}` → JSON.parse → schema.parse。
  `generateStructured({generate,schema,messages})`:调 generate → extractJson;
  失败则 append `{role:"user",content:"你上次输出无法解析:<原文截断500字>\n错误:<msg>\n重新只输出符合要求的 JSON。"}` 再试一次。
- [ ] **Step 4:** PASS;**Step 5:** 提交 `feat(llm): hardened json extraction + retry-with-error`。

**验收标准:** 10 用例绿(尤其字符串内花括号与首块选取)。

### Task 4: 模板引擎 + 提示词载入

**Files:** Create `src/template.ts`;Test `tests/unit/template.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/template.test.ts
import { describe, expect, it } from "vitest";
import { renderTemplate, loadPrompt } from "../../src/template.js";
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";

describe("renderTemplate", () => {
  it("替换 {{var}},缺失变量抛错(拒绝静默空洞)", () => {
    expect(renderTemplate("你好 {{名字}}", { 名字: "林尘" })).toBe("你好 林尘");
    expect(() => renderTemplate("{{没给}}", {})).toThrow(/没给/);
  });
  it("{{#if x}}…{{/if}} 条件段:空串/空数组视为假", () => {
    expect(renderTemplate("A{{#if k}}B{{/if}}C", { k: "" })).toBe("AC");
    expect(renderTemplate("A{{#if k}}B{{k}}{{/if}}C", { k: "有" })).toBe("AB有C");
  });
  it("剥掉文件头部的 <!-- --> 注释块", () => {
    expect(renderTemplate("<!--说明-->\n正文{{x}}", { x: "1" })).toBe("正文1");
  });
});

describe("loadPrompt(书级覆盖)", () => {
  it("书目录有同名文件则优先于内置 prompts/", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2-"));
    fs.mkdirSync(path.join(tmp, "prompts"));
    fs.writeFileSync(path.join(tmp, "prompts", "chat.md"), "书级覆盖 {{书名}}");
    expect(loadPrompt("chat", tmp)).toContain("书级覆盖");
    expect(loadPrompt("chat")).toContain("责编助手"); // 内置版
  });
});
```

- [ ] **Steps 2-5:** FAIL → 实现(正则替换 + if 块;`loadPrompt(name, bookDir?)` 先书级后内置)→ PASS → 提交 `feat(template): mini renderer + per-book prompt override`。

**验收标准:** 5 用例绿;所有 9 个内置 prompts 能被 loadPrompt 读到(补一条遍历断言)。

### Task 5: store/book —— 书目录读写与记忆文件渲染

**Files:** Create `src/store/book.ts`;Test `tests/unit/store-book.test.ts`

- [ ] **Step 1: 写失败测试**(全部走临时目录,断言真实文件内容)

```ts
// tests/unit/store-book.test.ts —— 关键断言(完整 rig 见实现时补齐)
import { describe, expect, it, beforeEach } from "vitest";
import { BookStore } from "../../src/store/book.js";
// createBook → 目录骨架齐(设定.md/记录规则.md/大纲.md/伏笔.md/时间线.md/状态.md/问题.md/角色/世界书/章节/摘要/弧)
// meta 读写: readMeta().pov === 书写入值
// 章节: writeChapter(5, "正文", "标题") → 章节/005.md 带 frontmatter,readChapter round-trip;listChapters 升序
// 角色: upsertCharacter({name,role,base,state}) 二次调用只更新 状态 节,基底不动;aliases 进 frontmatter
// 伏笔: applyForeshadow({new:[…], paid:["黑剑"]}) → 伏笔.md 状态位翻转 [active]→[paid];label 归一化 dedup
// 时间线: appendTimeline(...) → 追加且 (storyTime,event) 去重
// 状态: writeRecords({境界:"炼气四层"}) → 状态.md 对应节整节替换,其他节保留
// 摘要/弧: writeSummary(5,{…}) / writeArc(1,"…") round-trip
// 问题: addIssues([...]) / listOpenIssues() / resolveIssue(id)
// 全部解析器对手工编辑容错: 多余空行/无 frontmatter 的旧文件不炸
```

- [ ] **Steps 2-5:** FAIL → 实现(渲染格式即 SPEC §1;伏笔行格式
  `- [active] 黑剑来历 | 埋于第3章 | 描述 | 关联:林尘`;时间线行
  `- 第5章 | 第七日夜 | 事件 | 林尘,赵三`;解析用行正则,坏行跳过并 console.warn)
  → PASS → 提交 `feat(store): book directory IO + memory file render/parse`。

**验收标准:** ≥12 用例绿,覆盖每类文件的 render+parse round-trip 与容错。

### Task 6: store/git

**Files:** Create `src/store/git.ts`;Test `tests/unit/store-git.test.ts`

- [ ] **Step 1: 写失败测试**:tmp 目录 `initRepo` → 改文件 → `commitAll("ch001: 写作")` →
  `log()` 含该条;再 commit `ch002` → `resetToBefore("ch002")` → 文件回到 ch001 状态且 log 顶部是 ch001;
  message 前缀查找不存在时抛错。
- [ ] **Steps 2-5:** 实现(spawnSync git,cwd=书目录;`resetToBefore(prefix)` = 找到最新
  message 以 prefix 开头的 commit,`git reset --hard <它的父>`)→ PASS → 提交 `feat(store): git commit/reset/log`。

**验收标准:** 4 用例绿;Windows 路径含中文书名可用(用例书名用中文)。

### Task 7: sanitize + lint

**Files:** Create `src/engine/sanitize.ts` `src/engine/lint.ts`;Test `tests/unit/sanitize-lint.test.ts`

- [ ] **Step 1: 写失败测试**(表驱动)

```ts
// sanitize: 剥全文```围栏 / 删首部元话语行("好的,以下是第5章正文:"、"### 第五章 风起"重复台头)
//           / 取【正文开始】…【正文结束】内部 / 正常文本原样返回 / 章末"本章完"不动(归 lint 管)
// lint(text, {pov:"第一人称", minChars:800, allowTailMarkers:false}):
//   过短 → {ok:false, reason:"too_short"} ;结尾含"待续|未完|下一章预告" → tail_marker(allowTailMarkers:true 时放行)
//   首两段无"我"且 pov=第一人称 → pov_drift ;全过 → {ok:true}
```

- [ ] **Steps 2-5:** 实现 → PASS → 提交 `feat(engine): prose sanitizer + configurable lint`。

**验收标准:** ≥10 表驱动用例绿;消毒器对"正常正文"是恒等函数(专门断言)。

### Task 8: usage 记账 + embed

**Files:** Create `src/llm/usage.ts` `src/llm/embed.ts`;Test `tests/unit/usage-embed.test.ts`

- [ ] **Step 1: 写失败测试**:`recordUsage(bookDir,{role,model,usage,costUsd})` 追加一行 JSONL;
  `summarizeUsage(bookDir)` 按 role 汇总条数与成本;`embedTexts(null, [...])` 返回 null(降级);
  `embedTexts(fakeEmbedder, ["a","b"])` 返回两个向量(fakeEmbedder 注入)。
- [ ] **Steps 2-5:** 实现 → PASS → 提交 `feat(llm): usage ledger + optional embeddings`。

### ✅ Gate A(阶段1 live 验收)

**Files:** Create `tests/live/setup.ts` `tests/live/foundation.live.test.ts`

- [ ] live 测试:真实 DeepSeek(`deepseek-chat`):
  1. `streamCall` 流出 ≥2 个 delta,onUsage 拿到 promptTokens>0;
  2. `generateStructured`:messages 要求"用你喜欢的任何格式回答 {a:数字}"——靠硬化解析拿到合法对象(验证防线,不靠模型听话);
  3. usage.jsonl 落了两行,role 字段正确。
- [ ] 跑 `pnpm test`(全绿)+ `pnpm test:live`(全绿),提交 `test(live): foundation gate`。

**🧑 用户验收停点 A:** 汇报 unit/live 数字与真实流式输出样例,等确认。

---

# 阶段 2:记忆(chunks / index / retrieve)

### Task 9: memory/chunks

**Files:** Create `src/memory/chunks.ts`;Test `tests/unit/memory-chunks.test.ts` + `tests/fixtures/demo-book/`(手工造一本 3 角色/4 世界书/6 伏笔/10 时间线/8 摘要/2 弧/记录 3 节的书)

- [ ] **Step 1: 写失败测试**:`chunksFromBook(store)` 产出:每角色 2 块(character 基底 / character_state 状态,keys=[名+aliases]);每世界书 1 块(keys=frontmatter keys);伏笔每条 1 块(keys=[label+关联角色]);时间线/摘要每条 1 块(chapterNo 正确);记录每节 1 块;issue 只出 open。id 稳定(同内容两次生成同 id,用 `type:名称` 拼)。
- [ ] **Steps 2-5:** 实现 → PASS → 提交 `feat(memory): chunk extraction from book files`。

**验收标准:** fixture 全类型计数断言 + id 稳定性断言绿。

### Task 10: memory/index

**Files:** Create `src/memory/index.ts`;Test `tests/unit/memory-index.test.ts`

- [ ] **Step 1: 写失败测试**:`rebuildIndex(store, embedder|null)` 写 `.index/chunks.jsonl`;
  `updateChunks(store, ids[])` 只重算/重嵌入指定 id(fakeEmbedder 计数断言只调了变更条数);
  `loadIndex` round-trip;embedder=null 时 embedding 字段缺省且一切可用;jsonl 坏行跳过。
- [ ] **Steps 2-5:** 实现 → PASS → 提交 `feat(memory): jsonl index + incremental update`。

### Task 11: memory/retrieve —— 混合打分

**Files:** Create `src/memory/retrieve.ts`;Test `tests/unit/memory-retrieve.test.ts`

- [ ] **Step 1: 写失败测试**(打分逻辑是检索质量的全部,测试要密)

```ts
// score = 0.45*cos + 0.35*keyword + 0.20*recency;无向量时 keyword 0.6 / recency 0.4
// 断言:
// 1) 查询含 "黑水镇" → keys 含黑水镇的 worldbook 排第一(纯关键词模式)
// 2) 多实体命中(林尘+黑剑)得分高于单命中
// 3) recency: 同分 summary,第48章的排在第3章前(current=50,半衰期20章);character/worldbook 恒 recency=1
// 4) 类型配额: 造 10 条同类高分,只出 quota 条;不同类不互挤
// 5) 阈值: 全不相关时返回空,不硬凑
// 6) 向量模式: fake embedding(查询与目标同向)能把 keys 无命中的语义近邻捞回来
// 7) charactersOnStage 传入时,对应 character_state 无条件置顶(绕过打分)
```

- [ ] **Steps 2-5:** 实现(`retrieve({index, query:{text,entities,charactersOnStage}, currentChapter, embedder|null, quotas})`)→ PASS → 提交 `feat(memory): hybrid scoring retrieval with quotas`。

### ✅ Gate B(阶段2 验收)

- [ ] `tests/unit/memory-scenario.test.ts`:demo-book 场景题——查询"林尘去黑水镇找赵三对质黑剑来历",断言检索结果同时含:黑水镇世界书、赵三角色状态、黑剑伏笔、相关时间线,且不含无关角色。
- [ ] 全套 unit 绿,提交 `test(memory): retrieval scenario gate`。

**🧑 用户验收停点 B:** 展示场景题的检索排名表(每条 chunk 的三项得分),等确认。

---

# 阶段 3:写章管线(组装 / 六步 / CLI)—— 心脏阶段

### Task 12: engine/context 组装器

**Files:** Create `src/engine/context.ts`;Test `tests/unit/engine-context.test.ts`

- [ ] **Step 1: 写失败测试**:
  固定层顺序断言(设定→角色状态→constant世界书→弧纲要→中程摘要→近3章→open问题→规划→指令,messages 字符串位置比较);
  triggered 世界书:keys 命中"近3章文本+规划文本"才注入;
  预算裁剪:tokenBudget 极小时先丢中程摘要、再丢检索层,**近3章全文/状态/规划/指令永不裁**;
  深层提示词:creative 注入为首条 system(带【作者全局要求】标头),book.md 关闭开关时不注入。
- [ ] **Steps 2-5:** 实现(纯函数,token 估算 `Math.ceil(chars/1.6)`)→ PASS → 提交 `feat(engine): layered context assembler`。

### Task 13: engine/write 六步管线

**Files:** Create `src/engine/write.ts`;Test `tests/unit/engine-write.test.ts`

- [ ] **Step 1: 写失败测试**(全假 LLM,注入三个角色的假实现)

```ts
// rig: demo-book 副本 + fake planner(返回固定规划JSON) + fake writer(流出1000字正文)
//      + fake extractor(返回记忆增量JSON) + git 真跑(tmp)
// 断言:
// 1) 幸福路径: writeChapter(store, 5, "指令", deps) → 章节/005.md 存在且=消毒后正文;
//    摘要/005.md 存在;状态.md/伏笔.md/时间线.md 按增量更新;index 变更块被 update;
//    git log 顶部 "ch005";onUsage 被调 3 次(planner/writer/extractor 各一)
// 2) planner 的 queryTerms 真的传给了 retrieve(spy 断言)
// 3) writer 流中 error → 抛出,无任何文件落盘、无 commit
// 4) lint 失败(fake writer 先吐 300 字)→ 自动带因重写(writer 被调第2次,messages 含违规原因)
//    → 第2次1000字 → 成功;两次都短 → 抛错且留稿到 章节/005.draft.md
// 5) extractor 抛错 → 正文不 commit(整章视为失败,git 干净)
// 6) 第10章写完自动触发弧压缩(fake compressor 被调,弧/001.md 生成)
```

- [ ] **Steps 2-5:** 实现(`writeChapter(store, n, instruction, deps)`,deps 注入
  `{planner,writer,extractor,retrieve,onUsage,budget}` 便于测试;生产装配在 CLI 层)
  → PASS → 提交 `feat(engine): six-step write pipeline`。

**验收标准:** 6 用例绿,尤其 3/5 的"失败不落盘、git 干净"。

### Task 14: CLI(write / status / reindex)

**Files:** Create `src/cli/index.ts`;Test `tests/unit/cli-smoke.test.ts`(spawn `tsx src/cli/index.ts --help` 断言命令清单)

- [ ] 实现 commander:`write <书> <章号|a..b> [-m 指令]`(流式打印 delta)、`status <书>`、
  `reindex <书>`;装配生产 deps(config→provider→roles;usage 记账接 onUsage;预算检查:估算超 singleBudgetUsd 拒绝)。
- [ ] **全中文输出**:CLI 的提示/进度/错误一律中文,错误格式 `中文说明(错误码)`(SPEC §6);
  cli-smoke 测试断言 `--help` 与一条错误路径输出含中文、不含裸英文句子。
- [ ] 提交 `feat(cli): write/status/reindex(全中文输出)`。

### ✅ Gate C(阶段3 live 验收——第一次真写作)

**Files:** Create `tests/live/write.live.test.ts` + `scripts/gate-c.ts`(模拟人类剧本)

- [ ] **模拟人类剧本**(脚本化,真 DeepSeek):
  1. 把 demo-book fixture 复制到 tmp books/,book.md 目标字数改 1200;
  2. 如人类般执行:`scribe write 演示书 1 -m "林尘初到黑水镇,结尾埋一个陌生人跟踪的钩子"`;
  3. 机器断言:章节/001.md ≥800 字、无"待续"、首段含"我"(fixture 设第一人称);
     摘要/001.md 生成;状态.md 有变化;usage.jsonl 含 planner/writer/extractor 三行;git log 有 ch001;
  4. 再写第 2 章(无指令,纯大纲驱动),断言正文提及第 1 章埋的实体(检索闭环的真实证据:
     抓第 1 章 extractor 产出的任一新实体名,在第 2 章正文或其规划 JSON 里 grep 到)。
- [ ] `pnpm test && pnpm test:live` 全绿,提交 `test(live): gate C first real chapters`。

**🧑 用户验收停点 C(重点):** 用户亲手跑
`pnpm dev write 演示书 3 -m "自由发挥"` 看流式体验与正文质量;检查 books/演示书/ 的记忆文件是否"像人话"。**用户点头前不进阶段 4。**

---

# 阶段 4:全工作流(onboard / chat / audit / revise / 连写+护栏 / fix)

### Task 15: onboard + `scribe new`

**Files:** Create `src/engine/onboard.ts`;Modify `src/cli/index.ts`;Test `tests/unit/engine-onboard.test.ts`

- [ ] 测试:fake writer(对话回复)+ fake extractor(设定 JSON)→ `onboardTurn(store, "我想写修仙复仇文", deps)`:
  book.md 字段合并(空值不覆盖)、角色/世界书/大纲 dedup 落盘、记录规则生成、chunk 索引更新、
  `readiness(store)` 返回缺失项;CLI `new <书名>` 建目录 + 进入 readline 循环(stdin 可注入,测试用 pipe)。
- [ ] 提交 `feat(engine): onboard workflow + scribe new`。

### Task 16: chat

**Files:** Create `src/engine/chat.ts`;Modify CLI;Test `tests/unit/engine-chat.test.ts`

- [ ] 测试:检索被调(查询=用户消息)、messages 含检索结果与近 3 摘要、**零文件写入**(store spy)、
  深层提示词 creative 注入。提交 `feat(engine): chat workflow`。

### Task 17: audit + 问题闭环

**Files:** Create `src/engine/audit.ts`;Modify CLI;Test `tests/unit/engine-audit.test.ts`

- [ ] 测试:fake auditor 返回 issues → 问题.md 增 open 条目(带稳定 id)、索引更新、返回逐条文本;
  重复 audit 相同 issue 不翻倍(按 type+chapterNo+note 前缀 dedup);`resolveIssue` 流转;
  audit 范围参数(近N章)只送对应正文。提交 `feat(engine): audit + issue lifecycle`。

### Task 18: revise

**Files:** Create `src/engine/revise.ts`;Modify CLI;Test `tests/unit/engine-revise.test.ts`

- [ ] 测试:选段 ±500 字上下文进 prompt;替换精确(选段重复出现时要求带前文锚点定位——
  传 `occurrenceIndex`);空输出拒绝;lint 尾标记规则同样适用;commit `ch005-revise`。
  提交 `feat(engine): segment revise`。

### Task 19: 连写 + 护栏 + fix

**Files:** Create `src/engine/many.ts` `src/engine/fix.ts`;Modify CLI(`write a..b` 接 many、新增 `fix`);Test `tests/unit/engine-many-fix.test.ts`

- [ ] 测试(全假 LLM):
  1. `writeMany(store, 1, 6, deps)` 写 6 章,第 5 章后 auditor 被调一次(范围近5章);
  2. auditor 返回 critical@最新章 → fix 自动触发:git reset 掉该章 → 重写(writer 收到 issues 注入)→ 继续;再 critical → 停,返回 `{stoppedAt, reason}`;
  3. critical@第2章(历史)→ 停,不 reset,问题入 问题.md;
  4. 成本超限 → 停在开写前;
  5. `fixLatest(store, deps)`:reset 最新章 commit → 带 open issues 重跑管线 → 新 commit;无章可修时报错。
- [ ] 提交 `feat(engine): write-many with guard + fix-latest via git reset`。

### ✅ Gate D(阶段4 live 全流程剧本)

**Files:** Create `tests/live/full-flow.live.test.ts`

- [ ] **模拟人类完整剧本**(真 DeepSeek,一次跑完):
  1. `scribe new 测试书` + 三轮 onboard 罐头输入("都市异能复仇文,主角陈默"→"第一人称,目标50章"→"就这样,开始吧")→ 断言 readiness=ready、角色/世界书/大纲文件非空;
  2. `write 测试书 1..6`(触发第 5 章护栏)→ 断言 6 章存在、护栏 auditor usage 行存在、若停下则报告可读;
  3. `chat 测试书 "主角现在什么处境"` → 回答提及第 6 章事实(grep 状态.md 里的实体);
  4. `audit 测试书` → 问题.md 有产出(允许空,断言命令成功与格式);
  5. `revise` 对第 6 章某段跑一次 → diff 只动该段;
  6. `status` 输出章数=6、成本合计>0、各角色调用数。
- [ ] 全绿提交 `test(live): gate D full workflow`。

**🧑 用户验收停点 D(重点):** 用户亲手玩 onboard 建一本自己的书 + 连写 5 章 + 审查。**点头前不进阶段 5。**

---

# 阶段 5:周边(import / export / rollback)

### Task 20: SillyTavern 导入

**Files:** Create `src/import/sillytavern.ts`;Modify CLI;Test `tests/unit/import-st.test.ts` + fixtures(自造两个最小样例 json;解析逻辑从 **`docs/reference/`** 里的 `import-service.ts` / `sillytavern-detect.ts` / `sillytavern-worldbook.ts` / `sillytavern-preset.ts` 移植——这些是旧仓验证过的解析器,输出端改成写文件)

- [ ] 测试:角色卡 → 角色/<名>.md(description/personality→基底);世界书 → 世界书/*.md(key→keys,constant 保留);导入后索引更新;未知 json 报错不落盘。提交 `feat(import): sillytavern cards + worldbooks`。

### Task 21: export / rollback / status 完整版

**Files:** Create `src/engine/export.ts`;Modify CLI;Test `tests/unit/export-rollback.test.ts`

- [ ] 测试:export md/txt 单章与全书(拼接顺序、txt 去 frontmatter);`rollback <书> 12` = resetToBefore("ch012") 且 status 章数回退;rollback 后 reindex 自动跑。提交 `feat: export + rollback + full status`。

### ✅ Gate E:unit 全绿 + 用户抽查(把自己的 SillyTavern 卡导进来看效果)。

---

# 阶段 6:server + web 薄壳

### Task 22: server(SSE 4 事件 + 文件 API)

**Files:** Create `src/server/index.ts`;Test `tests/unit/server.test.ts`(Hono app.request)

- [ ] `POST /api/books/:b/run {workflow,args}` → SSE(text_delta/done/error/usage);
  GET/PUT 记忆文件与章节;GET 书列表/状态。engine 复用,零新逻辑。提交。

### Task 23: web 薄壳

**Files:** Create `web/`(Vite+React+CodeMirror:书库/工作台三栏/设置)

- [ ] 手测清单驱动(流式显示/编辑保存/记忆浏览)。**UI 文案全中文,无英文残留**(SPEC §6)。提交。

### ✅ Gate F:**🧑 用户浏览器验收**(最终)。

---

## Self-Review

- **Spec 覆盖:** §1→T5/T6;§2→T9-11;§3.1→T15;§3.2→T12-13;§3.3+3.7→T19;§3.4→T18;§3.5→T17;§3.6→T16;§4→T4(+提示词已存在);§4.1→T3/T7/T12;§5→T1/T2/T8;§6→T14/T19/T20/T21/T22。无缺口。
- **占位符扫描:** 无 TBD/TODO;T5/T15-18 用测试契约定义行为,断言项逐条列出,非空洞"写测试"。
- **类型一致:** Role/Config/Chunk/StreamEvent 在 T1 定义,后续任务签名(resolveRole/streamCall/generateStructured/retrieve/writeChapter)前后一致。
- **成本控制:** live 全用 deepseek-chat + 1200 字目标;Gate D 全剧本估算 < $0.5。
