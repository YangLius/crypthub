/** GitHub 每日热点 v2：
 *  - 左侧竖向两级分类菜单（父分类可展开子菜单，含计数徽标；顶部「全部」）；
 *  - 内容区一次只看一个分类（或子分类），每个类型展示个数不限；
 *  - 双榜：总星榜（总星降序）/ 热榜（今日新增降序），两列均展示；
 *  - 每页 10 个分页；表格勾选后可批量整理；每行有单独「整理」按钮。
 *  数据由后端抓取 github.com/trending 并做两级关键词分类（缓存 1 小时，可强制刷新）。 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { toast, toastErr } from "../store";
import { Button, Empty, Spinner } from "../components/ui";

const PER_PAGE = 10;

const RANGES: Array<{ key: string; label: string; group: string }> = [
  { key: "daily", label: "今日热榜", group: "热榜" },
  { key: "weekly", label: "本周热榜", group: "热榜" },
  { key: "monthly", label: "本月热榜", group: "热榜" },
  { key: "new", label: "近7天新星", group: "普通" },
  { key: "all", label: "总星Top1000", group: "普通" },
];

interface Repo {
  full_name: string;
  url: string;
  desc: string;
  language: string;
  stars: number;
  forks: number;
  stars_today: number | null;
  sub: string | null;
  sub_label: string | null;
}

interface Cat {
  key: string;
  label: string;
  count: number;
  repos: Repo[];
}

interface SubInfo {
  key: string;
  label: string;
}

interface TaxoCat {
  key: string;
  label: string;
  subs: SubInfo[];
}

interface TrendData {
  range: string;
  delta_label: string | null;
  date: string;
  fetched_at: string;
  total: number;
  taxonomy: TaxoCat[];
  categories: Cat[];
  pages_fetched?: number;
  pages_total?: number;
}

interface ArchiveResult {
  date: string;
  results: Array<{
    full_name: string;
    doc_id: string;
    created: boolean;
    path: string;
    category: string;
    sub: string | null;
  }>;
  not_found: string[];
}

type Board = "total" | "hot";

export default function GitHubPage() {
  const [data, setData] = useState<TrendData | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState("daily");
  const [sel, setSel] = useState<{ cat: string | null; sub: string | null }>({
    cat: null,
    sub: null,
  });
  const [board, setBoard] = useState<Board>("hot");
  const [page, setPage] = useState(1);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [openCats, setOpenCats] = useState<Set<string>>(new Set());
  const [archiving, setArchiving] = useState("");
  const [depthLoading, setDepthLoading] = useState(false);

  const load = useCallback(
    async (rng: string, force: boolean, depth?: number) => {
      if (force) setRefreshing(true);
      else setLoading(true);
      setErr("");
      try {
        const q = new URLSearchParams({ range: rng });
        if (force) q.set("force", "true");
        if (depth) q.set("depth", String(depth));
        setData(await api.get<TrendData>(`/github/trending?${q.toString()}`));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "加载失败");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  // 首次与切范围：搜索池先取 1 页（秒级首屏），热榜整包；range 变化必须重新拉取
  useEffect(() => {
    void load(range, false, range === "new" || range === "all" ? 1 : undefined);
  }, [load, range]);

  // 渐进补抓：后台续抓下 2 页（不转全屏 loading；续抓不重抓已抓页）
  const depthBusy = useRef(false);
  const ensureDepth = useCallback(async () => {
    if (!data || depthBusy.current) return;
    const pf = data.pages_fetched ?? 0;
    const pt = data.pages_total ?? 0;
    if (!pt || pf >= pt) return;
    depthBusy.current = true;
    setDepthLoading(true);
    try {
      setData(
        await api.get<TrendData>(
          `/github/trending?range=${data.range}&depth=${Math.min(pf + 2, pt)}`,
        ),
      );
    } catch {
      /* 静默：下次翻页再试 */
    } finally {
      depthBusy.current = false;
      setDepthLoading(false);
    }
  }, [data]);

  // ---- 数据派生 ----
  const catMap = useMemo(() => {
    const m = new Map<string, Cat>();
    for (const c of data?.categories ?? []) m.set(c.key, c);
    return m;
  }, [data]);

  const allRepos = useMemo(() => {
    const out: Array<Repo & { cat: string; cat_label: string }> = [];
    for (const c of data?.categories ?? [])
      for (const r of c.repos)
        out.push({ ...r, cat: c.key, cat_label: c.label });
    return out;
  }, [data]);

  const visible = useMemo(() => {
    let rows = allRepos;
    if (sel.cat !== null) rows = rows.filter((r) => r.cat === sel.cat);
    if (sel.sub !== null) rows = rows.filter((r) => r.sub === sel.sub);
    return rows;
  }, [allRepos, sel]);

  const sorted = useMemo(() => {
    const rows = [...visible];
    if (board === "total") {
      rows.sort(
        (a, b) =>
          b.stars - a.stars ||
          (b.stars_today ?? 0) - (a.stars_today ?? 0) ||
          a.full_name.localeCompare(b.full_name),
      );
    } else {
      rows.sort(
        (a, b) =>
          (b.stars_today ?? 0) - (a.stars_today ?? 0) ||
          b.stars - a.stars ||
          a.full_name.localeCompare(b.full_name),
      );
    }
    return rows;
  }, [visible, board]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageItems = sorted.slice(
    (safePage - 1) * PER_PAGE,
    safePage * PER_PAGE,
  );

  // 翻页接近当前视图末尾时，后台续抓更多 GitHub 页（实时翻页拉取）
  useEffect(() => {
    if (safePage * PER_PAGE >= sorted.length - PER_PAGE) void ensureDepth();
  }, [safePage, sorted.length, ensureDepth]);

  const countCat = useCallback(
    (key: string) => catMap.get(key)?.count ?? 0,
    [catMap],
  );
  const countSub = useCallback(
    (catKey: string, subKey: string) =>
      catMap.get(catKey)?.repos.filter((r) => r.sub === subKey).length ?? 0,
    [catMap],
  );

  const headerLabel =
    sel.cat === null
      ? `全部（${data?.total ?? 0}）`
      : `${catMap.get(sel.cat)?.label ?? sel.cat}${sel.sub === null ? "" : ` / ${sel.sub}`}`;

  // 切换分类/榜单/范围时重置页码与勾选
  useEffect(() => {
    setPage(1);
    setChecked(new Set());
  }, [sel, board, range]);

  // ---- 动作 ----
  const pickRange = (rng: string) => {
    setRange(rng);
    setSel({ cat: null, sub: null });
    if (rng === "new" || rng === "all") setBoard("total");
    else setBoard("hot");
  };
  const topTab: "hot" | "normal" =
    RANGES.find((x) => x.key === range)?.group === "热榜" ? "hot" : "normal";
  const pickTop = (t: "hot" | "normal") => {
    if (t === topTab) return;
    pickRange(t === "hot" ? "daily" : "all");
  };
  const pickCat = (key: string | null) => {
    setSel({ cat: key, sub: null });
    if (key !== null)
      setOpenCats((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
  };
  const pickSub = (catKey: string, subKey: string) =>
    setSel({ cat: catKey, sub: subKey });
  const toggleOpen = (key: string) =>
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleOne = (fn: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(fn)) next.delete(fn);
      else next.add(fn);
      return next;
    });
  const togglePage = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      const all = pageItems.every((r) => next.has(r.full_name));
      for (const r of pageItems) {
        if (all) next.delete(r.full_name);
        else next.add(r.full_name);
      }
      return next;
    });

  const archive = async (names: string[]) => {
    if (names.length === 0) return;
    setArchiving(names.length === 1 ? names[0] : "__batch__");
    try {
      const r = await api.post<ArchiveResult>("/github/archive", {
        full_names: names,
      });
      const created = r.results.filter((x) => x.created).length;
      const updated = r.results.length - created;
      const miss = r.not_found ?? [];
      let msg = `已整理 ${r.results.length} 个项目到 文档区/GitHub/...（新建 ${created}，更新 ${updated}）`;
      if (miss.length) msg += `；未在今日热榜：${miss.join("、")}`;
      toast(msg);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "归档失败");
    } finally {
      setArchiving("");
    }
  };

  // ---- 渲染 ----
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
        <Button
          kind="primary"
          onClick={() => void load(range, true, data?.pages_fetched)}
        >
          重试（强制刷新）
        </Button>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="gh-wrap">
      {/* 左侧两级分类菜单 */}
      <aside className="gh-side">
        <div className="gh-side-title">分类</div>
        <div
          className={`gh-item ${sel.cat === null ? "gh-item-on" : ""}`}
          onClick={() => pickCat(null)}
        >
          <span className="gh-item-label">全部</span>
          <span className="gh-badge">{data.total}</span>
        </div>
        {data.taxonomy.map((t) => {
          const n = countCat(t.key);
          const isOpen = openCats.has(t.key);
          const active = sel.cat === t.key;
          return (
            <div key={t.key} className="gh-cat">
              <div
                className={`gh-item ${active && sel.sub === null ? "gh-item-on" : ""}`}
                onClick={() => pickCat(t.key)}
              >
                <span
                  className={`gh-arrow ${n === 0 ? "gh-arrow-off" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleOpen(t.key);
                  }}
                >
                  {isOpen ? "▾" : "▸"}
                </span>
                <span className="gh-item-label">{t.label}</span>
                <span className="gh-badge">{n}</span>
              </div>
              {isOpen && t.subs.length > 0 && (
                <div className="gh-subs">
                  {t.subs.map((s) => (
                    <div
                      key={s.key}
                      className={`gh-item gh-item-sub ${sel.cat === t.key && sel.sub === s.key ? "gh-item-on" : ""}`}
                      onClick={() => pickSub(t.key, s.key)}
                    >
                      <span className="gh-item-label">{s.label}</span>
                      <span className="gh-badge">{countSub(t.key, s.key)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </aside>

      {/* 右侧内容区 */}
      <div className="gh-main">
        <div className="page-head" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>GitHub 热点 · {headerLabel}</h2>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <Button
              disabled={refreshing}
              onClick={() => void load(range, true, data?.pages_fetched)}
            >
              {refreshing ? "刷新中…" : "强制刷新"}
            </Button>
            <Button
              kind="primary"
              disabled={checked.size === 0 || !!archiving}
              onClick={() => void archive([...checked])}
            >
              {archiving === "__batch__"
                ? "整理中…"
                : `整理所选（${checked.size}）`}
            </Button>
          </div>
        </div>
        <div className="secret-hint">
          {data.date} ·{" "}
          {RANGES.find((x) => x.key === data.range)?.label ?? data.range}：已加载{" "}
          {data.total} 个
          {data.pages_total
            ? `（GitHub 第 ${data.pages_fetched}/${data.pages_total} 页）`
            : ""}          · 抓取时间 {data.fetched_at.slice(11, 16)}（缓存 1
          小时）。热榜（今日/本周/本月）为官方 trending 各 ~10 个；普通池按总星排序、
          翻到末尾自动逐页实时拉取（近7天新星 / 总星Top1000，Search API
          单查询硬上限 1000）。点「整理」归档到
          文档区/GitHub/分类[/子分类]；勾选后可批量整理（同日重复整理=更新）。
        </div>

        {/* 顶层：热榜 / 普通 */}
        <div className="gh-tabs">
          <button
            className={`gh-tab ${topTab === "hot" ? "gh-tab-on" : ""}`}
            onClick={() => pickTop("hot")}
          >
            🔥 热榜
          </button>
          <button
            className={`gh-tab ${topTab === "normal" ? "gh-tab-on" : ""}`}
            onClick={() => pickTop("normal")}
          >
            📦 普通
          </button>
        </div>

        {/* 当前组的数据范围 */}
        <div className="gh-tabs">
          {RANGES.filter((x) =>
            topTab === "hot" ? x.group === "热榜" : x.group === "普通",
          ).map((x) => (
            <button
              key={x.key}
              className={`gh-tab ${range === x.key ? "gh-tab-on" : ""}`}
              onClick={() => pickRange(x.key)}
            >
              {x.label}
            </button>
          ))}
        </div>

        {/* 双榜切换 */}
        <div className="gh-tabs">
          {topTab === "hot" && (
            <button
              className={`gh-tab ${board === "hot" ? "gh-tab-on" : ""}`}
              onClick={() => setBoard("hot")}
            >
              🔥 {data.delta_label ?? "增量"}榜
            </button>
          )}
          <button
            className={`gh-tab ${
              board === "total" || topTab === "normal" ? "gh-tab-on" : ""
            }`}
            onClick={() => setBoard("total")}
          >
            ⭐ 总星榜
          </button>
          <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
            本分类 {sorted.length} 个 · 第 {safePage}/{totalPages} 页
            {topTab === "normal" ? " · 普通池无每日增量数据" : ""}
          </span>
          {data.pages_total && (data.pages_fetched ?? 0) < data.pages_total ? (
            <button
              className="gh-tab"
              style={{ marginLeft: "auto" }}
              disabled={depthLoading}
              onClick={() => void ensureDepth()}
            >
              {depthLoading ? "后台抓取中…" : "加载更多（GitHub 下两页）"}
            </button>
          ) : null}
        </div>

        {sorted.length === 0 ? (
          <Empty text="今日该分类暂无上榜项目（每日热榜项目有限，可切其他分类或明日再看）" />
        ) : (
          <div className="card" style={{ marginTop: 10 }}>
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={
                        pageItems.length > 0 &&
                        pageItems.every((r) => checked.has(r.full_name))
                      }
                      onChange={togglePage}
                    />
                  </th>
                  <th style={{ width: 36 }}>#</th>
                  <th>项目</th>
                  <th style={{ width: 150 }}>分类</th>
                  <th>简介</th>
                  <th style={{ width: 90 }}>语言</th>
                  <th style={{ width: 90 }}>总星</th>
                  <th style={{ width: 90 }}>
                    {data.delta_label ?? "每日新增"}
                  </th>
                  <th style={{ width: 76 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((r, i) => (
                  <tr key={r.full_name}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked.has(r.full_name)}
                        onChange={() => toggleOne(r.full_name)}
                      />
                    </td>
                    <td className="muted">
                      {(safePage - 1) * PER_PAGE + i + 1}
                    </td>
                    <td>
                      <a href={r.url} target="_blank" rel="noreferrer">
                        {r.full_name}
                      </a>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {r.cat_label}
                      {r.sub_label ? ` / ${r.sub_label}` : ""}
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {r.desc || "（无描述）"}
                    </td>
                    <td>{r.language || "—"}</td>
                    <td>⭐ {r.stars.toLocaleString()}</td>
                    <td
                      style={{
                        color:
                          r.stars_today === null ? "var(--muted)" : "var(--ok)",
                      }}
                    >
                      {r.stars_today === null
                        ? "—"
                        : `+${r.stars_today.toLocaleString()}`}
                    </td>
                    <td>
                      <Button
                        disabled={!!archiving}
                        onClick={() => void archive([r.full_name])}
                      >
                        {archiving === r.full_name ? "整理中…" : "整理"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalPages > 1 && (
              <div className="gh-pager">
                <Button
                  disabled={safePage <= 1}
                  onClick={() => setPage(safePage - 1)}
                >
                  ← 上一页
                </Button>
                <span>
                  第 {safePage} / {totalPages} 页
                </span>
                <Button
                  disabled={safePage >= totalPages}
                  onClick={() => setPage(safePage + 1)}
                >
                  下一页 →
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
