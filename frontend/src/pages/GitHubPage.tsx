/** GitHub 每日热点：分类 Top10 总览 + 一键整理到文档区 GitHub/<分类>。
 *  数据由后端抓取 github.com/trending 并按关键词分类（缓存 1 小时，可强制刷新）。 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { toast, toastErr } from "../store";
import { Button, Empty, Spinner } from "../components/ui";

interface Repo {
  full_name: string;
  url: string;
  desc: string;
  language: string;
  stars: number;
  forks: number;
  stars_today: number;
}

interface Cat {
  key: string;
  label: string;
  count: number;
  repos: Repo[];
}

interface TrendData {
  date: string;
  fetched_at: string;
  total: number;
  categories: Cat[];
}

interface ArchiveResult {
  date: string;
  results: Array<{
    category: string;
    label: string;
    doc_id: string;
    created: boolean;
    repos: number;
  }>;
}

export default function GitHubPage() {
  const [data, setData] = useState<TrendData | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [archiving, setArchiving] = useState("");

  const load = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setErr("");
    try {
      setData(await api.get<TrendData>(`/github/trending${force ? "?force=true" : ""}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const archive = async (category: string | null) => {
    setArchiving(category ?? "__all__");
    try {
      const r = await api.post<ArchiveResult>("/github/archive", { category });
      const n = r.results.length;
      const updated = r.results.filter((x) => !x.created).length;
      toast(
        `已整理 ${n} 个分类到 文档区/GitHub/${r.date}${updated ? `（其中 ${updated} 个为更新当日旧档）` : ""}，索引就绪后即可检索`,
      );
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "归档失败");
    } finally {
      setArchiving("");
    }
  };

  if (loading) {
    return (
      <div className="card">
        <Spinner /> 正在抓取 GitHub Trending…
      </div>
    );
  }
  if (err) {
    return (
      <div className="card">
        <div className="blocked-banner">{err}</div>
        <Button kind="primary" onClick={() => void load(true)}>
          重试（强制刷新）
        </Button>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div>
      <div className="page-head">
        <h2>GitHub 热点</h2>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <Button disabled={refreshing} onClick={() => void load(true)}>
            {refreshing ? "刷新中…" : "强制刷新"}
          </Button>
          <Button
            kind="primary"
            disabled={!!archiving}
            onClick={() => void archive(null)}
          >
            {archiving === "__all__" ? "整理中…" : "一键整理全部到文档"}
          </Button>
        </div>
      </div>
      <div className="secret-hint">
        {data.date} · 共 {data.total} 个上榜项目 · 每类取今日新增星标 Top10 ·
        抓取时间 {data.fetched_at.slice(11, 16)}（缓存 1 小时）。
        「整理到文档」会在 文档区/GitHub/&lt;分类&gt; 下生成当日日报（同日重复整理=更新）。
      </div>

      {data.categories.length === 0 && <Empty text="今日没有解析到上榜项目" />}

      {data.categories.map((c) => (
        <div className="card" key={c.key} style={{ marginTop: 14 }}>
          <div className="page-head" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>
              {c.label} <span className="muted">（{c.count}）</span>
            </h3>
            <Button
              disabled={!!archiving}
              onClick={() => void archive(c.key)}
            >
              {archiving === c.key ? "整理中…" : "整理到文档"}
            </Button>
          </div>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 44 }}>#</th>
                <th>项目</th>
                <th>简介</th>
                <th style={{ width: 110 }}>语言</th>
                <th style={{ width: 90 }}>总星</th>
                <th style={{ width: 90 }}>今日新增</th>
              </tr>
            </thead>
            <tbody>
              {c.repos.map((r, i) => (
                <tr key={r.full_name}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <a href={r.url} target="_blank" rel="noreferrer">
                      {r.full_name}
                    </a>
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {r.desc || "（无描述）"}
                  </td>
                  <td>{r.language || "—"}</td>
                  <td>⭐ {r.stars.toLocaleString()}</td>
                  <td style={{ color: "var(--ok, #2e7d32)" }}>
                    +{r.stars_today.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
