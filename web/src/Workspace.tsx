import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { api, runWorkflow, type ChapterInfo, type FileGroups } from "./api";

type Selected = { kind: "chapter"; no: number } | { kind: "file"; path: string } | null;

interface LogLine {
  cls: "sys" | "err" | "";
  text: string;
}

const WORKFLOWS = [
  { value: "write", label: "写章(单章/连写)" },
  { value: "chat", label: "聊天(零副作用)" },
  { value: "audit", label: "审查(近5章)" },
  { value: "fix", label: "修复最新章" },
  { value: "onboard", label: "建书对话" },
] as const;

export function Workspace({ book }: { book: string }) {
  const [chapters, setChapters] = useState<ChapterInfo[]>([]);
  const [files, setFiles] = useState<FileGroups | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const [workflow, setWorkflow] = useState<string>("write");
  const [chapterArg, setChapterArg] = useState("");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const refreshLists = useCallback(() => {
    api.chapters(book).then(setChapters).catch(() => setChapters([]));
    api.files(book).then(setFiles).catch(() => setFiles(null));
  }, [book]);

  useEffect(refreshLists, [refreshLists]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  // 未保存时拦截关页/刷新
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const open = useCallback(
    async (sel: Selected) => {
      if (!sel) return;
      if (dirty && !window.confirm("当前内容尚未保存,切换将丢失修改,确认切走?")) return;
      if (sel.kind === "chapter") {
        const ch = await api.readChapter(book, sel.no);
        setContent(ch.text);
        setTitle(ch.title);
      } else {
        const f = await api.readFile(book, sel.path);
        setContent(f.content);
        setTitle("");
      }
      setSelected(sel);
      setDirty(false);
    },
    [book, dirty],
  );

  const save = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    try {
      if (selected.kind === "chapter") await api.saveChapter(book, selected.no, content, title);
      else await api.saveFile(book, selected.path, content);
      setDirty(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [book, selected, content, title]);

  const appendLog = (line: LogLine) => setLog((prev) => [...prev, line]);
  const appendDelta = (delta: string) =>
    setLog((prev) => {
      const last = prev.at(-1);
      if (last && last.cls === "") {
        return [...prev.slice(0, -1), { cls: "", text: last.text + delta }];
      }
      return [...prev, { cls: "", text: delta }];
    });

  const run = useCallback(async () => {
    const args: Record<string, unknown> = {};
    if (workflow === "write") {
      const m = /^(\d+)(?:\.\.(\d+))?$/.exec(chapterArg.trim());
      if (!m) {
        appendLog({ cls: "err", text: "章号格式:5 或 5..8" });
        return;
      }
      args["from"] = Number(m[1]);
      args["to"] = Number(m[2] ?? m[1]);
      if (message.trim()) args["instruction"] = message.trim();
    } else if (workflow === "chat" || workflow === "onboard") {
      if (!message.trim()) {
        appendLog({ cls: "err", text: "请输入消息" });
        return;
      }
      args["message"] = message.trim();
    }
    setRunning(true);
    appendLog({ cls: "sys", text: `▶ ${WORKFLOWS.find((w) => w.value === workflow)?.label ?? workflow}` });
    try {
      await runWorkflow(book, workflow, args, {
        onDelta: appendDelta,
        onUsage: (role) => appendLog({ cls: "sys", text: `· ${role} 调用完成` }),
        onDone: (result) => {
          appendLog({ cls: "sys", text: `✔ 完成:${JSON.stringify(result ?? {})}` });
          refreshLists();
        },
        onError: (msg) => appendLog({ cls: "err", text: `✘ ${msg}` }),
      });
    } catch (e) {
      appendLog({ cls: "err", text: `✘ ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setRunning(false); // 任何异常路径都不能把"运行"按钮永久卡死
    }
  }, [book, workflow, chapterArg, message, refreshLists]);

  const sideItem = (key: string, label: string, sel: Selected) => {
    const isSelected =
      selected &&
      sel &&
      ((selected.kind === "chapter" && sel.kind === "chapter" && selected.no === sel.no) ||
        (selected.kind === "file" && sel.kind === "file" && selected.path === sel.path));
    return (
      <div key={key} className={`item ${isSelected ? "selected" : ""}`} onClick={() => void open(sel)}>
        {label}
      </div>
    );
  };

  return (
    <div className="workspace">
      <aside className="sidebar">
        <h4>章节</h4>
        {chapters.map((c) =>
          sideItem(`ch-${c.no}`, `第${c.no}章 ${c.title || ""}(${c.words}字)`, { kind: "chapter", no: c.no }),
        )}
        {chapters.length === 0 && <div className="item">(尚无章节)</div>}
        <h4>记忆文件</h4>
        {files?.memory.map((p) => sideItem(p, p, { kind: "file", path: p }))}
        <h4>角色</h4>
        {files?.characters.map((p) => sideItem(p, p.replace("角色/", "").replace(".md", ""), { kind: "file", path: p }))}
        <h4>世界书</h4>
        {files?.worldbooks.map((p) => sideItem(p, p.replace("世界书/", "").replace(".md", ""), { kind: "file", path: p }))}
        <h4>摘要</h4>
        {files?.summaries.map((p) => sideItem(p, p.replace("摘要/", "").replace(".md", ""), { kind: "file", path: p }))}
        <h4>弧纲要</h4>
        {files?.arcs.map((p) => sideItem(p, p.replace("弧/", "").replace(".md", ""), { kind: "file", path: p }))}
      </aside>

      <section className="editor-pane">
        <div className="editor-head">
          <span className="name">
            {selected
              ? selected.kind === "chapter"
                ? `第${selected.no}章`
                : selected.path
              : "从左侧选择要查看/编辑的内容"}
          </span>
          {selected?.kind === "chapter" && (
            <input
              value={title}
              placeholder="章节标题"
              onChange={(e) => {
                setTitle(e.target.value);
                setDirty(true);
              }}
            />
          )}
          {dirty && <span className="dirty">未保存</span>}
          <button onClick={() => void save()} disabled={!selected || !dirty || saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
        <div className="editor-body">
          {selected && (
            <CodeMirror
              value={content}
              height="100%"
              extensions={[markdown()]}
              onChange={(value) => {
                setContent(value);
                setDirty(true);
              }}
            />
          )}
        </div>
      </section>

      <section className="run-pane">
        <div className="run-form">
          <select value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
            {WORKFLOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
          {workflow === "write" && (
            <input
              value={chapterArg}
              onChange={(e) => setChapterArg(e.target.value)}
              placeholder="章号:5 或 5..8"
            />
          )}
          {workflow !== "audit" && workflow !== "fix" && (
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder={workflow === "write" ? "本章指令(可空)" : "消息内容"}
            />
          )}
          <button onClick={() => void run()} disabled={running}>
            {running ? "运行中…" : "运行"}
          </button>
        </div>
        <div className="run-log" ref={logRef}>
          {log.map((line, i) => (
            <div key={i} className={line.cls}>
              {line.text}
            </div>
          ))}
          {log.length === 0 && <div className="sys">工作流输出会流式显示在这里。</div>}
        </div>
      </section>
    </div>
  );
}
