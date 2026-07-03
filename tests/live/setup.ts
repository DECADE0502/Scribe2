// live 测试前置:读仓库根 secrets.env,把 KEY=VALUE 注入 process.env(不覆盖已有值)。
import * as fs from "node:fs";
import * as path from "node:path";

const file = path.resolve(import.meta.dirname, "..", "..", "secrets.env");
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
