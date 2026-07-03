import { useEffect, useState } from "react";
import { api, type BookSummary, type BookStatus } from "./api";
import { Workspace } from "./Workspace";

type View = { page: "library" } | { page: "workspace"; book: string } | { page: "settings" };

function Library({ onOpen }: { onOpen: (book: string) => void }) {
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.books().then(setBooks).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <div className="library">加载失败:{error}</div>;
  if (!books) return <div className="library">加载中…</div>;
  return (
    <div className="library">
      {books.map((b) => (
        <div key={b.name} className="book-card" onClick={() => onOpen(b.name)}>
          <h3>{b.name}</h3>
          <div className="meta">
            {b.genre || "未定题材"} · {b.chapters} 章 · {b.ready ? "可写作" : "未就绪"}
          </div>
        </div>
      ))}
      {books.length === 0 && (
        <div>
          还没有书。用命令行建一本:<code>pnpm dev new 书名</code>
        </div>
      )}
    </div>
  );
}

function Settings({ book }: { book: string | null }) {
  const [status, setStatus] = useState<BookStatus | null>(null);
  useEffect(() => {
    if (book) api.status(book).then(setStatus).catch(() => setStatus(null));
  }, [book]);
  return (
    <div className="settings">
      <h2>设置</h2>
      <p>
        模型与角色配置在仓库根的 <code>config.json</code>(五角色:writer / planner / extractor /
        auditor / embedding,未配角色沿回退链落到 writer);密钥在 <code>secrets.env</code>,永不入库。
        改完配置重启服务即生效。
      </p>
      <p>
        深层提示词:全局 <code>config.json → masterPrompt</code>,书级覆盖/关闭在书目录
        <code>book.md</code> 的 <code>master_prompt</code> / <code>深层提示词</code> 字段;
        章末标记等校验开关在 <code>book.md → lint</code> 节。
      </p>
      {status && (
        <div className="status-box">
          <div>当前书:{status.name}({status.genre || "未定题材"},{status.pov || "视角未定"})</div>
          <div>章节 {status.chapters.length} 章 · 开放问题 {status.openIssues} 条 · 索引 {status.indexCount} 块</div>
          <div>累计成本 ${status.cost.totalCostUsd.toFixed(4)}</div>
          <div>
            {Object.entries(status.cost.byRole).map(([role, s]) => (
              <span key={role} style={{ marginRight: 12 }}>
                {role}:{s.calls} 次
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>({ page: "library" });
  const [lastBook, setLastBook] = useState<string | null>(null);
  return (
    <>
      <div className="topbar">
        <h1>Scribe 写作台</h1>
        <button className={view.page === "library" ? "active" : ""} onClick={() => setView({ page: "library" })}>
          书库
        </button>
        {lastBook && (
          <button
            className={view.page === "workspace" ? "active" : ""}
            onClick={() => setView({ page: "workspace", book: lastBook })}
          >
            工作台:{lastBook}
          </button>
        )}
        <button className={view.page === "settings" ? "active" : ""} onClick={() => setView({ page: "settings" })}>
          设置
        </button>
      </div>
      {view.page === "library" && (
        <Library
          onOpen={(book) => {
            setLastBook(book);
            setView({ page: "workspace", book });
          }}
        />
      )}
      {view.page === "workspace" && <Workspace book={view.book} />}
      {view.page === "settings" && <Settings book={lastBook} />}
    </>
  );
}
