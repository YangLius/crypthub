/** 检索页：混合检索（向量 + 关键词 → RRF），带出处片段。 */
import { useState } from "react";
import { api } from "../api/client";
import { Button, Empty, Spinner } from "../components/ui";

interface Result {
  document_id: string;
  title: string;
  anchor: string;
  idx: number;
  snippet: string;
  score: number;
}

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const go = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const r = await api.post<{ results: Result[] }>("/search", { q });
      setResults(r.results);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "检索失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      <div className="page-head">
        <h2>检索</h2>
      </div>
      <div className="card">
        <div className="toolbar">
          <input
            type="text"
            style={{ flex: 1 }}
            placeholder="描述你要找的内容，例如：生产环境的 Redis 部署记录"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void go();
            }}
            autoFocus
          />
          <Button kind="primary" disabled={busy} onClick={() => void go()}>
            {busy ? "检索中…" : "检索"}
          </Button>
        </div>
        {err && (
          <div className="blocked-banner" style={{ marginBottom: 10 }}>
            {err}
          </div>
        )}
        {results === null ? null : results.length === 0 ? (
          <Empty text="没有命中的片段" />
        ) : (
          results.map((r, i) => (
            <div key={i} className="card" style={{ margin: "10px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <b>
                  《{r.title}》 · {r.anchor}
                </b>
                <span className="muted">
                  相关度 {(r.score * 100).toFixed(0)}%
                </span>
              </div>
              <div
                style={{
                  marginTop: 6,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                }}
              >
                {r.snippet}
                {r.snippet.length >= 300 ? "…" : ""}
              </div>
            </div>
          ))
        )}
        {busy && <Spinner text="向量 + 关键词双路检索…" />}
      </div>
    </div>
  );
}
