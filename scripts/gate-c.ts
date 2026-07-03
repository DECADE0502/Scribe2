// Gate C 模拟人类剧本(对着仓库根跑,产出留给用户亲手续玩):
//   1. 布置 books/演示书(fixture 副本,目标字数 1200)+ config.json;
//   2. scribe write 演示书 1 -m "林尘初到黑水镇,结尾埋一个陌生人跟踪的钩子";
//   3. scribe write 演示书 2(纯大纲驱动);
//   4. 打印验收要点。之后用户可跑:pnpm dev write 演示书 3 -m "自由发挥"
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { BookStore } from "../src/store/book.js";
import { summarizeUsage } from "../src/llm/usage.js";

const root = path.resolve(import.meta.dirname, "..");
const bookDir = path.join(root, "books", "演示书");

// 读 secrets.env(与 CLI 同一回退逻辑依赖 process.env)
const secrets = path.join(root, "secrets.env");
if (fs.existsSync(secrets)) {
  for (const line of fs.readFileSync(secrets, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
    if (m && !(m[1]! in process.env)) process.env[m[1]!] = m[2]!;
  }
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("缺 DEEPSEEK_API_KEY(secrets.env),无法跑 live 剧本(missing_api_key)");
  process.exit(1);
}

const configPath = path.join(root, "config.json");
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        providers: { deepseek: { baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY" } },
        roles: { writer: { provider: "deepseek", modelId: "deepseek-chat" } },
        deepestPromptScope: "creative",
        singleBudgetUsd: 5,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log("已生成 config.json(deepseek-chat)");
}

fs.rmSync(bookDir, { recursive: true, force: true });
fs.cpSync(path.join(root, "tests", "fixtures", "demo-book"), bookDir, { recursive: true });
new BookStore(bookDir).writeMeta({ targetWords: 1200 });
console.log("已布置 books/演示书(目标字数 1200)\n");

function scribe(...args: string[]): void {
  const res = spawnSync(
    process.execPath,
    [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(root, "src", "cli", "index.ts"), ...args],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (res.status !== 0) {
    console.error(`\n剧本中断:scribe ${args.join(" ")} 退出码 ${res.status}`);
    process.exit(1);
  }
}

console.log("$ scribe write 演示书 1 -m 林尘初到黑水镇,结尾埋一个陌生人跟踪的钩子");
scribe("write", "演示书", "1", "-m", "林尘初到黑水镇,结尾埋一个陌生人跟踪的钩子");

console.log("\n$ scribe write 演示书 2");
scribe("write", "演示书", "2");

const store = new BookStore(bookDir);
const usage = summarizeUsage(bookDir);
console.log("\n===== Gate C 剧本完成 =====");
console.log(`第1章:${store.readChapter(1).text.length} 字;第2章:${store.readChapter(2).text.length} 字`);
console.log(`伏笔:${store.listForeshadows().map((f) => `${f.label}[${f.status}]`).join("、")}`);
console.log(`成本:$${usage.totalCostUsd.toFixed(4)}`);
console.log("\n下一步(人工验收):pnpm dev write 演示书 3 -m \"自由发挥\"");
console.log("检查 books/演示书/ 下的 摘要/ 状态.md 伏笔.md 时间线.md 是否像人话。");
