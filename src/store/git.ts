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

/** 回滚:找到最新一条 message 以 prefix 开头的 commit,硬 reset 到它的父提交。 */
export function resetToBefore(dir: string, prefix: string): void {
  const entry = log(dir).find((e) => e.message.startsWith(prefix));
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
