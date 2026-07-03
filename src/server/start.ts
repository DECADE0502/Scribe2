// 生产入口:pnpm serve(或双击 启动.bat)。API + web/dist 静态文件,单进程。
// 控制台输出带时间戳,同时落 logs/server-日期.log(排查历史问题用)。
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import * as fs from "node:fs";
import * as path from "node:path";
import { createApp } from "./index.js";

const cwd = process.cwd();

function setupLogging(): string {
  const dir = path.join(cwd, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `server-${day}.log`);
  const stream = fs.createWriteStream(file, { flags: "a" });
  const clock = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
  for (const level of ["log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const line = args
        .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)))
        .join(" ");
      original(`[${clock()}] ${line}`);
      stream.write(`[${new Date().toISOString()}] [${level}] ${line}\n`);
    };
  }
  return file;
}

const logFile = setupLogging();
const app = createApp({ booksRoot: path.join(cwd, "books") });

const webDist = path.join(cwd, "web", "dist");
if (fs.existsSync(webDist)) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("/", serveStatic({ path: "./web/dist/index.html" }));
} else {
  app.get("/", (c) => c.text("web 未构建:先在 web/ 目录执行 pnpm build(仅 API 模式照常可用)"));
}

const port = Number(process.env.SCRIBE_PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log("=".repeat(56));
  console.log(`Scribe 写作台已启动:http://localhost:${info.port}`);
  console.log(`书目录:${path.join(cwd, "books")}`);
  console.log(`日志文件:${logFile}`);
  console.log("停止服务:本窗口按 Ctrl+C,或直接关闭窗口");
  console.log("=".repeat(56));
});
