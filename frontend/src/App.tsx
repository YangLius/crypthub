import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { TopNav, TopNavItem } from "@astryxdesign/core/TopNav";
import { api } from "./api/client";
import { useApp, useToasts } from "./store";
import { Badge, Button } from "./components/ui";
import { RouterLink } from "./router-link";
import LoginPage from "./pages/LoginPage";
import SetupPage from "./pages/SetupPage";
import DocsPage from "./pages/DocsPage";
import ChatPage from "./pages/ChatPage";
import SearchPage from "./pages/SearchPage";
import GitHubPage from "./pages/GitHubPage";
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
    ["/secrets", "密钥区"],
    ["/chat", "AI 问答"],
    ["/search", "检索"],
    ["/github", "GitHub"],
    ["/audit", "审计"],
  ] as const;
  return (
    <TopNav
      label="秘枢主导航"
      heading={<span className="brand">🔐 秘枢</span>}
      startContent={
        <>
          {navs.map(([to, label]) => (
            <TopNavItem
              key={to}
              as={RouterLink}
              href={to}
              label={label}
              isSelected={loc.pathname.startsWith(to)}
            />
          ))}
          {me.role === "admin" && (
            <TopNavItem
              as={RouterLink}
              href="/admin"
              label="管理台"
              isSelected={loc.pathname.startsWith("/admin")}
            />
          )}
        </>
      }
      endContent={
        <>
          {vault ? (
            <Badge tone="ok">已解锁</Badge>
          ) : (
            <Badge tone="warn">密钥区锁定</Badge>
          )}
          <span className="muted">{me.display_name || me.username}</span>
          {unread > 0 && (
            <TopNavItem as={RouterLink} href="/audit" label={`🔔${unread}`} />
          )}
          <Button
            kind="ghost"
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
          </Button>
        </>
      }
    />
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
            path="/github"
            element={
              <RequireAuth>
                <GitHubPage />
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
