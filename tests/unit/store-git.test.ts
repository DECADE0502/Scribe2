import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initRepo, commitAll, log, resetToBefore } from "../../src/store/git.js";

function tmpRepo(): string {
  // 用例书名用中文,验证 Windows 中文路径可用
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "s2git-")), "中文书名");
  fs.mkdirSync(dir, { recursive: true });
  initRepo(dir);
  return dir;
}

describe("store/git", () => {
  it("initRepo → commitAll → log 含该条", () => {
    const dir = tmpRepo();
    fs.writeFileSync(path.join(dir, "章节001.md"), "第一章正文", "utf8");
    commitAll(dir, "ch001: 写作");
    const entries = log(dir);
    expect(entries[0]!.message).toBe("ch001: 写作");
  });

  it("resetToBefore 回到指定 commit 之前,文件级联回退", () => {
    const dir = tmpRepo();
    fs.writeFileSync(path.join(dir, "a.md"), "v1", "utf8");
    commitAll(dir, "ch001: 写作");
    fs.writeFileSync(path.join(dir, "a.md"), "v2", "utf8");
    fs.writeFileSync(path.join(dir, "b.md"), "新文件", "utf8");
    commitAll(dir, "ch002: 写作");
    resetToBefore(dir, "ch002");
    expect(fs.readFileSync(path.join(dir, "a.md"), "utf8")).toBe("v1");
    expect(fs.existsSync(path.join(dir, "b.md"))).toBe(false);
    expect(log(dir)[0]!.message).toBe("ch001: 写作");
  });

  it("resetToBefore 找最新匹配前缀(同前缀多个 commit 时)", () => {
    const dir = tmpRepo();
    fs.writeFileSync(path.join(dir, "a.md"), "v1", "utf8");
    commitAll(dir, "ch001: 写作");
    fs.writeFileSync(path.join(dir, "a.md"), "v2", "utf8");
    commitAll(dir, "ch001-revise: 改写");
    fs.writeFileSync(path.join(dir, "a.md"), "v3", "utf8");
    commitAll(dir, "ch001-revise: 再改");
    resetToBefore(dir, "ch001-revise: 再改");
    expect(fs.readFileSync(path.join(dir, "a.md"), "utf8")).toBe("v2");
  });

  it("前缀边界:ch001 不误匹配 ch0010;回滚取最早一条该章 commit(连带其改写一起退)", () => {
    const dir = tmpRepo();
    fs.writeFileSync(path.join(dir, "base.md"), "基线", "utf8");
    commitAll(dir, "init");
    fs.writeFileSync(path.join(dir, "a.md"), "v1", "utf8");
    commitAll(dir, "ch001: 写作");
    fs.writeFileSync(path.join(dir, "a.md"), "v2", "utf8");
    commitAll(dir, "ch0010: 写作"); // 更新的、前缀相同的长章号
    fs.writeFileSync(path.join(dir, "a.md"), "v3", "utf8");
    commitAll(dir, "ch001-revise: 改写"); // ch001 的改写 commit(更新)
    resetToBefore(dir, "ch001");
    // 目标 = 最早那条 ch001 的父(init):a.md 消失,基线仍在
    expect(fs.existsSync(path.join(dir, "a.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "base.md"))).toBe(true);
  });

  it("前缀不存在 → 中文报错含错误码", () => {
    const dir = tmpRepo();
    fs.writeFileSync(path.join(dir, "a.md"), "v1", "utf8");
    commitAll(dir, "ch001: 写作");
    expect(() => resetToBefore(dir, "ch999")).toThrow(/commit_not_found/);
  });

  it("commitAll 无变更时不产生空 commit 也不报错", () => {
    const dir = tmpRepo();
    fs.writeFileSync(path.join(dir, "a.md"), "v1", "utf8");
    commitAll(dir, "ch001: 写作");
    commitAll(dir, "空提交尝试");
    expect(log(dir)).toHaveLength(1);
  });
});
