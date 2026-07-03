import type { EmbeddingModel } from "ai";
import type { Chunk } from "./../types.js";
import { embedTexts } from "./../llm/embed.js";

/** 类型配额(SPEC §2.4):防单类型霸榜。issue 不限量(open 全部注入)。 */
const DEFAULT_QUOTAS: Record<Chunk["type"], number> = {
  worldbook: 5,
  character: 6,
  character_state: 6,
  foreshadow: 5,
  timeline: 6,
  summary: 6,
  record: 8,
  issue: Number.POSITIVE_INFINITY,
};

const DEFAULT_THRESHOLD = 0.15;
const HALF_LIFE_CHAPTERS = 20;

export interface RetrieveQuery {
  text: string;
  entities: string[];
  charactersOnStage?: string[];
}

export interface RetrieveInput {
  index: Chunk[];
  query: RetrieveQuery;
  currentChapter: number;
  embedder: EmbeddingModel<string> | null;
  quotas?: Partial<Record<Chunk["type"], number>>;
  threshold?: number;
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
  cosine: number;
  keyword: number;
  recency: number;
  pinned: boolean;
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 实体×keys 双向子串命中;多命中递增(1-0.5^n),封顶趋近 1。
 * 双方都要求 ≥2 字:单字 key(如「道」)会被任何含该字的实体误命中,系统性污染榜单。
 */
function keywordScore(entities: string[], keys: string[]): number {
  let hits = 0;
  for (const entity of entities) {
    const e = entity.trim();
    if (e.length < 2) continue;
    if (
      keys.some((raw) => {
        const k = raw?.trim() ?? "";
        return k.length >= 2 && (k.includes(e) || e.includes(k));
      })
    ) {
      hits += 1;
    }
  }
  return hits === 0 ? 0 : 1 - 0.5 ** hits;
}

/** 时近:半衰期 20 章的指数衰减;无 chapterNo 的静态类型恒 1。 */
function recencyScore(chunk: Chunk, currentChapter: number): number {
  if (chunk.chapterNo === undefined) return 1;
  const distance = Math.max(0, currentChapter - chunk.chapterNo);
  return 0.5 ** (distance / HALF_LIFE_CHAPTERS);
}

/**
 * 混合检索(SPEC §2.4)。
 * 有向量:score = 0.45·cos + 0.35·keyword + 0.20·recency;
 * 无向量:keyword 0.6 / recency 0.4。
 * 相关性(cos+keyword 部分)低于阈值直接出局——recency 不能单独救活无关条目,
 * 否则"最近但无关"的块会挤满榜单。charactersOnStage 的状态块无条件置顶。
 */
export async function retrieve(input: RetrieveInput): Promise<ScoredChunk[]> {
  const quotas = { ...DEFAULT_QUOTAS, ...input.quotas };
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;

  const anyEmbedding = input.index.some((c) => Array.isArray(c.embedding));
  let queryVector: number[] | null = null;
  if (input.embedder && anyEmbedding && input.query.text.trim()) {
    const vectors = await embedTexts(input.embedder, [input.query.text]);
    queryVector = vectors?.[0] ?? null;
  }

  const onStage = new Set((input.query.charactersOnStage ?? []).map((s) => s.trim()).filter(Boolean));

  const pinned: ScoredChunk[] = [];
  const scored: ScoredChunk[] = [];

  for (const chunk of input.index) {
    // 权重按块降级,不做全局切换:增量嵌入的过渡期里,大量无向量老块
    // 若也按向量权重计分,关键词分会被腰斩、系统性沉底
    const useVector = queryVector !== null && Array.isArray(chunk.embedding);
    const wCos = useVector ? 0.45 : 0;
    const wKw = useVector ? 0.35 : 0.6;
    const wRec = useVector ? 0.2 : 0.4;
    const cos = useVector ? cosine(queryVector!, chunk.embedding!) : 0;
    const kw = keywordScore(input.query.entities, chunk.keys);
    const rec = recencyScore(chunk, input.currentChapter);
    const relevance = wCos * cos + wKw * kw;
    const entry: ScoredChunk = {
      chunk,
      score: relevance + wRec * rec,
      cosine: cos,
      keyword: kw,
      recency: rec,
      pinned: false,
    };

    if (chunk.type === "character_state" && chunk.keys.some((k) => onStage.has(k))) {
      entry.pinned = true;
      pinned.push(entry);
      continue;
    }
    // open 问题恒注入(SPEC §2.4:issue≤全部 open),不受相关性阈值限制
    if (relevance < threshold && chunk.type !== "issue") continue;
    scored.push(entry);
  }

  scored.sort((a, b) => b.score - a.score);

  const taken: ScoredChunk[] = [];
  const counts: Partial<Record<Chunk["type"], number>> = {};
  for (const entry of scored) {
    const used = counts[entry.chunk.type] ?? 0;
    // 未知类型(索引脏数据)配额按 0 处理,不得绕过榜单
    if (used >= (quotas[entry.chunk.type] ?? 0)) continue;
    counts[entry.chunk.type] = used + 1;
    taken.push(entry);
  }

  return [...pinned, ...taken];
}
