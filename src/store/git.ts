import { spawnSync } from "node:child_process";

function runGit(dir: string, args: string[], input?: string): string {
  const res = spawnSync("git", args, { cwd: dir, encoding: "utf8", input });
  if (res.error) {
    throw new Error(`git 不可用:${res.error.message}(git_unavailable)`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(`git ${args[0]} 失败:${detail}(git_failed)`);
  }
  return res.stdout;
}

/** 书目录初始化为独立 git 仓库(幂等);本地身份固定,不依赖机器全局配置。 */
export function initRepo(dir: string): void {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.name", "Scribe"]);
  runGit(dir, ["config", "user.email", "scribe@local"]);
  runGit(dir, ["config", "core.autocrlf", "false"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
}

export interface LogEntry {
  hash: string;
  message: string;
}

/** 提交历史,最新在前;空仓库返回 []。 */
export function log(dir: string): LogEntry[] {
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir, encoding: "utf8" });
  if (head.status !== 0) return [];
  const out = runGit(dir, ["log", "--pretty=format:%H\t%s"]);
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { hash: line.slice(0, tab), message: line.slice(tab + 1) };
    });
}

/** 全量提交;无变更时静默跳过(返回 null)。中文 message 走 stdin,绕开 Windows 参数编码坑。 */
export function commitAll(dir: string, message: string): string | null {
  runGit(dir, ["add", "-A"]);
  if (runGit(dir, ["status", "--porcelain"]).trim() === "") return null;
  runGit(dir, ["commit", "-q", "-F", "-"], message);
  return runGit(dir, ["rev-parse", "HEAD"]).trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 回滚:找到**最早**一条 message 匹配 prefix 的 commit,硬 reset 到它的父提交——
 * 这样该章的原写作与其后全部改写/编辑一并退掉(级联一致)。
 * prefix 后必须是 ":"、"-"、空格或结尾,防止 ch001 误命中 ch0010。
 */
export function resetToBefore(dir: string, prefix: string): void {
  const boundary = new RegExp(`^${escapeRe(prefix)}([:\\- ]|$)`);
  const matches = log(dir).filter((e) => boundary.test(e.message));
  const entry = matches.at(-1); // log 最新在前 → 末尾即最早
  if (!entry) {
    throw new Error(`找不到以「${prefix}」开头的提交(commit_not_found)`);
  }
  const parent = spawnSync("git", ["rev-parse", "--verify", `${entry.hash}^`], {
    cwd: dir,
    encoding: "utf8",
  });
  if (parent.status !== 0) {
    throw new Error(`提交「${entry.message}」没有父提交,无法回退到它之前(no_parent_commit)`);
  }
  runGit(dir, ["reset", "--hard", "-q", parent.stdout.trim()]);
}

/** 当前 HEAD 的 hash(修复流程 reset 前先记下,失败好恢复)。 */
export function headOf(dir: string): string {
  return runGit(dir, ["rev-parse", "HEAD"]).trim();
}

/** 硬恢复到指定 commit。 */
export function resetToCommit(dir: string, hash: string): void {
  runGit(dir, ["reset", "--hard", "-q", hash]);
}

/**
 * 把工作区恢复到 HEAD 的干净状态(落盘中途失败时用):
 * 先清掉五个内容子目录里的未跟踪残骸(不动 .index 与书根的用户散件),再还原已跟踪文件。
 */
export function restoreWorktree(dir: string): void {
  runGit(dir, ["clean", "-fdq", "--", "章节", "摘要", "角色", "世界书", "弧"]);
  runGit(dir, ["checkout", "-q", "--", "."]);
}
