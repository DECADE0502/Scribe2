import type { CoreMessage } from "ai";
import type { z } from "zod";

/** 去掉 ``` 围栏标记行,保留其余内容参与扫描。 */
function stripFences(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("```"))
    .join("\n");
}

/** 依次产出每个"从某个 { 开始、引号感知配平到 } "的候选块。 */
function* balancedCandidates(text: string): Generator<string> {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          yield text.slice(start, i + 1);
          break;
        }
      }
    }
  }
}

/**
 * 硬化 JSON 提取:剥围栏 → 扫描首个能 JSON.parse 的配平块 → zod 校验。
 * 这是深层提示词格式污染的最后防线:模型说闲话/加 emoji/套围栏都不影响。
 * JSON 能解析但 schema 不符时抛 zod 错(不吞、不找下一块)。
 */
export function extractJson<TSchema extends z.ZodTypeAny>(
  raw: string,
  schema: TSchema,
): z.infer<TSchema> {
  for (const candidate of balancedCandidates(stripFences(raw))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue; // 正文里的花括号片段,不是 JSON,换下一个候选
    }
    return schema.parse(parsed);
  }
  throw new Error("模型输出中找不到合法 JSON(no_json_found)");
}

export type GenerateFn = (input: { messages: CoreMessage[] }) => Promise<{ text: string }>;

/** 结构化生成:失败时把原文+错误喂回模型重试一次,第二次仍坏则抛。 */
export async function generateStructured<TSchema extends z.ZodTypeAny>(input: {
  generate: GenerateFn;
  schema: TSchema;
  messages: CoreMessage[];
}): Promise<z.infer<TSchema>> {
  const first = await input.generate({ messages: input.messages });
  try {
    return extractJson(first.text, input.schema);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryMessages: CoreMessage[] = [
      ...input.messages,
      {
        role: "user",
        content:
          `你上次输出无法解析:${first.text.slice(0, 500)}\n` +
          `错误:${message}\n重新只输出符合要求的 JSON。`,
      },
    ];
    const second = await input.generate({ messages: retryMessages });
    return extractJson(second.text, input.schema);
  }
}
