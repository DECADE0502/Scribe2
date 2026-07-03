// 与 server 的最小 API 层。
export interface BookSummary {
  name: string;
  genre: string;
  chapters: number;
  ready: boolean;
}

export interface BookStatus {
  name: string;
  genre: string;
  pov: string;
  ready: boolean;
  missing: string[];
  chapters: number[];
  openIssues: number;
  indexCount: number;
  cost: { totalCostUsd: number; byRole: Record<string, { calls: number; costUsd: number }> };
}

export interface FileGroups {
  memory: string[];
  characters: string[];
  worldbooks: string[];
  summaries: string[];
  arcs: string[];
}

export interface ChapterInfo {
  no: number;
  title: string;
  words: number;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `请求失败(${res.status})`);
  return data;
}

export const api = {
  books: () => fetch("/api/books").then((r) => jsonOrThrow<BookSummary[]>(r)),
  status: (book: string) =>
    fetch(`/api/books/${encodeURIComponent(book)}/status`).then((r) => jsonOrThrow<BookStatus>(r)),
  files: (book: string) =>
    fetch(`/api/books/${encodeURIComponent(book)}/files`).then((r) => jsonOrThrow<FileGroups>(r)),
  chapters: (book: string) =>
    fetch(`/api/books/${encodeURIComponent(book)}/chapters`).then((r) => jsonOrThrow<ChapterInfo[]>(r)),
  readChapter: (book: string, no: number) =>
    fetch(`/api/books/${encodeURIComponent(book)}/chapters/${no}`).then((r) =>
      jsonOrThrow<{ no: number; title: string; text: string }>(r),
    ),
  saveChapter: (book: string, no: number, text: string, title: string) =>
    fetch(`/api/books/${encodeURIComponent(book)}/chapters/${no}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, title }),
    }).then((r) => jsonOrThrow<{ ok: boolean }>(r)),
  readFile: (book: string, path: string) =>
    fetch(`/api/books/${encodeURIComponent(book)}/file?path=${encodeURIComponent(path)}`).then((r) =>
      jsonOrThrow<{ path: string; content: string }>(r),
    ),
  saveFile: (book: string, path: string, content: string) =>
    fetch(`/api/books/${encodeURIComponent(book)}/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }).then((r) => jsonOrThrow<{ ok: boolean }>(r)),
};

export interface SseHandlers {
  onDelta?: (delta: string) => void;
  onUsage?: (role: string) => void;
  onDone?: (result: unknown) => void;
  onError?: (message: string) => void;
}

/** POST run 并解析 SSE 流(EventSource 不支持 POST,手工读流)。 */
export async function runWorkflow(
  book: string,
  workflow: string,
  args: Record<string, unknown>,
  handlers: SseHandlers,
): Promise<void> {
  const res = await fetch(`/api/books/${encodeURIComponent(book)}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow, args }),
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    handlers.onError?.(data.error ?? `请求失败(${res.status})`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf("\n\n");
      const event = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
      const dataRaw = /^data:\s*(.+)$/m.exec(block)?.[1];
      if (!event || !dataRaw) continue;
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(dataRaw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event === "text_delta") handlers.onDelta?.(String(data["delta"] ?? ""));
      else if (event === "usage") handlers.onUsage?.(String(data["role"] ?? ""));
      else if (event === "done") handlers.onDone?.(data["result"]);
      else if (event === "error") handlers.onError?.(String(data["message"] ?? "未知错误"));
    }
  }
}
