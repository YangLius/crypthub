import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client";
import { useApp, useToasts } from "./store";
import { Badge } from "./components/ui";
import LoginPage from "./pages/LoginPage";
import SetupPage from "./pages/SetupPage";
import DocsPage from "./pages/DocsPage";
import ChatPage from "./pages/ChatPage";
import SearchPage from "./pages/SearchPage";
import SecretsPage from "./pages/SecretsPage";
import AdminPage from "./pages/AdminPage";
import AuditPage from "./pages/AuditPage";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, meLoaded } = useApp();
  if (!meLoaded) return <div className="page-loading">加载中…</div>;
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

function Header() {
  const { me, vault, setVault } = useApp();
  const [unread, setUnread] = useState(0);
  const loc = useLocation();

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await api.get<{
          notifications: { read_at: string | null }[];
        }>("/notifications");
        if (alive) setUnread(r.notifications.filter((n) => !n.read_at).length);
      } catch {
        /* 忽略轮询错误 */
      }
    };
    poll();
    const t = setInterval(poll, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [loc.pathname]);

  if (!me) return null;
  const navs = [
    ["/docs", "文档"],
    ["/chat", "AI 问答"],
    ["/search", "检索"],
    ["/secrets", "密钥区"],
    ["/audit", "审计"],
  ] as const;
  return (
    <header className="topbar">
      <div className="topbar-brand">🔐 秘枢</div>
      <nav className="topbar-nav">
        {navs.map(([to, label]) => (
          <Link
            key={to}
            to={to}
            className={loc.pathname.startsWith(to) ? "active" : ""}
          >
            {label}
          </Link>
        ))}
        {me.role === "admin" && (
          <Link
            to="/admin"
            className={loc.pathname.startsWith("/admin") ? "active" : ""}
          >
            管理台
          </Link>
        )}
      </nav>
      <div className="topbar-right">
        {vault ? (
          <Badge tone="ok">已解锁</Badge>
        ) : (
          <Badge tone="warn">密钥区锁定</Badge>
        )}
        <span className="muted">{me.display_name || me.username}</span>
        {unread > 0 && (
          <Link to="/audit" className="bell" title={`${unread} 条通知`}>
            🔔{unread}
          </Link>
        )}
        <button
          className="btn btn-ghost"
          onClick={async () => {
            if (vault) setVault(null);
            try {
              await api.post("/auth/logout");
            } catch {
              /* 已失效也无妨 */
            }
            useApp.getState().setMe(null);
            window.location.href = "/login";
          }}
        >
          退出
        </button>
      </div>
    </header>
  );
}

export default function App() {
  const { meLoaded, me, setMe } = useApp();
  const toasts = useToasts((s) => s.toasts);

  useEffect(() => {
    api
      .get<typeof me & { unlocked?: boolean }>("/auth/me")
      .then((m) => {
        setMe(m);
        if (!m.unlocked) useApp.getState().setVault(null);
      })
      .catch(() => setMe(null));
  }, [setMe]);

  return (
    <div className="app">
      <Header />
      <main className="main">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route
            path="/"
            element={
              meLoaded ? (
                <Navigate to={me ? "/docs" : "/login"} replace />
              ) : null
            }
          />
          <Route
            path="/docs"
            element={
              <RequireAuth>
                <DocsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/chat"
            element={
              <RequireAuth>
                <ChatPage />
              </RequireAuth>
            }
          />
          <Route
            path="/search"
            element={
              <RequireAuth>
                <SearchPage />
              </RequireAuth>
            }
          />
          <Route
            path="/secrets"
            element={
              <RequireAuth>
                <SecretsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAuth>
                <AdminPage />
              </RequireAuth>
            }
          />
          <Route
            path="/audit"
            element={
              <RequireAuth>
                <AuditPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <div className="toasts">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            onClick={() => useToasts.getState().remove(t.id)}
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
