import * as fs from "node:fs";
import * as path from "node:path";

/** 头部 <!-- --> 注释块只是给人看的说明,渲染前剥掉。 */
function stripHeadComment(template: string): string {
  return template.replace(/^\s*<!--[\s\S]*?-->\r?\n?/, "");
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function stringify(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join("\n");
  return String(value);
}

/**
 * 极简模板:{{var}} 替换 + {{#if x}}…{{/if}} 条件段。
 * 缺失变量一律抛错——提示词出现静默空洞比崩溃更危险。
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  let out = stripHeadComment(template);
  out = out.replace(
    /\{\{#if\s+([^}]+?)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_m, name: string, body: string) => (isTruthy(vars[name]) ? body : ""),
  );
  out = out.replace(/\{\{\s*([^#/}][^}]*?)\s*\}\}/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) {
      throw new Error(`模板变量「${name}」未提供(template_var_missing)`);
    }
    return stringify(value);
  });
  return out;
}

let builtinDirCache: string | undefined;

function builtinPromptsDir(): string {
  if (builtinDirCache) return builtinDirCache;
  // 源码运行(tsx):src/ → ../prompts;构建产物:dist/src/ → ../../prompts
  const candidates = [
    path.resolve(import.meta.dirname, "..", "prompts"),
    path.resolve(import.meta.dirname, "..", "..", "prompts"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      builtinDirCache = dir;
      return dir;
    }
  }
  throw new Error(`找不到内置提示词目录 prompts/(prompts_dir_not_found)`);
}

/** 载入提示词原文:书目录 prompts/<name>.md 优先,退回内置。 */
export function loadPrompt(name: string, bookDir?: string): string {
  if (bookDir) {
    const override = path.join(bookDir, "prompts", `${name}.md`);
    if (fs.existsSync(override)) return fs.readFileSync(override, "utf8");
  }
  const builtin = path.join(builtinPromptsDir(), `${name}.md`);
  if (fs.existsSync(builtin)) return fs.readFileSync(builtin, "utf8");
  throw new Error(`找不到提示词「${name}」(prompt_not_found)`);
}
