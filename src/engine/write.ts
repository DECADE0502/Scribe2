import * as fs from "node:fs";
import type { CoreMessage, EmbeddingModel } from "ai";
import { z } from "zod";
import type { Config, StreamEvent, Usage } from "./../types.js";
import type { BookStore } from "./../store/book.js";
import * as path from "node:path";
import { commitAll, restoreWorktree } from "./../store/git.js";
import { loadIndex, syncIndex } from "./../memory/index.js";
import type { retrieve as retrieveFn } from "./../memory/retrieve.js";
import { loadPrompt, renderTemplate } from "./../template.js";
import {
  assembleWriteContext,
  chapterPlanSchema,
  deepestPromptFor,
  TEXT_FIREWALL,
  type ChapterPlan,
} from "./context.js";
import { sanitizeProse } from "./sanitize.js";
import { lintProse } from "./lint.js";
import { generateStructured } from "./../llm/json.js";

// ---------- 角色调用形状(生产装配在 CLI 层,测试注入假实现) ----------

export interface RoleCallInput {
  messages: CoreMessage[];
  onUsage?: (usage: Usage) => void;
}
export type GenerateRole = (input: RoleCallInput) => Promise<{ text: string }>;
export type StreamRole = (input: RoleCallInput) => AsyncIterable<StreamEvent>;

export interface WriteDeps {
  planner: GenerateRole;
  writer: StreamRole;
  extractor: GenerateRole;
  /** 弧压缩,缺省复用 extractor */
  compressor?: GenerateRole;
  retrieve: typeof retrieveFn;
  embedder: EmbeddingModel<string> | null;
  config: Config;
  onUsage?: (role: string, usage: Usage) => void;
  /** 规划完成回调(CLI 展示用) */
  onPlan?: (plan: ChapterPlan) => void;
  /** 写作流式回调(CLI 打印用) */
  onDelta?: (delta: string) => void;
  tokenBudget?: number;
}

// ---------- 抽取步的 JSON 契约(extract-memory.md) ----------

const memoryDeltaSchema = z.object({
  characterStates: z.record(z.string()).default({}),
  records: z.record(z.string()).default({}),
  newForeshadow: z
    .array(
      z.object({
        label: z.string(),
        description: z.string().default(""),
        relatedCharacters: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  foreshadowPaid: z.array(z.string()).default([]),
  timeline: z
    .array(
      z.object({
        storyTime: z.string().default(""),
        event: z.string().default(""),
        participants: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  summary: z
    .object({
      oneLiner: z.string().default(""),
      paragraph: z.string().default(""),
      keyEvents: z
        .array(
          z.object({
            event: z.string().default(""),
            characters: z.array(z.string()).default([]),
            foreshadowingRefs: z.array(z.string()).default([]),
          }),
        )
        .default([]),
    })
    .default({ oneLiner: "", paragraph: "", keyEvents: [] }),
});
export type MemoryDelta = z.infer<typeof memoryDeltaSchema>;

const stripNew = (name: string) => name.replace(/[((]\s*新\s*[))]\s*$/, "").trim();
const pad3 = (n: number) => String(n).padStart(3, "0");

function rosterOf(store: BookStore): string {
  const list = store
    .listCharacters()
    .map((c) => `- ${c.name}(${c.role || "配角"}${c.aliases.length ? `,别名:${c.aliases.join("/")}` : ""})`);
  return list.length ? list.join("\n") : "(暂无角色)";
}

function planAsText(plan: ChapterPlan): string {
  return [
    `目标:${plan.goal}`,
    ...plan.scenes.map((s, i) => `场景${i + 1}:${s}`),
    `出场角色:${plan.charactersOnStage.join("、")}`,
    ...(plan.foreshadowToTouch.length ? [`要触碰的伏笔:${plan.foreshadowToTouch.join("、")}`] : []),
  ].join("\n");
}

/**
 * 从整份大纲切出当前章所属的段落(SPEC §3.2 ① 入参是"大纲对应弧"):
 * 认「N-N 章」区间标题行,取覆盖本章的全部层级标题 + 最窄区间之后的正文,
 * 直到下一条不覆盖本章的区间行;认不出区间格式时回退整份大纲。
 */
export function outlineSliceFor(outline: string, chapterNo: number): string {
  const lines = outline.split(/\r?\n/);
  const rangeRe = /(\d+)\s*[-–~—]\s*(\d+)\s*章?/; // 「1-10 章」或「弧1(1-5)」两种写法都认
  const covers = (line: string): boolean | null => {
    const m = rangeRe.exec(line);
    if (!m) return null;
    return chapterNo >= Number(m[1]) && chapterNo <= Number(m[2]);
  };
  let anchor = -1;
  let anchorSpan = Number.POSITIVE_INFINITY;
  const headers: string[] = [];
  lines.forEach((line, i) => {
    const c = covers(line);
    if (c !== true) return;
    headers.push(line);
    const m = rangeRe.exec(line)!;
    const span = Number(m[2]) - Number(m[1]);
    // <=:同宽区间取更靠后的(更深层级)做锚,免得它再次落进 body 造成重复
    if (span <= anchorSpan) {
      anchorSpan = span;
      anchor = i;
    }
  });
  if (anchor === -1) return outline;
  const body: string[] = [];
  for (let i = anchor + 1; i < lines.length; i++) {
    if (covers(lines[i]!) === false) break;
    body.push(lines[i]!);
  }
  const slice = [...headers, ...body].join("\n").trim();
  return slice || outline;
}

export interface WriteResult {
  chapterNo: number;
  text: string;
  plan: ChapterPlan;
  delta: MemoryDelta;
  dropped: string[];
  rewritten: boolean;
}

/** 写章六步(SPEC §3.2):规划→检索→组装→写作→校验→抽取。任何一步失败都不落盘不 commit。 */
export async function writeChapter(
  store: BookStore,
  chapterNo: number,
  instruction: string,
  deps: WriteDeps,
): Promise<WriteResult> {
  const meta = store.readMeta();
  const structuredEnv = deepestPromptFor("structured", deps.config, meta);
  const roster = rosterOf(store);
  const priorChapters = store.listChapters().filter((n) => n < chapterNo);
  const prevNo = priorChapters.at(-1);

  // ① 规划 [planner]
  const prevSummary =
    prevNo !== undefined && store.listSummaries().includes(prevNo)
      ? (() => {
          const s = store.readSummary(prevNo);
          return `${s.brief}\n${s.paragraph}`;
        })()
      : "(无)";
  const prevTail = prevNo !== undefined ? store.readChapter(prevNo).text.slice(-500) : "(无,这是第一章)";
  const activeForeshadows = store.listForeshadows().filter((f) => f.status === "active");
  const planPrompt = renderTemplate(loadPrompt("plan-chapter", store.dir), {
    章号: chapterNo,
    弧规划: outlineSliceFor(store.readDoc("大纲").trim(), chapterNo) || "(无大纲,自由发挥)",
    上章摘要: prevSummary,
    上章结尾: prevTail,
    用户指令: instruction,
    伏笔清单: activeForeshadows.length
      ? activeForeshadows.map((f) => `- ${f.label}(埋于第${f.chapterNo}章):${f.note}`).join("\n")
      : "(无)",
    角色名录: roster,
  });
  const plan = await generateStructured({
    schema: chapterPlanSchema,
    messages: [...structuredEnv.prefix, { role: "user", content: planPrompt }, ...structuredEnv.suffix],
    generate: (input) =>
      deps.planner({ messages: input.messages, onUsage: (u) => deps.onUsage?.("planner", u) }),
  });
  deps.onPlan?.(plan);

  // ② 检索 [代码]
  const onStage = plan.charactersOnStage.map(stripNew).filter(Boolean);
  const entities = [...new Set([...plan.queryTerms, ...onStage, ...plan.foreshadowToTouch])];
  const retrieved = await deps.retrieve({
    index: loadIndex(store),
    query: {
      text: [plan.goal, ...plan.scenes, instruction, prevTail].filter(Boolean).join("\n"),
      entities,
      charactersOnStage: onStage,
    },
    currentChapter: chapterNo,
    embedder: deps.embedder,
  });

  // ③ 组装 [代码]
  const characters = store.listCharacters();
  const arcNos = store.listArcs();
  const recent = priorChapters.slice(-3).map((n) => store.readChapter(n));
  const recentSet = new Set(recent.map((c) => c.no));
  // 连续覆盖:弧文件有空洞(如压缩曾失败)时,空洞章的摘要仍走中程层,不产生记忆黑洞
  let arcCovered = 0;
  while (arcNos.includes(arcCovered / 10 + 1)) arcCovered += 10;
  const { messages, dropped } = assembleWriteContext({
    chapterNo,
    meta,
    config: deps.config,
    promptTemplate: loadPrompt("write-chapter", store.dir),
    setting: store.readDoc("设定"),
    arcs: arcNos.map((n) => store.readArc(n)),
    characterStates: characters
      .filter((c) => c.role === "主角" || onStage.includes(c.name))
      .map((c) => ({ name: c.name, state: c.state })),
    constantWorldbooks: store.listWorldbooks().filter((w) => w.constant),
    triggeredCandidates: store.listWorldbooks().filter((w) => !w.constant),
    midSummaries: store
      .listSummaries()
      .filter((n) => n < chapterNo && n > arcCovered && !recentSet.has(n))
      .map((n) => {
        const s = store.readSummary(n);
        return { no: n, text: s.brief };
      }),
    retrieved,
    recentChapters: recent.map((c) => ({ no: c.no, title: c.title, text: c.text })),
    openIssues: store.listOpenIssues(),
    plan,
    instruction,
    ...(deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {}),
  });

  // ④ 写作 [writer] + ⑤ 校验 [lint],违规带因重写一次
  const lintOptions = {
    pov: meta.pov ?? "",
    minChars: typeof meta.lint?.["minChars"] === "number" ? (meta.lint["minChars"] as number) : 800,
    allowTailMarkers: meta.lint?.["allowTailMarkers"] === true,
  };
  const runWriter = async (msgs: CoreMessage[]): Promise<string> => {
    let raw = "";
    for await (const ev of deps.writer({
      messages: msgs,
      onUsage: (u) => deps.onUsage?.("writer", u),
    })) {
      raw += ev.delta;
      deps.onDelta?.(ev.delta);
    }
    return sanitizeProse(raw);
  };

  let rewritten = false;
  let text = await runWriter(messages);
  let verdict = lintProse(text, lintOptions);
  if (!verdict.ok) {
    rewritten = true;
    deps.onDelta?.(`\n[校验未过:${verdict.reason},自动带因重写]\n`);
    text = await runWriter([
      ...messages,
      { role: "assistant", content: text.slice(0, 500) },
      {
        role: "user",
        content: `上一稿未通过校验:${verdict.reason} —— ${verdict.detail}。请重写整章,修正该问题,其余要求不变。`,
      },
    ]);
    verdict = lintProse(text, lintOptions);
    if (!verdict.ok) {
      const draftPath = store.chapterPath(chapterNo).replace(/\.md$/, ".draft.md");
      fs.mkdirSync(path.dirname(draftPath), { recursive: true }); // reset 后 章节/ 目录可能不存在
      fs.writeFileSync(draftPath, text, "utf8");
      throw new Error(
        `第 ${chapterNo} 章两稿均未通过校验(${verdict.reason}:${verdict.detail}),草稿已留存 章节/${pad3(chapterNo)}.draft.md 供人工裁决(lint_failed)`,
      );
    }
  }

  // ⑥ 抽取 [extractor] —— 成功之前不写任何文件
  const extractPrompt = renderTemplate(loadPrompt("extract-memory", store.dir), {
    章号: chapterNo,
    记录规则: store.readDoc("记录规则").trim() || "(本书未定义动态记录)",
    角色名录: roster,
    // 回收 label 必须逐字对上档案,否则 applyForeshadow 静默翻转失败、伏笔永久滞留 active
    现有伏笔: activeForeshadows.length
      ? activeForeshadows.map((f) => `- ${f.label}`).join("\n")
      : "(无)",
    本章规划: planAsText(plan),
    正文: text,
  });
  const delta = await generateStructured({
    schema: memoryDeltaSchema,
    messages: [...structuredEnv.prefix, { role: "user", content: extractPrompt }, ...structuredEnv.suffix],
    generate: (input) =>
      deps.extractor({ messages: input.messages, onUsage: (u) => deps.onUsage?.("extractor", u) }),
  });

  // —— 全部落盘(正文与记忆同批写入,同一个 commit);中途任何失败整体回滚,不留半套记忆 ——
  try {
    store.writeChapter(chapterNo, text);
    store.writeSummary(chapterNo, {
      brief: delta.summary.oneLiner,
      paragraph: delta.summary.paragraph,
      events: delta.summary.keyEvents.map((e) => e.event).filter(Boolean),
    });
    for (const [name, state] of Object.entries(delta.characterStates)) {
      store.upsertCharacter({ name: stripNew(name), state });
    }
    if (Object.keys(delta.records).length) store.writeRecords(delta.records);
    store.applyForeshadow({
      new: delta.newForeshadow.map((f) => ({
        label: f.label,
        chapterNo,
        note: f.description,
        characters: f.relatedCharacters,
      })),
      paid: delta.foreshadowPaid,
    });
    for (const t of delta.timeline) {
      if (!t.event) continue;
      store.appendTimeline({ chapterNo, storyTime: t.storyTime, event: t.event, participants: t.participants });
    }

    // 索引增量:按文本差异同步——与落盘侧的消毒/归一化天然一致,不再手拼 id
    await syncIndex(store, deps.embedder);

    // 每满 10 章补齐所有缺失的弧纲要(含此前压缩失败留下的空洞);当前弧总是重压;失败只警告
    if (chapterNo % 10 === 0) {
      const have = new Set(store.listArcs());
      const currentArc = chapterNo / 10;
      for (let arcNo = 1; arcNo <= currentArc; arcNo++) {
        if (arcNo < currentArc && have.has(arcNo)) continue;
        try {
          await compressArc(store, arcNo * 10, deps);
        } catch (e) {
          console.warn(
            `弧 ${arcNo} 压缩失败,下个 10 章节点会自动补跑:${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // 本章此前 lint 双败留下的草稿已无意义,清掉,免得被 commit -A 收编
    fs.rmSync(store.chapterPath(chapterNo).replace(/\.md$/, ".draft.md"), { force: true });
    commitAll(store.dir, `ch${pad3(chapterNo)}: 写作`);
  } catch (e) {
    restoreWorktree(store.dir);
    try {
      await syncIndex(store, deps.embedder);
    } catch {
      /* 索引可 reindex 自愈,恢复失败不掩盖主错误 */
    }
    throw new Error(
      `第 ${chapterNo} 章落盘阶段失败,工作区已回滚到上一提交:${e instanceof Error ? e.message : String(e)}(persist_failed)`,
    );
  }
  return { chapterNo, text, plan, delta, dropped, rewritten };
}

async function compressArc(store: BookStore, chapterNo: number, deps: WriteDeps): Promise<void> {
  const arcNo = chapterNo / 10;
  const from = (arcNo - 1) * 10 + 1;
  const summaries = store
    .listSummaries()
    .filter((n) => n >= from && n <= chapterNo)
    .map((n) => {
      const s = store.readSummary(n);
      return `第${n}章:${s.brief} ${s.paragraph}`;
    });
  const prompt = renderTemplate(loadPrompt("compress-arc", store.dir), {
    起章: from,
    止章: chapterNo,
    章摘要列表: summaries.join("\n") || "(摘要缺失)",
    上一份弧纲要: arcNo > 1 && store.listArcs().includes(arcNo - 1) ? store.readArc(arcNo - 1) : "",
  });
  const meta = store.readMeta();
  // 弧压缩产出是纯文本长程记忆:scope=all 时不能用 JSON 防火墙(会诱导模型包成 JSON 写坏弧纲要)
  const envelope = deepestPromptFor("structured", deps.config, meta, TEXT_FIREWALL);
  const compressor = deps.compressor ?? deps.extractor;
  const { text } = await compressor({
    messages: [...envelope.prefix, { role: "user", content: prompt }, ...envelope.suffix],
    onUsage: (u) => deps.onUsage?.("extractor", u),
  });
  const clean = sanitizeProse(text); // 剥围栏/元话语,坏格式不落进长程记忆
  if (clean.trim()) store.writeArc(arcNo, clean.trim());
}
