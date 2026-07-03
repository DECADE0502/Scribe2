import type { EmbeddingModel } from "ai";
import type { BookStore } from "./../store/book.js";
import { resetToBefore } from "./../store/git.js";
import { rebuildIndex } from "./../memory/index.js";

export type ExportFormat = "md" | "txt";

const pad3 = (n: number) => String(n).padStart(3, "0");

/** 单章导出:md 用「# 第N章 标题」台头;txt 纯文本(frontmatter 由 readChapter 天然剥掉)。 */
export function exportChapter(store: BookStore, no: number, format: ExportFormat): string {
  const chapter = store.readChapter(no);
  const head = `第${no}章${chapter.title ? ` ${chapter.title}` : ""}`;
  return format === "md" ? `# ${head}\n\n${chapter.text}\n` : `${head}\n\n${chapter.text}\n`;
}

/** 全书导出:章节升序拼接。 */
export function exportBook(store: BookStore, format: ExportFormat): string {
  const chapters = store.listChapters();
  if (chapters.length === 0) {
    throw new Error("本书还没有任何章节,无可导出(no_chapters)");
  }
  const meta = store.readMeta();
  const head = format === "md" ? `《${meta.name}》\n\n` : `《${meta.name}》\n\n`;
  return head + chapters.map((no) => exportChapter(store, no, format)).join("\n");
}

/**
 * 回滚(SPEC §1/§6):reset 到 chNNN 的 commit 之前——正文与记忆同 commit 级联一致。
 * .index 不入 git,reset 后必须自动重建,否则索引里还留着被回滚章节的块。
 */
export async function rollbackBook(
  store: BookStore,
  chapterNo: number,
  embedder: EmbeddingModel<string> | null,
): Promise<void> {
  resetToBefore(store.dir, `ch${pad3(chapterNo)}`);
  await rebuildIndex(store, embedder);
}
