/** 登录页：挑战-应答（客户端派生 authProofKey，服务端只见校验值）。 */
import { useState } from "react";
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

  return (
    <div className="auth-wrap">
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
              autoFocus
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
