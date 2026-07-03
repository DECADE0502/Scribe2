import { embedMany, type EmbeddingModel } from "ai";
import { withRetry } from "./retry.js";

/**
 * 批量嵌入。embedding 角色未配置(model=null)→ 返回 null,
 * 调用方降级为关键词+时近检索(SPEC §2.3,功能不缺)。
 */
export async function embedTexts(
  model: EmbeddingModel<string> | null,
  texts: string[],
): Promise<number[][] | null> {
  if (model === null) return null;
  if (texts.length === 0) return [];
  const { embeddings } = await withRetry(() => embedMany({ model, values: texts }));
  return embeddings;
}
