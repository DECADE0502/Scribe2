import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";

const pad3 = (n: number) => String(n).padStart(3, "0");

/** 行内字段里的竖线会破坏「a | b | c」行格式,渲染前替换掉。 */
const noPipe = (s: string) => s.replace(/\|/g, "/").trim();

/** 实体标签归一化:全半角统一 + 去首尾空白 + 压缩内部空白。 */
export function normalizeLabel(label: string): string {
  return label.normalize("NFKC").trim().replace(/\s+/g, "");
}

/** 稳定短 id:同输入永远同 id(djb2 → base36)。 */
function stableId(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// ---------- book.md 元信息(磁盘上是中文 frontmatter,代码里是英文字段) ----------

export interface BookMeta {
  name: string;
  genre?: string;
  synopsis?: string;
  targetChapters?: number;
  targetWords?: number;
  pov?: string;
  style?: string;
  masterPrompt?: string;
  deepestPromptEnabled: boolean;
  lint?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

type MetaPatch = Partial<Omit<BookMeta, "raw" | "deepestPromptEnabled">> & {
  deepestPromptEnabled?: boolean;
};

const META_KEYS: Array<[keyof MetaPatch, string]> = [
  ["name", "书名"],
  ["genre", "题材"],
  ["synopsis", "简介"],
  ["targetChapters", "目标章数"],
  ["targetWords", "目标字数"],
  ["pov", "写作视角"],
  ["style", "style"],
  ["masterPrompt", "master_prompt"],
  ["deepestPromptEnabled", "深层提示词"],
  ["lint", "lint"],
];

// ---------- 各记忆文件的条目类型 ----------

export interface Character {
  name: string;
  role: string;
  aliases: string[];
  base: string;
  state: string;
}

export interface Worldbook {
  title: string;
  keys: string[];
  constant: boolean;
  body: string;
}

export interface Foreshadow {
  status: "active" | "paid";
  label: string;
  chapterNo: number;
  note: string;
  characters: string[];
}

export interface TimelineEntry {
  chapterNo: number;
  storyTime: string;
  event: string;
  participants: string[];
}

export interface Issue {
  id: string;
  status: "open" | "resolved";
  type: string;
  chapterNo: number;
  note: string;
}

export interface ChapterSummary {
  brief: string;
  paragraph: string;
  events: string[];
}

// ---------- 正文 body 的 ## 分节工具 ----------

function parseSections(body: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /^##\s+(.+?)\s*$/gm;
  const matches = [...body.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? body.length) : body.length;
    map.set(m[1]!.trim(), body.slice(start, end).trim());
  }
  return map;
}

function renderSections(sections: Map<string, string>): string {
  return [...sections.entries()].map(([title, content]) => `## ${title}\n\n${content}\n`).join("\n");
}

// ---------- BookStore ----------

export class BookStore {
  constructor(readonly dir: string) {}

  /** 建书:落目录骨架 + book.md。dir 即书目录(含书名)。 */
  static create(dir: string, meta: MetaPatch & { name: string }): BookStore {
    for (const d of ["角色", "世界书", "章节", "摘要", "弧"]) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
    }
    const store = new BookStore(dir);
    const initial: Array<[string, string]> = [
      ["设定.md", ""],
      ["记录规则.md", ""],
      ["大纲.md", ""],
      ["伏笔.md", "# 伏笔\n"],
      ["时间线.md", "# 时间线\n"],
      ["状态.md", ""],
      ["问题.md", "# 问题\n"],
      [".gitignore", ".index/\n"],
    ];
    for (const [file, content] of initial) {
      const p = path.join(dir, file);
      if (!fs.existsSync(p)) fs.writeFileSync(p, content, "utf8");
    }
    const data: Record<string, unknown> = {};
    fs.writeFileSync(path.join(dir, "book.md"), matter.stringify("", data), "utf8");
    store.writeMeta(meta);
    return store;
  }

  private p(...parts: string[]): string {
    return path.join(this.dir, ...parts);
  }

  private readFileOr(file: string, fallback = ""): string {
    const full = this.p(file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : fallback;
  }

  // ---------- meta ----------

  readMeta(): BookMeta {
    const raw = matter(this.readFileOr("book.md")).data as Record<string, unknown>;
    const pick = <T>(zh: string): T | undefined => raw[zh] as T | undefined;
    return {
      name: pick<string>("书名") ?? path.basename(this.dir),
      genre: pick<string>("题材"),
      synopsis: pick<string>("简介"),
      targetChapters: pick<number>("目标章数"),
      targetWords: pick<number>("目标字数"),
      pov: pick<string>("写作视角"),
      style: pick<string>("style"),
      masterPrompt: pick<string>("master_prompt"),
      deepestPromptEnabled: pick<boolean>("深层提示词") ?? true,
      lint: pick<Record<string, unknown>>("lint"),
      raw,
    };
  }

  writeMeta(patch: MetaPatch): void {
    const parsed = matter(this.readFileOr("book.md"));
    const data = { ...(parsed.data as Record<string, unknown>) };
    for (const [en, zh] of META_KEYS) {
      const value = patch[en];
      if (value !== undefined) data[zh] = value;
    }
    fs.writeFileSync(this.p("book.md"), matter.stringify(parsed.content, data), "utf8");
  }

  // ---------- 固定文档(设定/记录规则/大纲) ----------

  readDoc(name: "设定" | "记录规则" | "大纲"): string {
    return this.readFileOr(`${name}.md`);
  }

  writeDoc(name: "设定" | "记录规则" | "大纲", content: string): void {
    fs.writeFileSync(this.p(`${name}.md`), content, "utf8");
  }

  // ---------- 章节 ----------

  chapterPath(no: number): string {
    return this.p("章节", `${pad3(no)}.md`);
  }

  writeChapter(no: number, text: string, title = ""): void {
    const content = matter.stringify(`\n${text}\n`, { 标题: title, 字数: text.length });
    fs.writeFileSync(this.chapterPath(no), content, "utf8");
  }

  readChapter(no: number): { no: number; title: string; text: string; words: number } {
    const file = this.chapterPath(no);
    if (!fs.existsSync(file)) {
      throw new Error(`第 ${no} 章不存在(chapter_not_found)`);
    }
    const parsed = matter(fs.readFileSync(file, "utf8"));
    const text = parsed.content.trim();
    const data = parsed.data as Record<string, unknown>;
    return {
      no,
      title: typeof data["标题"] === "string" ? data["标题"] : "",
      text,
      words: typeof data["字数"] === "number" ? data["字数"] : text.length,
    };
  }

  listChapters(): number[] {
    return this.listNumbered("章节");
  }

  private listNumbered(dir: string): number[] {
    const full = this.p(dir);
    if (!fs.existsSync(full)) return [];
    return fs
      .readdirSync(full)
      .map((f) => /^(\d{3})\.md$/.exec(f)?.[1])
      .filter((s): s is string => s !== undefined)
      .map((s) => Number(s))
      .sort((a, b) => a - b);
  }

  // ---------- 角色 ----------

  upsertCharacter(input: {
    name: string;
    role?: string;
    aliases?: string[];
    base?: string;
    state?: string;
  }): void {
    const file = this.p("角色", `${input.name}.md`);
    const existing = fs.existsSync(file) ? this.readCharacter(input.name) : undefined;
    // 基底是静态设定:文件已存在时不允许覆盖,只有空基底可补
    const base = existing?.base ? existing.base : (input.base ?? "");
    const state = input.state ?? existing?.state ?? "";
    const role = existing?.role ? existing.role : (input.role ?? "");
    const aliases = [...new Set([...(existing?.aliases ?? []), ...(input.aliases ?? [])])].filter(
      (a) => a && a !== input.name,
    );
    const body = renderSections(
      new Map([
        ["基底", base],
        ["当前状态", state],
      ]),
    );
    fs.writeFileSync(file, matter.stringify(`\n${body}`, { role, aliases }), "utf8");
  }

  readCharacter(name: string): Character {
    const file = this.p("角色", `${name}.md`);
    if (!fs.existsSync(file)) {
      throw new Error(`角色「${name}」不存在(character_not_found)`);
    }
    const parsed = matter(fs.readFileSync(file, "utf8"));
    const data = parsed.data as Record<string, unknown>;
    const sections = parseSections(parsed.content);
    return {
      name,
      role: typeof data["role"] === "string" ? data["role"] : "",
      aliases: Array.isArray(data["aliases"]) ? data["aliases"].map(String) : [],
      base: sections.get("基底") ?? parsed.content.trim(),
      state: sections.get("当前状态") ?? "",
    };
  }

  listCharacters(): Character[] {
    const dir = this.p("角色");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => this.readCharacter(f.slice(0, -3)));
  }

  // ---------- 世界书 ----------

  upsertWorldbook(input: Worldbook): void {
    const file = this.p("世界书", `${input.title}.md`);
    fs.writeFileSync(
      file,
      matter.stringify(`\n${input.body.trim()}\n`, { keys: input.keys, constant: input.constant }),
      "utf8",
    );
  }

  readWorldbook(title: string): Worldbook {
    const file = this.p("世界书", `${title}.md`);
    if (!fs.existsSync(file)) {
      throw new Error(`世界书「${title}」不存在(worldbook_not_found)`);
    }
    const parsed = matter(fs.readFileSync(file, "utf8"));
    const data = parsed.data as Record<string, unknown>;
    return {
      title,
      keys: Array.isArray(data["keys"]) ? data["keys"].map(String) : [],
      constant: data["constant"] === true,
      body: parsed.content.trim(),
    };
  }

  listWorldbooks(): Worldbook[] {
    const dir = this.p("世界书");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => this.readWorldbook(f.slice(0, -3)));
  }

  // ---------- 伏笔 ----------

  listForeshadows(): Foreshadow[] {
    const out: Foreshadow[] = [];
    for (const line of this.readFileOr("伏笔.md").split(/\r?\n/)) {
      const m = /^-\s*\[(active|paid)\]\s*(.+)$/.exec(line.trim());
      if (!m) {
        if (/^-\s*\[/.test(line.trim())) console.warn(`伏笔.md 坏行已跳过:${line}`);
        continue;
      }
      const parts = m[2]!.split("|").map((s) => s.trim());
      const chapterNo = Number(/第(\d+)章/.exec(parts[1] ?? "")?.[1] ?? 0);
      const characters = (parts[3] ?? "")
        .replace(/^关联[::]/, "")
        .split(/[,,、]/)
        .map((s) => s.trim())
        .filter(Boolean);
      out.push({
        status: m[1] as "active" | "paid",
        label: parts[0] ?? "",
        chapterNo,
        note: parts[2] ?? "",
        characters,
      });
    }
    return out;
  }

  applyForeshadow(delta: {
    new?: Array<{ label: string; chapterNo: number; note: string; characters: string[] }>;
    paid?: string[];
  }): void {
    const entries = this.listForeshadows();
    const known = new Set(entries.map((e) => normalizeLabel(e.label)));
    for (const item of delta.new ?? []) {
      const label = noPipe(item.label);
      if (known.has(normalizeLabel(label))) continue; // 归一化 dedup
      known.add(normalizeLabel(label));
      entries.push({
        status: "active",
        label,
        chapterNo: item.chapterNo,
        note: noPipe(item.note),
        characters: item.characters.map(noPipe).filter(Boolean),
      });
    }
    const paidSet = new Set((delta.paid ?? []).map(normalizeLabel));
    for (const entry of entries) {
      if (entry.status === "active" && paidSet.has(normalizeLabel(entry.label))) {
        entry.status = "paid";
      }
    }
    const lines = entries.map(
      (e) =>
        `- [${e.status}] ${e.label} | 埋于第${e.chapterNo}章 | ${e.note} | 关联:${e.characters.join(",")}`,
    );
    fs.writeFileSync(this.p("伏笔.md"), `# 伏笔\n\n${lines.join("\n")}\n`, "utf8");
  }

  // ---------- 时间线 ----------

  listTimeline(): TimelineEntry[] {
    const out: TimelineEntry[] = [];
    for (const line of this.readFileOr("时间线.md").split(/\r?\n/)) {
      const m = /^-\s*第(\d+)章\s*\|(.+)$/.exec(line.trim());
      if (!m) continue;
      const parts = m[2]!.split("|").map((s) => s.trim());
      out.push({
        chapterNo: Number(m[1]),
        storyTime: parts[0] ?? "",
        event: parts[1] ?? "",
        participants: (parts[2] ?? "")
          .split(/[,,、]/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
    }
    return out;
  }

  appendTimeline(entry: TimelineEntry): void {
    const exists = this.listTimeline().some(
      (e) => e.storyTime === entry.storyTime && e.event === entry.event,
    );
    if (exists) return;
    const line = `- 第${entry.chapterNo}章 | ${noPipe(entry.storyTime)} | ${noPipe(entry.event)} | ${entry.participants.map(noPipe).join(",")}`;
    const current = this.readFileOr("时间线.md", "# 时间线\n");
    fs.writeFileSync(this.p("时间线.md"), `${current.replace(/\n*$/, "\n")}${line}\n`, "utf8");
  }

  // ---------- 状态(动态记录) ----------

  readRecords(): Record<string, string> {
    return Object.fromEntries(parseSections(this.readFileOr("状态.md")));
  }

  writeRecords(patch: Record<string, string>): void {
    const sections = parseSections(this.readFileOr("状态.md"));
    for (const [key, value] of Object.entries(patch)) {
      sections.set(key, value.trim());
    }
    fs.writeFileSync(this.p("状态.md"), renderSections(sections), "utf8");
  }

  // ---------- 摘要 ----------

  writeSummary(no: number, summary: ChapterSummary): void {
    const content = matter.stringify(`\n${summary.paragraph.trim()}\n`, {
      一句话: summary.brief,
      关键事件: summary.events,
    });
    fs.writeFileSync(this.p("摘要", `${pad3(no)}.md`), content, "utf8");
  }

  readSummary(no: number): ChapterSummary {
    const file = this.p("摘要", `${pad3(no)}.md`);
    if (!fs.existsSync(file)) {
      throw new Error(`第 ${no} 章摘要不存在(summary_not_found)`);
    }
    const parsed = matter(fs.readFileSync(file, "utf8"));
    const data = parsed.data as Record<string, unknown>;
    return {
      brief: typeof data["一句话"] === "string" ? data["一句话"] : "",
      paragraph: parsed.content.trim(),
      events: Array.isArray(data["关键事件"]) ? data["关键事件"].map(String) : [],
    };
  }

  listSummaries(): number[] {
    return this.listNumbered("摘要");
  }

  // ---------- 弧 ----------

  writeArc(no: number, content: string): void {
    fs.writeFileSync(this.p("弧", `${pad3(no)}.md`), `${content.trim()}\n`, "utf8");
  }

  readArc(no: number): string {
    const file = this.p("弧", `${pad3(no)}.md`);
    if (!fs.existsSync(file)) {
      throw new Error(`第 ${no} 弧纲要不存在(arc_not_found)`);
    }
    return fs.readFileSync(file, "utf8").trim();
  }

  listArcs(): number[] {
    return this.listNumbered("弧");
  }

  // ---------- 问题 ----------

  private listAllIssues(): Issue[] {
    const out: Issue[] = [];
    for (const line of this.readFileOr("问题.md").split(/\r?\n/)) {
      const m = /^-\s*\[(open|resolved)\]\s*(.+)$/.exec(line.trim());
      if (!m) {
        if (/^-\s*\[/.test(line.trim())) console.warn(`问题.md 坏行已跳过:${line}`);
        continue;
      }
      const parts = m[2]!.split("|").map((s) => s.trim());
      out.push({
        id: parts[0] ?? "",
        status: m[1] as "open" | "resolved",
        chapterNo: Number(/第(\d+)章/.exec(parts[1] ?? "")?.[1] ?? 0),
        type: parts[2] ?? "",
        note: parts[3] ?? "",
      });
    }
    return out;
  }

  private writeIssues(issues: Issue[]): void {
    const lines = issues.map(
      (i) => `- [${i.status}] ${i.id} | 第${i.chapterNo}章 | ${noPipe(i.type)} | ${noPipe(i.note)}`,
    );
    fs.writeFileSync(this.p("问题.md"), `# 问题\n\n${lines.join("\n")}\n`, "utf8");
  }

  /** 稳定 id = hash(type|章号|note 前 20 字),同一问题重复 add 不翻倍。 */
  addIssues(items: Array<{ type: string; chapterNo: number; note: string }>): Issue[] {
    const issues = this.listAllIssues();
    const known = new Set(issues.map((i) => i.id));
    const added: Issue[] = [];
    for (const item of items) {
      const id = stableId(`${item.type}|${item.chapterNo}|${item.note.slice(0, 20)}`);
      if (known.has(id)) continue;
      known.add(id);
      const issue: Issue = { id, status: "open", ...item };
      issues.push(issue);
      added.push(issue);
    }
    this.writeIssues(issues);
    return added;
  }

  listOpenIssues(): Issue[] {
    return this.listAllIssues().filter((i) => i.status === "open");
  }

  resolveIssue(id: string): void {
    const issues = this.listAllIssues();
    const target = issues.find((i) => i.id === id);
    if (!target) {
      throw new Error(`找不到问题 ${id}(issue_not_found)`);
    }
    target.status = "resolved";
    this.writeIssues(issues);
  }
}
