/**
 * 硬校验(SPEC §4.1):消毒后的正文是否达标。规则可由 book.md 的 lint 节配置。
 * 返回第一条违规(写章管线拿它做"带因重写")。
 */

export interface LintOptions {
  pov?: string;
  minChars?: number;
  allowTailMarkers?: boolean;
}

export type LintResult = { ok: true } | { ok: false; reason: string; detail: string };

const TAIL_MARKERS = /(未完待续|待续|未完|本章完|下一章预告|下章预告|敬请期待|欲知后事)/;

export function lintProse(text: string, options: LintOptions = {}): LintResult {
  const minChars = options.minChars ?? 0;
  const trimmed = text.trim();

  if (trimmed.length < minChars) {
    return {
      ok: false,
      reason: "too_short",
      detail: `正文仅 ${trimmed.length} 字,低于最少 ${minChars} 字`,
    };
  }

  if (!options.allowTailMarkers) {
    const tail = trimmed.slice(-40);
    const hit = TAIL_MARKERS.exec(tail);
    if (hit) {
      return {
        ok: false,
        reason: "tail_marker",
        detail: `章末出现连载尾标记「${hit[1]}」`,
      };
    }
  }

  if (options.pov?.includes("第一人称")) {
    const paragraphs = trimmed.split(/\n\s*\n/).slice(0, 2);
    if (paragraphs.length > 0 && !paragraphs.some((p) => p.includes("我"))) {
      return {
        ok: false,
        reason: "pov_drift",
        detail: "书设定为第一人称,但开头两段没有出现「我」",
      };
    }
  }

  return { ok: true };
}
