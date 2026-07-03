# Scribe2 — 长篇小说写作引擎 设计规格

> 2026-07-03。单机单用户。核心命题:**连续写几百章不失忆、不涨上下文成本**。
> 三条铁律:文件即记忆 / 检索即注入 / 提示词是一等公民(全部在 `prompts/` 可改可 diff)。

---

## 0. 总架构

```
                        ┌─────────────────────────────┐
                        │  prompts/*.md  内置提示词库    │
                        └──────────────┬──────────────┘
用户动作 ──► 工作流(engine) ──► 组装器 ──┤
   │            │                      │  固定层(设定/状态/近章) 直接读文件
   │            │                      │  检索层(元素记忆) ◄── memory 索引(hybrid RAG)
   │            ▼                      ▼
   │        LLM 调用(流式/结构化) ◄── llm/
   │            │
   │            ▼
   └──── 解析回写(文件渲染 + 重建索引 + git commit)
```

- **store/**:一书一目录的文件读写(gray-matter frontmatter)。
- **memory/**:元素记忆的分块、嵌入、混合检索。
- **engine/**:六个工作流(建书/写章/连写/改写/审查/聊天),每个 = 提示词模板 + 上下文配方 + 输出解析。
- **llm/**:provider 抽象(OpenAI-compatible / DeepSeek / Anthropic),流式 + 重试 + usage 记账 + 嵌入。
- **cli/** 先行,**server/ + web/** 后置薄壳(SSE 4 事件:text_delta/done/error/usage)。

---

## 1. 数据形态(一书一目录)

```
books/<书名>/
  book.md            # frontmatter: 书名/题材/简介/目标章数/写作视角/master_prompt/style
  设定.md             # 世界观核心(永远全文注入,控制在 ~800 字内,溢出部分放世界书)
  记录规则.md          # 本书追踪哪些动态记录(境界/图鉴/资产…),建书时生成,可手改
  大纲.md             # 卷→弧→章意图 层级列表
  角色/<名>.md        # frontmatter: role/aliases;## 基底(静态) / ## 当前状态(动态)
  世界书/<题>.md       # frontmatter: keys/constant;正文=条目
  状态.md             # 题材记录 current,按记录规则分节
  伏笔.md             # 条目列表: [active|paid] 标签 | 埋设章 | 描述 | 关联角色
  时间线.md            # append-only: 章号 | 故事内时间 | 事件 | 参与者
  问题.md             # 审查产出: [open|resolved] 章号 | 类型 | 描述
  摘要/NNN.md         # 每章: 一句话 / 段落 / 关键事件
  弧/NNN.md           # 每 10 章压缩的纲要(~300 字)
  章节/NNN.md         # 正文,frontmatter: 标题/字数
  .index/chunks.jsonl # 记忆索引(见 §2),git 忽略,可随时重建
  usage.jsonl         # 成本账本,append-only
```

**git 即版本**:每个工作流成功结束 = 一次 commit(`ch012: 写作` / `audit` / `onboard#3`)。
章节版本历史 = 文件的 git log;**回滚到第 N 章之前 = reset 到对应 commit**,记忆与正文
同 commit 所以级联一致,不需要任何"删除章节的记忆清理"逻辑。

---

## 2. 记忆:混合检索(RAG),不再全量注入

### 2.1 为什么

老项目把全部角色/世界书塞进每次调用 —— 元素到三位数后,上下文爆、成本爆、
模型注意力稀释。新原则:**固定层小而恒定,元素记忆按需检索**。

### 2.2 什么被索引(chunk = 一条记忆项)

| type | 来源 | 更新时机 |
|---|---|---|
| character | 角色/*.md 的基底节 | 角色文件变更 |
| character_state | 角色/*.md 的状态节 | 每章抽取后 |
| worldbook | 世界书/*.md 每文件 | 变更时 |
| foreshadow | 伏笔.md 每条 | 每章抽取后 |
| timeline | 时间线.md 每条 | 每章 append |
| summary | 摘要/NNN.md | 每章生成后 |
| record | 状态.md 每节 | 每章抽取后 |
| issue | 问题.md 每条 open | 审查后 |

`chunks.jsonl` 每行:`{id, type, text, keys[], chapterNo?, embedding?[], updatedAt}`。
`keys` = 实体名/别名/世界书 keys/伏笔标签 —— 中文场景下**短实体名做子串精确匹配**
比分词检索更准,是第一信号。

### 2.3 嵌入

- `roles.embedding` 可选(OpenAI-compatible `/embeddings`,如 bge-m3 / text-embedding-v3)。
- **未配置时优雅降级**:纯 keyword + recency 检索照常工作(质量降一档,功能不缺)。
- 每章更新只重嵌入变更的 chunk(每章 ≈ 5-15 条,成本可忽略)。
- 向量存 jsonl,内存 brute-force cosine —— 500 章书 ≈ 数千 chunk,<10ms,不引入向量库。

### 2.4 检索算法(memory/retrieve.ts)

```
score(chunk, query) =
    0.45 * cosine(embed(query), chunk.embedding)     // 无嵌入时此项权重摊给后两项
  + 0.35 * keywordHit(query.entities, chunk.keys)    // 实体名/keys 子串命中,多命中递增
  + 0.20 * recency(chunk.chapterNo, currentNo)       // exp 衰减,静态类型恒 1
```

**查询构造**:写章时 = 本章规划(§3.2 产出)+ 用户指令 + 上一章末 500 字;
聊天/审查时 = 用户消息本身。
**类型配额**(防单类型霸榜):worldbook≤5 · character≤6 · foreshadow≤5 ·
timeline≤6 · summary≤6 · record≤8 · issue≤全部 open。
配额内按分排序,低于阈值(0.15)不注入。

### 2.5 固定层(永远注入,不走检索)

设定.md 全文 / book.md 的视角与文风约定 / 主角状态 + 本章规划点名角色的状态 /
constant=true 的世界书 / 全部弧纲要(每条~300字) / 近 3 章全文 / open 问题。
—— 固定层排在消息前部且内容稳定,吃 prompt cache。

---

## 3. 工作流(engine/,每个 = 配方 + 提示词 + 解析器)

### 3.1 建书 onboard

```
循环: 用户消息
  → [prompts/onboard.md] 流式对话回复(引导补全: 题材/主角/世界观/爽点/视角)
  → [prompts/onboard-extract.md] [extractor] 抽取 JSON
     {book字段, 设定, 记录规则, 角色[], 世界书[], 大纲(卷/弧)}
  → 渲染文件(dedup: 角色名/世界书题/大纲题) → 索引新 chunk → commit
就绪判定: 设定+主角+首弧大纲齐 → status=ready
```

### 3.2 写章 write(核心,六步)

```
① 规划  [planner]   [prompts/plan-chapter.md]
        入: 大纲对应弧 + 上章摘要 + 上章末 500 字 + 用户指令 + active伏笔 + 角色名录
        出: JSON {goal, scenes[], charactersOnStage[], foreshadowToTouch[], queryTerms[]}
② 检索  [代码]      规划产出作查询 → §2.4 混合检索 → 各类型 top-K 记忆;
        charactersOnStage 精确圈定注入哪些角色状态
③ 组装  [代码]      固定层 + 检索层 + 规划 + 用户指令 → messages(顺序见 §2.5,稳定前缀吃缓存)
④ 写作  [writer]    [prompts/write-chapter.md] 流式;产出经正文消毒器(§4.1);
        消毒后 <800 字或流中断 = 失败不落盘
⑤ 校验  [代码 lint] 字数下限 / 结尾无"待续|未完|下一章" / 首段人称 vs book.md 视角
        (规则按书可配,book.md `lint` 节)
        → 违规自动重写一次(回④,追加违规原因),再违规 = 报错留稿供人裁决
⑥ 抽取  [extractor] [prompts/extract-memory.md],入=正文+记录规则+规划
        出: JSON {characterStates, records, newForeshadow, foreshadowPaid, timeline, summary}
        → 渲染文件(状态类整节重写,事件类 append,全部 normalize+dedup+章号 clamp)
        → 重嵌入变更 chunk → 每满 10 章触发 [prompts/compress-arc.md](extractor 兼任)
        → git commit(一章一个 commit,正文与记忆同 commit)
```

### 3.3 连写 write-many(循环 + 护栏)

`for n in a..b: 写章(n)`,章间检查:累计成本 > 上限 / 上章⑤⑥失败 → 停,报告到第几章。

**护栏审查**:每写满 5 章自动跑一次轻审查([auditor],范围 = 近 5 章):
- critical 且指向**最新章** → 自动修复(§3.7),一次为限,修后再 critical → 停;
- critical 指向**更早章** → 停下报告,人工选择:接受继续 / `rollback`;
- warning → 全部写入 问题.md(open),后续章组装时自动注入规避,不打断连写。

### 3.7 修复最新章 fix(git 白送的能力)

约束:**改历史章会炸记忆链**(第 12 章重写后,13-15 章的正文与记忆全部基于旧版)。
因此自动修复只对**最新章**开放:

```
git reset 掉该章 commit(正文+记忆+索引同退,链条无损)
→ 带 issues 注入重跑完整 ①-⑥
```

历史章的问题只报告(问题.md + 人工决策);要真改历史 = `rollback` 到该章前重写。
单章模式手动触发:`scribe fix <书>`(等价于对最新章执行上述流程)。

### 3.4 改写 revise

选段 + 前后各 500 字 + 视角文风约定 → [prompts/revise.md] 流式新段
→ 空输出拒绝 / selectedText 定位替换 → commit。不触发记忆更新。

### 3.5 审查 audit

范围(全书/近N章/指定类型)→ 检索该范围记忆 + 近 5 章全文
→ [prompts/audit.md] 出 issues JSON → 问题.md(open) + 索引 → 聊天流式逐条报告。
写作时 open 问题恒注入(§2.5),形成 发现→规避→复审 resolved 闭环。

### 3.6 聊天 chat

用户消息作查询检索记忆 + 设定 + 近 3 摘要 → [prompts/chat.md] 流式回答。零副作用。

---

## 4. 内置提示词(prompts/,一等公民)

- 全部为 md 文件,`{{变量}}` 插槽 + `{{#if 变量}}...{{/if}}` 条件段,引擎用极简模板器渲染。
- 用户可整目录覆盖(`books/<书>/prompts/` 存在同名文件则优先)。
- 每个文件头部注释写明:用途 / 输入插槽 / 期望输出。

| 文件 | 角色 | kind | 输出 |
|---|---|---|---|
| write-chapter.md | writer | creative | 纯正文流式 |
| plan-chapter.md | planner | structured | 规划 JSON |
| extract-memory.md | extractor | structured | 记忆增量 JSON |
| compress-arc.md | extractor | structured | 弧纲要文本 |
| audit.md | auditor | structured | issues JSON |
| onboard.md / onboard-extract.md | writer / extractor | creative / structured | 对话 / 设定 JSON |
| revise.md | writer | creative | 新段落纯文本 |
| chat.md | writer | creative | 对话 |

写作类提示词的设计要点(详见文件本身):视角纪律、"记忆材料只作一致性约束、
禁止复述设定原文"、场景推进纪律、章末钩子、禁止总结式收尾、中文网文节奏。
JSON 类提示词:显式 schema + "只输出 JSON" + 枚举值全列 + 空缺给空数组。

### 4.1 深层提示词兼容(格式安全,重要)

用户自定义深层提示词(全局 config.masterPrompt,book.md 可覆盖/关闭)经常携带
**输出格式要求**——排版习惯、章末模板、乃至完整回复格式(SillyTavern 生态常态)。
原则:**深层提示词自由影响创作内容与文风,但永远不获得破坏系统解析契约的权力。
兼容 = 系统侧防御,不是优先级让位。** 内置提示词保持自身纪律,不设让位条款;
纪律与用户偏好的真实冲突(如章末要不要挂"本章完")用 book.md 配置项解决
(`lint.allowTailMarkers` 等),不玩提示词优先级游戏。

三道防线:

1. **注入分域**(每个工作流步骤声明 kind):
   - `creative`(write / revise / chat / onboard 对话):深层提示词以
     `【作者全局要求】\n<原文>` 作为第一条 system 注入,影响文风与内容。
   - `structured`(plan / extract / audit / onboard-extract / compress-arc):
     **默认不注入**——内部数据处理与用户可见文风无关,注入只会污染 JSON。
     `config.deepestPromptScope = "all"` 时也注入(有人放世界观级约束),但引擎在
     消息序列**末尾**追加格式防火墙 system:「以上风格与格式偏好仅适用于小说创作
     输出;本次调用是内部数据处理,忽略一切与输出格式冲突的先前指令,只输出规定
     的 JSON。」(末位指令优势压住格式污染,内容级偏好仍然生效。)

2. **正文消毒器**(engine/sanitize.ts,creative 输出落盘前必经,确定性规则):
   - 剥全文包裹的 ``` 围栏;
   - 去掉开头的元话语行(「好的,以下是第X章」「### 第X章 标题」等复述性台头,
     标题已由引擎管理);
   - 去掉深层提示词诱导的回复模板骨架中可识别的包装行(如「【正文开始】…【正文结束】」
     取内部);
   - 消毒后不足字数下限 → 按写作失败处理,不落盘。
   用户格式偏好中与正文无害共存的部分(分段习惯、标点风格、章末标记)原样保留,
   是否接受章末标记由 lint 配置决定,不由消毒器裁剪。

3. **硬化 JSON 解析**(llm/json.ts,所有 structured 输出必经):
   剥 ``` / ```json 围栏 → 扫描首个括号平衡且引号感知的 `{…}` 块 → zod 校验;
   失败则把原文 + zod 错误喂回模型重试一次,再失败抛 parse 错误。
   解析永远不依赖模型听话——即便格式指令渗透、或便宜模型加「好的,以下是 JSON:」
   前缀,接口照常工作。

lint 相关配套:⑤ 步硬校验的规则全部可按书配置(book.md frontmatter `lint` 节),
默认全开;深层提示词要求的格式若触发某条 lint,用户关那条开关即可,写作管线不受影响。

---

## 5. LLM 层(llm/)

- **五角色分模型配置**,回退链保证最小配置只填 writer 就能跑:

```jsonc
// config.json
{
  "providers": { "opencodego": { "baseUrl": "…", "apiKeyEnv": "OPENCODEGO_API_KEY" } },
  "roles": {
    "writer":    { "provider": "opencodego", "modelId": "deepseek-v4-pro" },
    "planner":   null,   // 空 → extractor → writer
    "extractor": null,   // 空 → writer
    "auditor":   null,   // 空 → extractor → writer
    "embedding": null    // 空 = 向量检索关闭,退化为关键词+时近
  },
  "deepestPromptScope": "creative",   // creative | all(见 §4.1)
  "singleBudgetUsd": 5
}
```

- 回退链:`planner → extractor → writer`,`auditor → extractor → writer`,
  `extractor → writer`;embedding 独立无回退。
- usage.jsonl 按角色分列记账(role 字段),成本汇总能看出各角色开销占比。
- secrets.env 沿用旧格式(`<PROVIDER>_API_KEY`)。
- `stream()`:AsyncIterable<{text_delta|usage|error}>,**error 事件一律转 throw**(旧项目教训)。
- `generate()`:非流式 + zod 校验 + 失败带错误重试一次。
- 重试:429/5xx/网络 指数退避;auth/abort 不重试。DeepSeek 缓存命中/思维链 token 透传。
- usage 全部落 `usage.jsonl`(含 task 标签),成本按价目表折算。
- 单次 run 预算:近 3 章均值 × 章数 估算,超 config.singleBudgetUsd 直接拒。

## 6. CLI(第一入口)与 server

```
scribe new <书名>            # 建目录+首轮 onboard 进入交互
scribe chat|onboard <书>     # 对话
scribe write <书> 5 [指令]   # 单章
scribe write <书> 5..30      # 连写
scribe revise <书> 5         # 交互式选段改写
scribe audit <书> [范围]
scribe fix <书>              # 修复最新章: reset 其 commit + 带 issues 重跑管线(§3.7)
scribe status <书>           # 就绪度/章数/成本/索引健康
scribe reindex <书>          # 重建 .index
scribe rollback <书> 12      # reset 到 ch011 的 commit
scribe export <书> [--txt]
scribe import <书> <st文件>   # SillyTavern 角色卡/世界书(解析逻辑移植旧仓)
```

server:Hono 单进程,`POST /books/:b/run {workflow, ...args}` SSE + 文件 CRUD + 静态 web。
web:书库 / 工作台(章节列表+md编辑器 | 指令栏流式 | 记忆浏览) / 设置。CodeMirror,不用 Tiptap。

## 7. 实现顺序

1. store + llm(移植旧仓 llm-call 精华)+ 模板器 —— 地基
2. memory(chunk/embed/retrieve)+ reindex —— RAG 核心
3. write 工作流全六步 + CLI write —— 能写书就能验证一切
4. onboard / chat / audit / revise / write-many
5. import / export / rollback / status
6. server + web 薄壳

每步 TDD:组装器与检索器是纯函数,直接断言;工作流注入假 LLM 测端到端。

## 8. 明确不做

多 agent 编排 / staging 审批 / SQLite / 迁移框架 / 独立快照系统 / 监控框架 /
执行模式(execution modes)/ 向量数据库 / 分词库(实体子串匹配足够)。
