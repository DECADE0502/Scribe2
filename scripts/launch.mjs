// 一键启动(由 启动.bat 调起,也可直接 node scripts/launch.mjs):
// 预检环境/依赖/配置 → 处理端口冲突 → 自动开浏览器 → 前台起服务(本窗口即日志窗口)。
// 只用 Node 内置模块:.bat 一侧保持纯 ASCII,绕开 cmd 换码页解析坑。
import { spawnSync, spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const PORT = Number(process.env.SCRIBE_PORT ?? 8787);

const log = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(`[错误] ${msg}`);
  process.exit(1);
};

function run(command, cwd = root) {
  // 单串 + shell:true:pnpm 是 .cmd 必须走 shell;参数全为静态串,无注入面
  const res = spawnSync(command, { cwd, stdio: "inherit", shell: true });
  return res.status === 0;
}

log("==========================================================");
log("  Scribe 写作台 · 一键启动");
log("  本窗口全程显示服务日志,请保持开启;关闭窗口即停止服务");
log("==========================================================");

// ---------- 环境与依赖 ----------
if (spawnSync("pnpm --version", { shell: true }).status !== 0) {
  fail("未找到 pnpm,请先执行:npm i -g pnpm");
}
if (!fs.existsSync(path.join(root, "node_modules"))) {
  log("[准备] 首次运行,安装依赖……");
  if (!run("pnpm install")) fail("依赖安装失败");
}
const webDir = path.join(root, "web");
if (!fs.existsSync(path.join(webDir, "node_modules"))) {
  log("[准备] 安装 web 依赖……");
  if (!run("pnpm install", webDir)) fail("web 依赖安装失败");
}
if (!fs.existsSync(path.join(webDir, "dist", "index.html"))) {
  log("[准备] 构建 web 界面……");
  if (!run("pnpm build", webDir)) fail("web 构建失败");
}

// ---------- 配置 ----------
const configPath = path.join(root, "config.json");
if (!fs.existsSync(configPath)) {
  log("[准备] 生成默认 config.json(deepseek-chat)……");
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
}
const secretsPath = path.join(root, "secrets.env");
if (!fs.existsSync(secretsPath)) {
  log("[提示] 缺少 secrets.env —— 请在本目录创建它并写入一行:");
  log("        DEEPSEEK_API_KEY=你的密钥");
  log("        没有密钥也能打开界面,但无法调用模型写作。");
} else if (!/^DEEPSEEK_API_KEY=.+/m.test(fs.readFileSync(secretsPath, "utf8"))) {
  log("[提示] secrets.env 里没找到 DEEPSEEK_API_KEY,写作会失败");
}

// ---------- 端口冲突 ----------
function pidsOnPort(port) {
  try {
    const out = execSync(`netstat -ano -p tcp`, { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(`:${port} `) && /LISTENING/i.test(line)) {
        const pid = line.trim().split(/\s+/).at(-1);
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

const oldPids = pidsOnPort(PORT);
if (oldPids.length) {
  log(`[提示] 端口 ${PORT} 已被占用(PID ${oldPids.join(", ")}),可能是上次未关闭的服务。`);
  let kill = true;
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("结束旧进程并继续启动?(Y=是,N=退出) ")).trim().toLowerCase();
    rl.close();
    kill = answer === "" || answer === "y" || answer === "yes" || answer === "是";
  }
  if (!kill) process.exit(1);
  for (const pid of oldPids) spawnSync("taskkill", ["/f", "/pid", pid]);
  log("[准备] 旧进程已结束。");
}

// ---------- 启动 ----------
if (!process.env.SCRIBE_NO_BROWSER) {
  setTimeout(() => {
    spawn("cmd", ["/c", "start", "", `http://localhost:${PORT}/`], { detached: true, stdio: "ignore" }).unref();
  }, 2000);
}
log("");
log(`[启动] 服务启动中,浏览器将自动打开 http://localhost:${PORT}/`);
log("[日志] 下方为实时详细日志(同步写入 logs\\ 目录);按 Ctrl+C 或关窗停止");
log("----------------------------------------------------------");

const server = spawnSync("pnpm serve", { stdio: "inherit", shell: true, env: process.env });
log("");
log("[已停止] 服务已退出。");
process.exit(server.status ?? 0);
