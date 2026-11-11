/** 登录页：挑战-应答（客户端派生 authProofKey，服务端只见校验值）。
 *  系统未初始化时（无任何用户）展示"首次使用"引导：建管理员账号 → /setup。 */
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { loginProof } from "../crypto/flows";
import { b64d, hmacHex, unhex } from "../crypto/core";
import { useApp } from "../store";
import { Button, Field, SecretHint } from "../components/ui";

export default function LoginPage() {
  const nav = useNavigate();
  const { me, setMe } = useApp();
  const [username, setUsername] = useState("");
  const [mp, setMp] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null);
  const [adminName, setAdminName] = useState("admin");
  const [adminDisplayName, setAdminDisplayName] = useState("管理员");
  const [bootBusy, setBootBusy] = useState(false);
  const [bootErr, setBootErr] = useState("");

  useEffect(() => {
    api
      .get<{ needs_bootstrap: boolean }>("/auth/bootstrap-status")
      .then((r) => setNeedsBootstrap(r.needs_bootstrap))
      .catch(() => setNeedsBootstrap(false)); // 探测失败按已初始化处理
  }, []);

  if (me) return <Navigate to="/docs" replace />;

  const submit = async () => {
    setErr("");
    if (!username || !mp) {
      setErr("请输入用户名与主密码");
      return;
    }
    setBusy(true);
    try {
      const ch = await api.post<{
        challenge_id: string;
        challenge: string;
        salt_auth: string;
      }>("/auth/challenge", { username });
      const proofKey = await loginProof(mp, b64d(ch.salt_auth));
      const proof = hmacHex(unhex(proofKey), ch.challenge);
      const u = await api.post<{ user_id: string; role: string }>(
        "/auth/login",
        { challenge_id: ch.challenge_id, proof },
      );
      setMe(await api.get("/auth/me"));
      void u;
      nav("/docs");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  const bootstrap = async () => {
    setBootErr("");
    if (!adminName) {
      setBootErr("请输入管理员用户名");
      return;
    }
    setBootBusy(true);
    try {
      const r = await api.post<{ setup_token: string }>(
        "/auth/bootstrap-init",
        {
          username: adminName,
          display_name: adminDisplayName || adminName,
        },
      );
      nav(`/setup?token=${encodeURIComponent(r.setup_token)}`);
    } catch (e) {
      setBootErr(e instanceof Error ? e.message : "初始化失败");
      setBootBusy(false);
    }
  };

  if (needsBootstrap === null) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card">
          <p className="auth-sub">正在连接服务…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      {needsBootstrap && (
        <div className="card auth-card">
          <h2 className="auth-title">🚀 系统尚未初始化</h2>
          <p className="auth-sub">
            这是首次使用：创建第一个管理员账号并设置主密码，
            系统将同时生成组织恢复密钥。
          </p>
          <Field label="管理员用户名">
            <input
              type="text"
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              placeholder="admin"
            />
          </Field>
          <Field label="显示名">
            <input
              type="text"
              value={adminDisplayName}
              onChange={(e) => setAdminDisplayName(e.target.value)}
            />
          </Field>
          {bootErr && <SecretHint>{bootErr}</SecretHint>}
          <Button
            kind="primary"
            disabled={bootBusy}
            onClick={() => void bootstrap()}
          >
            {bootBusy ? "创建中…" : "初始化系统（进入主密码设置）"}
          </Button>
          <p className="auth-sub" style={{ marginTop: 8 }}>
            系统已有账号？下方登录即可。
          </p>
        </div>
      )}
      <div className="card auth-card">
        <h2 className="auth-title">📚 知识库 · 密钥管理</h2>
        <p className="auth-sub">公司内部系统 · 零知识架构：主密码不离开本机</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="用户名">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
            />
          </Field>
          <Field
            label="主密码"
            hint="登录（验证身份）与解锁密钥区（读取数据）是两个独立动作"
          >
            <input
              type="password"
              value={mp}
              onChange={(e) => setMp(e.target.value)}
              placeholder="主密码"
            />
          </Field>
          {err && <SecretHint>{err}</SecretHint>}
          <Button
            type="submit"
            kind="primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "派生密钥中（约 1 秒）…" : "登录"}
          </Button>
        </form>
      </div>
    </div>
  );
}
