# Scribe2 项目指引(新 session 从这里开始)

长篇小说写作引擎,全新重写(前身在 `D:\desktop\Scribe-gh`,其教训已吸收进设计,勿回去改它)。
核心命题:连续写几百章不失忆。三条铁律:**文件即记忆 / 检索即注入 / 提示词一等公民**。

## 当前状态(2026-07-03 交接)

- ✅ 设计定稿:`docs/SPEC.md`(必读——五角色管线/混合检索/深层提示词兼容/git即版本)
- ✅ 实现计划:`docs/PLAN.md`(23 任务 6 阶段,任务级 TDD + 阶段级 live 剧本)
- ✅ 内置提示词 9 份:`prompts/`(已按设计写好,实现时不要随手改动其契约)
- ✅ 工程骨架 + 依赖已装(pnpm);`docs/reference/` 有旧仓验证过的可移植代码
- ❌ 代码未开始 —— **从 PLAN 阶段1 Task 1 开工**

## 怎么干

- 严格按 `docs/PLAN.md` 顺序执行,TDD:失败测试 → 实现 → 绿 → 小步 commit。
- 每个 Gate(A-F)跑完 live 剧本后**必须停下等用户人工验收**,点头才进下一阶段。
- 计划里发现 bug/与现实不符(依赖版本、API 形状),修正并在汇报中说明,不要闷头绕。
- 产品里**没有自治 agent**:只有固定管线 + 五个可配模型角色。不要引入任何多 agent 编排。

## 约定

- 用户沟通:**中文、简洁、别废话**;汇报领着结论走。
- CLI 输出与 web UI **全中文**(SPEC §6:`中文说明(错误码)` 格式)。
- commit 信息:`type(scope): 中文描述`,结尾 `Co-Authored-By: Claude <上下文里的署名>`。
- **secrets.env 永不入库**(.gitignore 已覆盖,commit 前看 `git status`)。
- 本仓暂无 remote;将来建 remote 后注意:此机器上 `git push` 可能被公司网关拦,旧仓用的是
  `git send-pack git@github.com:<owner>/<repo>.git <branch>`。

## 测试与 key

- `pnpm test` = unit(全假 LLM,快);`pnpm test:live` = 真 DeepSeek(读 secrets.env)。
- `secrets.env` 里 `DEEPSEEK_API_KEY` 可用(已验证),baseUrl `https://api.deepseek.com`,
  live 一律用 `deepseek-chat`(便宜);**DeepSeek 无 embeddings 端点**,live 全在
  关键词+时近检索模式跑,向量路径用假嵌入器单测——这是设计内的优雅降级,不是缺陷。
- live 写作把书目标字数压到 1200 控成本。

## 环境坑(Windows + Git Bash)

- shell 里直接传中文 JSON 会乱码 → 先写临时文件再 `curl -d @file`。
- 行尾:仓库会出 LF→CRLF warning,无害,别为它折腾。
- better-sqlite3 类原生模块本项目**不需要**(无 SQLite,别引入)。

## 参考代码(docs/reference/,只读不 import)

| 文件 | 移植去处 |
|---|---|
| llm-call.ts / retry.ts / deepseek-metadata.ts | PLAN Task 2(流式/重试/缓存字段读取的成熟写法) |
| import-service.ts + sillytavern-*.ts | PLAN Task 20(ST 导入解析器) |
