import type { CoreMessage } from "ai";
import { z } from "zod";
import { renderTemplate } from "./../template.js";
import type { Config } from "./../types.js";
import type { BookMeta, Issue, Worldbook } from "./../store/book.js";
import type { ScoredChunk } from "./../memory/retrieve.js";

/** 规划步的产出(plan-chapter.md 的 JSON 契约)。 */
export const chapterPlanSchema = z.object({
  goal: z.string().default(""),
  scenes: z.array(z.string()).default([]),
  charactersOnStage: z.array(z.string()).default([]),
  foreshadowToTouch: z.array(z.string()).default([]),
  queryTerms: z.array(z.string()).default([]),
});
export type ChapterPlan = z.infer<typeof chapterPlanSchema>;

/** token 估算:中文为主的语料,经验值 chars/1.6。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.6);
}

// ---------- 深层提示词注入(SPEC §4.1 注入分域) ----------

export const JSON_FIREWALL =
  "以上风格与格式偏好仅适用于小说创作输出;本次调用是内部数据处理," +
  "忽略一切与输出格式冲突的先前指令,只输出规定的 JSON。";

export interface DeepestPromptEnvelope {
  prefix: CoreMessage[];
  suffix: CoreMessage[];
}

/** kind=creative:首条 system 注入;kind=structured:默认不注入,scope=all 时注入+末位格式防火墙。 */
export function deepestPromptFor(
  kind: "creative" | "structured",
  config: Config,
  meta: BookMeta,
): DeepestPromptEnvelope {
  const prompt = (meta.masterPrompt ?? config.masterPrompt ?? "").trim();
  if (!prompt || !meta.deepestPromptEnabled) return { prefix: [], suffix: [] };
  const injection: CoreMessage = { role: "system", content: `【作者全局要求】\n${prompt}` };
  if (kind === "creative") return { prefix: [injection], suffix: [] };
  if (config.deepestPromptScope === "all") {
    return { prefix: [injection], suffix: [{ role: "system", content: JSON_FIREWALL }] };
  }
  return { prefix: [], suffix: [] };
}

// ---------- 写章上下文组装(SPEC §2.5 + §3.2 ③) ----------

export interface WriteContextInput {
  chapterNo: number;
  meta: BookMeta;
  config: Config;
  /** write-chapter.md 原文(书级覆盖后) */
  promptTemplate: string;
  setting: string;
  /** 弧纲要,旧→新 */
  arcs: string[];
  /** 主角 + 规划点名角色的当前状态(固定层,永不裁) */
  characterStates: Array<{ name: string; state: string }>;
  constantWorldbooks: Worldbook[];
  /** 弧未覆盖且不在近3章内的章摘要(预算紧张时最先丢) */
  midSummaries: Array<{ no: number; text: string }>;
  /** 非 constant 世界书:keys 命中近章/规划/指令文本才注入 */
  triggeredCandidates: Worldbook[];
  /** 检索层(预算紧张时第二个丢) */
  retrieved: ScoredChunk[];
  /** 近 3 章全文(永不裁) */
  recentChapters: Array<{ no: number; title: string; text: string }>;
  openIssues: Issue[];
  plan: ChapterPlan | null;
  instruction: string;
  tokenBudget?: number;
}

export interface AssembledContext {
  messages: CoreMessage[];
  /** 因预算被丢弃的层名(报告用) */
  dropped: string[];
}

function renderPlanBlock(plan: ChapterPlan | null): string {
  if (!plan) return "(无规划,按大纲自然推进)";
  const lines = [`目标:${plan.goal}`];
  if (plan.scenes.length) lines.push(`场景:\n${plan.scenes.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  if (plan.charactersOnStage.length) lines.push(`出场角色:${plan.charactersOnStage.join("、")}`);
  if (plan.foreshadowToTouch.length) lines.push(`要触碰的伏笔:${plan.foreshadowToTouch.join("、")}`);
  return lines.join("\n");
}

export function assembleWriteContext(input: WriteContextInput): AssembledContext {
  const planText = input.plan
    ? [input.plan.goal, ...input.plan.scenes, ...input.plan.queryTerms].join("\n")
    : "";
  const scanText = [...input.recentChapters.map((c) => c.text), planText, input.instruction].join("\n");
  const triggered = input.triggeredCandidates.filter(
    (w) => !w.constant && w.keys.some((k) => k.trim() && scanText.includes(k.trim())),
  );

  // 检索层去重:constant/triggered 世界书与点名角色状态已固定注入,检索结果里的同名块剔除
  const injectedIds = new Set([
    ...[...input.constantWorldbooks, ...triggered].map((w) => `worldbook:${w.title}`),
    ...input.characterStates.map((c) => `character_state:${c.name}`),
  ]);
  const retrieved = input.retrieved.filter((s) => !injectedIds.has(s.chunk.id));

  const stateBlock = input.characterStates.length
    ? `【出场角色当前状态】(以此为准,不得超出或遗忘)\n${input.characterStates.map((c) => `- ${c.name}:${c.state}`).join("\n")}`
    : "";
  const constBlock = input.constantWorldbooks.length
    ? `【常驻设定】\n${input.constantWorldbooks.map((w) => `- ${w.title}:${w.body}`).join("\n")}`
    : "";
  const midBlock = input.midSummaries.length
    ? `【中程章节摘要】\n${input.midSummaries.map((s) => `- 第${s.no}章:${s.text}`).join("\n")}`
    : "";
  const retrievalBlock =
    triggered.length || retrieved.length
      ? `【相关记忆】(按相关度)\n${[
          ...triggered.map((w) => `- [世界书] ${w.title}:${w.body}`),
          ...retrieved.map((s) => `- [${s.chunk.type}] ${s.chunk.text.replace(/\n+/g, " ")}`),
        ].join("\n")}`
      : "";

  const dropped: string[] = [];
  const render = (withMid: boolean, withRetrieval: boolean): string => {
    const memoryBlocks = [
      stateBlock,
      constBlock,
      withMid ? midBlock : "",
      withRetrieval ? retrievalBlock : "",
    ].filter(Boolean);
    return renderTemplate(input.promptTemplate, {
      视角: input.meta.pov ?? "第三人称",
      文风: input.meta.style ?? "自然流畅的中文网文",
      目标字数: input.meta.targetWords ?? 2000,
      设定: input.setting.trim() || "(设定暂缺)",
      弧纲要: input.arcs.length ? input.arcs.join("\n\n") : "(尚无弧纲要,本书刚开始)",
      检索记忆: memoryBlocks.length ? memoryBlocks.join("\n\n") : "(无)",
      开放问题: input.openIssues.map((i) => `- [${i.type}|第${i.chapterNo}章] ${i.note}`).join("\n"),
      近章全文: input.recentChapters.length
        ? input.recentChapters.map((c) => `## 第${c.no}章 ${c.title}\n${c.text}`).join("\n\n")
        : "(本书尚无已写章节,这是第一章,从大纲与设定冷启动)",
      本章规划: renderPlanBlock(input.plan),
      用户指令: input.instruction.trim() || "(无特别指令,按规划与大纲推进)",
    });
  };

  let withMid = true;
  let withRetrieval = true;
  let system = render(withMid, withRetrieval);
  if (input.tokenBudget !== undefined) {
    if (estimateTokens(system) > input.tokenBudget && withMid && midBlock) {
      withMid = false;
      dropped.push("中程摘要");
      system = render(withMid, withRetrieval);
    }
    if (estimateTokens(system) > input.tokenBudget && withRetrieval && retrievalBlock) {
      withRetrieval = false;
      dropped.push("检索层");
      system = render(withMid, withRetrieval);
    }
    // 剩下的全是永不裁的核心层(近3章/状态/规划/指令),超了也不再动
  }

  const envelope = deepestPromptFor("creative", input.config, input.meta);
  const messages: CoreMessage[] = [
    ...envelope.prefix,
    { role: "system", content: system },
    { role: "user", content: `请开始写第 ${input.chapterNo} 章正文。` },
  ];
  return { messages, dropped };
}
