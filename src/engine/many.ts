import type { BookStore } from "./../store/book.js";
import { commitAll, resetToBefore } from "./../store/git.js";
import { rebuildIndex } from "./../memory/index.js";
import { writeChapter, type GenerateRole, type WriteDeps, type WriteResult } from "./write.js";
import { collectAuditIssues, issueInputOf, type AuditDeps } from "./audit.js";

const pad3 = (n: number) => String(n).padStart(3, "0");
const GUARD_EVERY = 5;
const GUARD_RANGE = 5;

export interface ManyDeps extends WriteDeps {
  auditor: GenerateRole;
  /** 本次连写的成本上限(美元);配 costProbe 使用 */
  runBudgetUsd?: number;
  /** 返回本次运行已产生的成本(美元) */
  costProbe?: () => number;
  onChapterStart?: (no: number) => void;
  onChapterDone?: (no: number, result: WriteResult) => void;
}

export interface ManyResult {
  completed: number[];
  stoppedAt?: number;
  reason?: string;
}

/**
 * 修复最新章(SPEC §3.7):git reset 掉该章 commit(正文+记忆+索引同退)
 * → 把 issues 写回 问题.md → 带着它们重跑完整六步 → 新 commit。
 * 只对最新章开放:改历史章会炸后续章的记忆链。
 */
export async function fixLatest(
  store: BookStore,
  deps: WriteDeps,
  issues?: Array<{ type: string; chapterNo: number; note: string }>,
): Promise<WriteResult> {
  const latest = store.listChapters().at(-1);
  if (latest === undefined) {
    throw new Error("本书还没有任何章节,无可修复(no_chapter_to_fix)");
  }
  // reset 会连问题.md 一起退回,先把要携带的 issues 攒在内存里
  const keep =
    issues ??
    store.listOpenIssues().map((i) => ({ type: i.type, chapterNo: i.chapterNo, note: i.note }));
  resetToBefore(store.dir, `ch${pad3(latest)}`);
  store.addIssues(keep);
  await rebuildIndex(store, deps.embedder); // .index 不入 git,reset 后必须重建
  return writeChapter(store, latest, "", deps);
}

/** 护栏审查(SPEC §3.3)。返回 null=放行;返回字符串=停下的中文原因。 */
async function guardAudit(store: BookStore, deps: ManyDeps, latest: number): Promise<string | null> {
  const auditDeps: AuditDeps = {
    auditor: deps.auditor,
    retrieve: deps.retrieve,
    embedder: deps.embedder,
    config: deps.config,
    ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
  };
  const first = await collectAuditIssues(store, GUARD_RANGE, auditDeps);
  if (!first.issues.length) return null;

  const historical = first.issues.filter((i) => i.severity === "critical" && i.chapterNo < latest);
  if (historical.length) {
    store.addIssues(first.issues.map(issueInputOf));
    commitAll(store.dir, "audit: 护栏发现历史章 critical,停下");
    return `护栏发现历史章 critical(第${historical[0]!.chapterNo}章):${historical[0]!.note}。改历史章会炸记忆链,请人工决策——接受继续,或 rollback 到该章前重写(historical_critical)`;
  }

  const criticalLatest = first.issues.filter(
    (i) => i.severity === "critical" && i.chapterNo === latest,
  );
  if (criticalLatest.length) {
    await fixLatest(store, deps, first.issues.map(issueInputOf));
    const second = await collectAuditIssues(store, GUARD_RANGE, auditDeps);
    const still = second.issues.filter((i) => i.severity === "critical" && i.chapterNo === latest);
    if (still.length) {
      store.addIssues(second.issues.map(issueInputOf));
      commitAll(store.dir, "audit: 护栏修复后仍 critical,停下");
      return `第${latest}章自动修复一次后仍有 critical:${still[0]!.note}(guard_critical)`;
    }
    return null;
  }

  // 只有 warning:入 问题.md(后续章组装时自动注入规避),不打断连写
  store.addIssues(first.issues.map(issueInputOf));
  commitAll(store.dir, `audit: 护栏 warning ${first.issues.length} 条`);
  return null;
}

/** 连写(SPEC §3.3):逐章写,章间查成本;每写满 5 章跑一次护栏审查。 */
export async function writeMany(
  store: BookStore,
  from: number,
  to: number,
  deps: ManyDeps,
): Promise<ManyResult> {
  const completed: number[] = [];
  let writtenThisRun = 0;
  for (let no = from; no <= to; no++) {
    if (deps.runBudgetUsd !== undefined && deps.costProbe) {
      const spent = deps.costProbe();
      if (spent > deps.runBudgetUsd) {
        return {
          completed,
          stoppedAt: no,
          reason: `本次连写已花 $${spent.toFixed(2)},超过单次预算 $${deps.runBudgetUsd},停在开写前(budget_exceeded)`,
        };
      }
    }
    deps.onChapterStart?.(no);
    try {
      const result = await writeChapter(store, no, "", deps);
      deps.onChapterDone?.(no, result);
    } catch (e) {
      return {
        completed,
        stoppedAt: no,
        reason: `第 ${no} 章写作失败:${e instanceof Error ? e.message : String(e)}(write_failed)`,
      };
    }
    completed.push(no);
    writtenThisRun += 1;
    if (writtenThisRun % GUARD_EVERY === 0) {
      const stop = await guardAudit(store, deps, no);
      if (stop) return { completed, stoppedAt: no + 1, reason: stop };
    }
  }
  return { completed };
}
