// 生产入口:pnpm serve。API + web/dist 静态文件,单进程。
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import * as fs from "node:fs";
import * as path from "node:path";
import { createApp } from "./index.js";

const cwd = process.cwd();
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
  console.log(`Scribe server 已启动:http://localhost:${info.port}(书目录:${path.join(cwd, "books")})`);
});
