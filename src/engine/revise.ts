import type { Config, Usage } from "./../types.js";
import type { BookStore } from "./../store/book.js";
import { commitAll } from "./../store/git.js";
import { loadPrompt, renderTemplate } from "./../template.js";
import { deepestPromptFor } from "./context.js";
import { sanitizeProse } from "./sanitize.js";
import { lintProse } from "./lint.js";
import type { StreamRole } from "./write.js";

export interface ReviseDeps {
  rewriter: StreamRole;
  config: Config;
  onUsage?: (role: string, usage: Usage) => void;
  onDelta?: (delta: string) => void;
}

export interface ReviseInput {
  chapterNo: number;
  selected: string;
  instruction: string;
  /** 选段在章内重复出现时用它定位(0 起) */
  occurrenceIndex?: number;
}

export interface ReviseResult {
  newSegment: string;
}

const CONTEXT_CHARS = 500;
const pad3 = (n: number) => String(n).padStart(3, "0");

/** 改写(SPEC §3.4):选段 ±500 字上下文 → 流式新段 → 精确替换 → commit。不触发记忆更新。 */
export async function reviseSegment(
  store: BookStore,
  input: ReviseInput,
  deps: ReviseDeps,
): Promise<ReviseResult> {
  const meta = store.readMeta();
  const chapter = store.readChapter(input.chapterNo);
  const text = chapter.text;
  const selected = input.selected;
  if (!selected.trim()) {
    throw new Error("选段为空(selection_not_found)");
  }

  const indices: number[] = [];
  for (let i = text.indexOf(selected); i !== -1; i = text.indexOf(selected, i + 1)) {
    indices.push(i);
  }
  if (indices.length === 0) {
    throw new Error(`选段在第 ${input.chapterNo} 章中找不到,请原样复制正文片段(selection_not_found)`);
  }
  let idx: number;
  if (indices.length > 1) {
    if (input.occurrenceIndex === undefined) {
      throw new Error(
        `选段在第 ${input.chapterNo} 章出现 ${indices.length} 次,请用 occurrenceIndex(0 起)定位(ambiguous_selection)`,
      );
    }
    const located = indices[input.occurrenceIndex];
    if (located === undefined) {
      throw new Error(
        `occurrenceIndex=${input.occurrenceIndex} 越界(共 ${indices.length} 处)(ambiguous_selection)`,
      );
    }
    idx = located;
  } else {
    idx = indices[0]!;
  }

  const before = text.slice(Math.max(0, idx - CONTEXT_CHARS), idx);
  const after = text.slice(idx + selected.length, idx + selected.length + CONTEXT_CHARS);
  const prompt = renderTemplate(loadPrompt("revise", store.dir), {
    视角: meta.pov ?? "第三人称",
    文风: meta.style ?? "自然流畅",
    前文: before || "(选段在章首)",
    选段: selected,
    后文: after || "(选段在章末)",
    指令: input.instruction.trim() || "润色表达,不改事实",
  });

  const envelope = deepestPromptFor("creative", deps.config, meta);
  let raw = "";
  for await (const ev of deps.rewriter({
    messages: [...envelope.prefix, { role: "user", content: prompt }],
    onUsage: (u) => deps.onUsage?.("writer", u),
  })) {
    raw += ev.delta;
    deps.onDelta?.(ev.delta);
  }

  const newSegment = sanitizeProse(raw);
  if (!newSegment.trim()) {
    throw new Error("改写输出为空,已拒绝落盘(empty_revision)");
  }
  const verdict = lintProse(newSegment, {
    minChars: 0,
    allowTailMarkers: meta.lint?.["allowTailMarkers"] === true,
  });
  if (!verdict.ok) {
    throw new Error(`改写稿未通过校验:${verdict.detail}(${verdict.reason})`);
  }

  const newText = text.slice(0, idx) + newSegment + text.slice(idx + selected.length);
  store.writeChapter(input.chapterNo, newText, chapter.title);
  commitAll(store.dir, `ch${pad3(input.chapterNo)}-revise: 改写`);
  return { newSegment };
}
