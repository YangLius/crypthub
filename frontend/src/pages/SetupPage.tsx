/** 开号完成页：生成密钥材料、展示一次性恢复码、（首管理员）初始化组织恢复。 */
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { buildSetupMaterial } from "../crypto/flows";
import { useApp, type Me } from "../store";
import { Button, Field, SecretHint, Spinner } from "../components/ui";

interface SetupInfo {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  needs_org: boolean;
}

function download(filename: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function SetupPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { setMe } = useApp();
  const token = params.get("token") ?? "";

  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [infoErr, setInfoErr] = useState("");
  const [mp, setMp] = useState("");
  const [mp2, setMp2] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{
    recoveryCode: string;
    offlineCode?: string;
    offlinePkg?: string;
  } | null>(null);

  useEffect(() => {
    if (!token) {
      setInfoErr("缺少开号令牌");
      return;
    }
    api
      .get<SetupInfo>(`/auth/setup-info?token=${encodeURIComponent(token)}`)
      .then((i) => {
        setInfo(i);
        setDisplayName(i.display_name);
      })
      .catch((e) => setInfoErr(e instanceof Error ? e.message : "令牌无效"));
  }, [token]);

  const submit = async () => {
    setErr("");
    if (!info) return;
    if (mp.length < 10) {
      setErr("主密码至少 10 位");
      return;
    }
    if (mp !== mp2) {
      setErr("两次输入的主密码不一致");
      return;
    }
    setBusy(true);
    try {
      const mat = await buildSetupMaterial(mp, info.user_id, info.needs_org);
      await api.post("/auth/setup", {
        token,
        display_name: displayName,
        salt_auth: mat.saltAuthB64,
        salt_enc: mat.saltEncB64,
        auth_verifier: mat.authVerifierHex,
        local_check_ct: mat.localCheckCtB64,
        public_key: mat.publicKeyB64,
        priv_wrapped: mat.privWrappedB64,
        rk_salt: mat.rkSaltB64,
        priv_rk_wrapped: mat.privRkWrappedB64,
        org_public_key: mat.org?.publicKeyB64 ?? null,
        org_offline_salt: mat.org?.offlineSaltHex ?? null,
        org_priv_offline_wrapped: mat.org?.orgPrivOfflineWrappedB64 ?? null,
        org_delegate_sealed: mat.org?.delegateSealedB64 ?? null,
      });
      let pkg: string | undefined;
      if (mat.org) {
        // 首管理员：立即导出离线恢复包（与 /admin/recovery/offline-package 格式一致）
        pkg = JSON.stringify(
          {
            version: 1,
            kdf: { algo: "argon2id", m_kb: 65536, t: 3, p: 1, out_len: 32 },
            org_public_key: mat.org.publicKeyB64,
            offline_salt_b64: mat.org.offlineSaltHex,
            org_priv_offline_wrapped_b64: mat.org.orgPrivOfflineWrappedB64,
            aad: "kb:org-offline",
            instructions: [
              "1. 本文件含被离线恢复码加密的组织私钥；离线恢复码另行抄写在纸上，两者分开保管。",
              "2. 灾难恢复：恢复 pg_dump 备份到隔离环境，运行 backend/scripts/offline_recover.py。",
              "3. 用完即删；离线恢复码按规范定期轮换。",
            ],
          },
          null,
          2,
        );
        download(`org-recovery-package-${info.username}.json`, pkg);
      }
      setDone({
        recoveryCode: mat.recoveryCode,
        offlineCode: mat.org?.offlineCode,
        offlinePkg: pkg,
      });
      const me = await api.get<Me>("/auth/me");
      setMe(me);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "设置失败");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card" style={{ width: 560 }}>
          <h2 className="auth-title">✅ 账号已就绪</h2>
          <SecretHint>
            下面两个恢复码<b>只显示这一次</b>，关闭页面后无法再查看。
            请立即抄写在纸上并存放到安全位置（不要存电脑里）。
          </SecretHint>
          <Field label="个人恢复码（忘记主密码时用它找回自己的密钥）">
            <div className="code-block recovery-codes">{done.recoveryCode}</div>
          </Field>
          {done.offlineCode && (
            <Field label="组织离线恢复码（管理员：全库破窗恢复的最后手段）">
              <div className="code-block recovery-codes">
                {done.offlineCode}
              </div>
            </Field>
          )}
          {done.offlinePkg && (
            <Field
              label="离线恢复包"
              hint="已自动下载 JSON 文件，请打印并与恢复码分开保管"
            >
              <Button
                onClick={() =>
                  download("org-recovery-package.json", done.offlinePkg!)
                }
              >
                重新下载
              </Button>
            </Field>
          )}
          <Button kind="primary" onClick={() => nav("/docs")}>
            进入系统
          </Button>
        </div>
      </div>
    );
  }

  if (infoErr) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card">
          <SecretHint>{infoErr}</SecretHint>
          <Button onClick={() => nav("/login")}>返回登录</Button>
        </div>
      </div>
    );
  }
  if (!info) return <Spinner text="校验开号令牌…" />;

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <h2 className="auth-title">完成账号设置</h2>
        <p className="auth-sub">
          {info.username} · {info.role === "admin" ? "管理员" : "成员"}
          {info.needs_org && " · 首管理员（将同时初始化组织恢复密钥）"}
        </p>
        <Field label="显示名">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field
          label="主密码"
          hint="至少 10 位。用于派生登录证明密钥与数据加密密钥；服务端永远看不到它"
        >
          <input
            type="password"
            value={mp}
            onChange={(e) => setMp(e.target.value)}
          />
        </Field>
        <Field label="确认主密码">
          <input
            type="password"
            value={mp2}
            onChange={(e) => setMp2(e.target.value)}
          />
        </Field>
        {err && <SecretHint>{err}</SecretHint>}
        <Button kind="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "生成密钥中（Argon2id 需数秒）…" : "生成密钥并完成设置"}
        </Button>
      </div>
    </div>
  );
}
