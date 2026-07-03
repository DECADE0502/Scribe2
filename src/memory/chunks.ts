import type { Chunk } from "./../types.js";
import type { BookStore } from "./../store/book.js";

/**
 * 书文件 → chunk[](SPEC §2.2 的 8 类)。
 * id 用「type:名称」拼,内容不变则 id 不变——增量索引与嵌入复用全靠它。
 * 弧纲要与设定不在此列:它们属于固定注入层,不走检索。
 */
export function chunksFromBook(store: BookStore): Chunk[] {
  const now = Date.now();
  const chunks: Chunk[] = [];

  for (const c of store.listCharacters()) {
    const keys = [c.name, ...c.aliases];
    chunks.push({
      id: `character:${c.name}`,
      type: "character",
      text: `${c.name}(${c.role})\n${c.base}`,
      keys,
      updatedAt: now,
    });
    chunks.push({
      id: `character_state:${c.name}`,
      type: "character_state",
      text: `${c.name} 当前状态:${c.state}`,
      keys,
      updatedAt: now,
    });
  }

  for (const w of store.listWorldbooks()) {
    chunks.push({
      id: `worldbook:${w.title}`,
      type: "worldbook",
      text: `${w.title}\n${w.body}`,
      keys: w.keys,
      updatedAt: now,
    });
  }

  for (const f of store.listForeshadows()) {
    chunks.push({
      id: `foreshadow:${f.label}`,
      type: "foreshadow",
      text: `伏笔「${f.label}」(${f.status === "active" ? "未回收" : "已回收"},埋于第${f.chapterNo}章):${f.note}`,
      keys: [f.label, ...f.characters],
      chapterNo: f.chapterNo,
      updatedAt: now,
    });
  }

  for (const t of store.listTimeline()) {
    chunks.push({
      id: `timeline:${t.storyTime}|${t.event}`,
      type: "timeline",
      text: `第${t.chapterNo}章 ${t.storyTime}:${t.event}(${t.participants.join(",")})`,
      keys: t.participants,
      chapterNo: t.chapterNo,
      updatedAt: now,
    });
  }

  for (const no of store.listSummaries()) {
    const s = store.readSummary(no);
    chunks.push({
      id: `summary:${no}`,
      type: "summary",
      text: `第${no}章摘要:${s.brief}\n${s.paragraph}`,
      keys: s.events,
      chapterNo: no,
      updatedAt: now,
    });
  }

  for (const [section, content] of Object.entries(store.readRecords())) {
    chunks.push({
      id: `record:${section}`,
      type: "record",
      text: `${section}:${content}`,
      keys: [section],
      updatedAt: now,
    });
  }

  // issue 的 type 是英文枚举,中文查询实体永远打不中——keys 给中文词 + 章号标签
  const ISSUE_TYPE_ZH: Record<string, string> = {
    continuity: "连贯性",
    character: "角色",
    foreshadow: "伏笔",
    setting: "设定",
    perspective: "视角",
    pacing: "节奏",
  };
  for (const issue of store.listOpenIssues()) {
    chunks.push({
      id: `issue:${issue.id}`,
      type: "issue",
      text: `未解决问题(${ISSUE_TYPE_ZH[issue.type] ?? issue.type},第${issue.chapterNo}章):${issue.note}`,
      keys: [ISSUE_TYPE_ZH[issue.type] ?? issue.type, `第${issue.chapterNo}章`],
      chapterNo: issue.chapterNo,
      updatedAt: now,
    });
  }

  return chunks;
}
