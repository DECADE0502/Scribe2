import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = path.join(repoRoot, "src", "cli", "index.ts");

function runCli(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [tsxCli, cliEntry, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("CLI 冒烟", () => {
  it("--help 列出全部命令,输出全中文(无英文帮助残留)", () => {
    const res = runCli(["--help"]);
    const out = res.stdout;
    for (const cmd of ["write", "status", "reindex"]) expect(out).toContain(cmd);
    expect(out).toContain("用法");
    expect(out).toMatch(/[一-龥]/);
    expect(out).not.toContain("Usage:");
    expect(out).not.toContain("Options:");
    expect(out).not.toContain("Commands:");
    expect(res.status).toBe(0);
  });

  it("书不存在 → 中文报错含错误码,退出码非 0", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2cli-"));
    const res = runCli(["status", "不存在的书"], tmp);
    const err = res.stderr + res.stdout;
    expect(err).toContain("book_not_found");
    expect(err).toMatch(/[一-龥]/);
    expect(res.status).not.toBe(0);
  });

  it("书名含路径分隔符 → 拒绝(bad_book_name)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2cli-"));
    const res = runCli(["status", "../外面的书"], tmp);
    expect(res.stderr + res.stdout).toContain("bad_book_name");
    expect(res.status).not.toBe(0);
  });

  it("章号格式非法 → 中文报错含错误码", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s2cli-"));
    fs.mkdirSync(path.join(tmp, "books", "某书"), { recursive: true });
    const res = runCli(["write", "某书", "abc"], tmp);
    expect(res.stderr + res.stdout).toContain("bad_chapter_range");
    expect(res.status).not.toBe(0);
  });
});
