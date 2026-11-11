/**
 * 密钥区（设计 M2/M3）：解锁门 → 条目列表 → 创建/查看/共享/轮换/删除/历史。
 * 所有加解密在浏览器完成；服务端只搬密文。
 * 创建条目时由客户端生成 UUID（AAD 需预先绑定 id），服务端原样落库。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import {
  buildRotationPlan,
  encryptContent,
  newDek,
  openSecret,
  sealDekForOrg,
  sealDekForUser,
  unlockVault,
  type SecretContent,
  type UnlockedVault,
} from "../crypto/flows";
import {
  AAD,
  b64d,
  b64e,
  eciesOpen,
  eciesSeal,
  fromUtf8,
  aeadOpen,
} from "../crypto/core";
import { toast, toastErr, useApp } from "../store";
import { Badge, Button, Empty, Field, Modal, Spinner } from "../components/ui";

interface SecretRow {
  id: string;
  name: string;
  project: string;
  env: string;
  tags: string[];
  version: number;
  owner_id: string;
  updated_at: string;
  is_owner: boolean;
}
interface ShareTarget {
  id: string;
  username: string;
  display_name: string;
  public_key: string;
}
interface Group {
  id: string;
  name: string;
  member_ids: string[];
}
interface Grant {
  user_id: string;
  username: string;
  display_name: string;
  wrapped_dek: string;
  created_at: string;
}
interface SecretFull extends SecretRow {
  my_wrapped_dek: string;
}
interface PendingRow {
  id: string;
  slug: string;
  kind: string;
  source_hint: string;
  doc_title: string | null;
}

const EMPTY_CONTENT: SecretContent = {
  username: "",
  password: "",
  url: "",
  tokens: "",
  notes: "",
};

function newSecretId(): string {
  return crypto.randomUUID();
}

export default function SecretsPage() {
  const { me, vault, setVault } = useApp();
  const [rows, setRows] = useState<SecretRow[] | null>(null);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [group, setGroup] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!vault) return;
    api
      .get<{ pending: PendingRow[] }>("/documents/pending")
      .then((p) => setPending(p.pending))
      .catch(() => {});
  }, [vault]);

  if (!me) return null;
  if (!vault) return <UnlockGate onUnlocked={setVault} />;

  const filtered = (rows ?? []).filter(
    (r) =>
      (!group || r.project === group) &&
      (!q || r.name.toLowerCase().includes(q.toLowerCase())),
  );

  return (
    <div>
      <div className="page-head">
        <h2>密钥区</h2>
        <Button
          onClick={() => {
            setVault(null);
            void api.post("/secrets/lock");
          }}
        >
          锁定密钥区
        </Button>
      </div>

      <div className="secret-hint">
        已解锁：加密密钥只在本页内存中，刷新页面即重新锁定。
        服务端可见名称/项目/标签，看不到任何内容（零知识）。
      </div>

      <SecretList
        vault={vault}
        rows={rows}
        setRows={setRows}
        filtered={filtered}
        group={group}
        setGroup={setGroup}
        q={q}
        setQ={setQ}
        me={me}
        pending={pending}
        onPendingChange={setPending}
      />
    </div>
  );
}

/* ================= 解锁门 ================= */

function UnlockGate({
  onUnlocked,
}: {
  onUnlocked: (v: UnlockedVault) => void;
}) {
  const { me } = useApp();
  const [mp, setMp] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!me) return null;

  const unlock = async () => {
    if (!mp) {
      setErr("请输入主密码");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const v = await unlockVault(mp, {
        user_id: me.user_id,
        salt_enc: me.salt_enc!,
        local_check_ct: me.local_check_ct!,
        priv_wrapped: me.priv_wrapped!,
      });
      await api.post("/secrets/unlock"); // 服务端会话标志（UX 强制 + 审计）
      onUnlocked(v);
      setMp("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "解锁失败：主密码不正确？");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <h2 className="auth-title">🔐 解锁密钥区</h2>
        <p className="auth-sub">
          查看密钥需要再次输入主密码（本地解密校验，服务端不参与、也无能力参与）
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
          }}
        >
          <Field label="主密码">
            <input
              type="password"
              value={mp}
              onChange={(e) => setMp(e.target.value)}
            />
          </Field>
          {err && (
            <div className="blocked-banner" style={{ marginBottom: 10 }}>
              {err}
            </div>
          )}
          <Button kind="primary" disabled={busy} onClick={() => void unlock()}>
            {busy ? "Argon2id 派生中（约 1 秒）…" : "解锁"}
          </Button>
        </form>
      </div>
    </div>
  );
}

/* ================= 列表 ================= */

function SecretList(props: {
  vault: UnlockedVault;
  rows: SecretRow[] | null;
  setRows: (r: SecretRow[]) => void;
  filtered: SecretRow[];
  group: string;
  setGroup: (g: string) => void;
  q: string;
  setQ: (q: string) => void;
  me: { user_id: string; role: string };
  pending: PendingRow[];
  onPendingChange: (p: PendingRow[]) => void;
}) {
  const {
    vault,
    rows,
    setRows,
    filtered,
    group,
    setGroup,
    q,
    setQ,
    me,
    pending,
    onPendingChange,
  } = props;
  const [creating, setCreating] = useState<PendingRow | null>(null);
  const [viewing, setViewing] = useState<SecretFull | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ secrets: SecretRow[] }>("/secrets");
      setRows(r.secrets);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "加载失败");
    }
  }, [setRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const projects = useMemo(
    () => [...new Set((rows ?? []).map((r) => r.project).filter(Boolean))],
    [rows],
  );

  let body = <Spinner />;
  if (rows !== null) {
    if (filtered.length === 0) {
      body = <Empty text="还没有条目" />;
    } else {
      body = (
        <table className="grid">
          <thead>
            <tr>
              <th>名称</th>
              <th>项目</th>
              <th>环境</th>
              <th>标签</th>
              <th>版本</th>
              <th>更新时间</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id}>
                <td>
                  <b>{r.name}</b>{" "}
                  {r.is_owner && <Badge tone="info">拥有</Badge>}
                </td>
                <td>{r.project || "—"}</td>
                <td>
                  {r.env ? (
                    <Badge tone={r.env === "prod" ? "err" : "info"}>
                      {r.env}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{(r.tags ?? []).join("、") || "—"}</td>
                <td>v{r.version}</td>
                <td className="muted">
                  {new Date(r.updated_at).toLocaleString()}
                </td>
                <td>
                  <Button
                    onClick={async () => {
                      const full = await api.get<SecretFull>(
                        `/secrets/${r.id}`,
                      );
                      setViewing(full);
                    }}
                  >
                    查看
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
  }

  return (
    <div className="card">
      <div className="toolbar">
        <input
          type="text"
          placeholder="按名称搜索（服务端搜不了内容）"
          value={q}
          style={{ width: 280 }}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          style={{ width: 140 }}
        >
          <option value="">全部项目</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <Button onClick={() => void refresh()}>刷新</Button>
        <span style={{ flex: 1 }} />
        <Button kind="primary" onClick={() => setCreating(null)}>
          ＋ 新建条目
        </Button>
      </div>

      {body}

      {pending.length > 0 && (
        <div
          style={{
            marginTop: 16,
            borderTop: "1px solid var(--line)",
            paddingTop: 12,
          }}
        >
          <h4 style={{ margin: "0 0 8px" }}>
            待认领占位符（上传预扫产生；真实值只在当时的浏览器里）
          </h4>
          <table className="grid">
            <thead>
              <tr>
                <th>占位符</th>
                <th>类别</th>
                <th>来源</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.map((p) => (
                <tr key={p.id}>
                  <td>
                    <code>{`{{secret:${p.slug}}}`}</code>
                  </td>
                  <td>
                    <Badge tone="warn">{p.kind}</Badge>
                  </td>
                  <td>{p.doc_title ?? p.source_hint}</td>
                  <td>
                    <Button
                      title="创建条目后把占位符归属到它"
                      onClick={() => setCreating(p)}
                    >
                      新建并认领
                    </Button>
                    <Button
                      kind="ghost"
                      onClick={async () => {
                        await api.post(`/secrets/pending/${p.id}/dismiss`);
                        onPendingChange(pending.filter((x) => x.id !== p.id));
                      }}
                    >
                      忽略
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating !== null && (
        <CreateModal
          myUserId={me.user_id}
          pendingRow={creating}
          onClose={() => setCreating(null)}
          onDone={(sid) => {
            setCreating(null);
            void refresh();
            const target = pending[0];
            if (target && sid) {
              void api.post(`/secrets/pending/${target.id}/claim`, {
                secret_id: sid,
              });
              onPendingChange(pending.filter((x) => x.id !== target.id));
            }
          }}
        />
      )}
      {viewing && (
        <ViewModal
          vault={vault}
          row={viewing}
          myUserId={me.user_id}
          onClose={() => setViewing(null)}
          onChanged={() => {
            setViewing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/* ================= 创建 ================= */

function CreateModal({
  myUserId,
  pendingRow,
  onClose,
  onDone,
}: {
  myUserId: string;
  pendingRow: PendingRow | null; // 从待认领进入时非空
  onClose: () => void;
  onDone: (secretId: string) => void;
}) {
  const { me } = useApp();
  const [name, setName] = useState(
    pendingRow ? `凭据（${pendingRow.slug.slice(0, 6)}…）` : "",
  );
  const [project, setProject] = useState("");
  const [env, setEnv] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState<SecretContent>({ ...EMPTY_CONTENT });
  const [busy, setBusy] = useState(false);
  const [orgPub, setOrgPub] = useState("");

  useEffect(() => {
    api
      .get<{ org_pubkey: string }>("/admin/recovery/status")
      .then((r) => setOrgPub(r.org_pubkey ?? ""))
      .catch(() => setOrgPub(""));
  }, []);

  const create = async () => {
    if (!name.trim()) {
      toastErr("请填写名称");
      return;
    }
    if (!me?.public_key || !orgPub) {
      toastErr("缺少自己的公钥或组织公钥");
      return;
    }
    setBusy(true);
    try {
      // 客户端生成 id → 所有密文（内容/owner 包装/组织包装）预先绑定该 id
      const sid = newSecretId();
      const dek = newDek();
      await api.post<{ id: string }>("/secrets", {
        id: sid,
        name,
        project,
        env,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        content_ct: encryptContent(dek, content, sid),
        dek_wrapped_org: sealDekForOrg(orgPub, dek, sid),
        grants: [
          {
            user_id: myUserId,
            wrapped_dek: sealDekForUser(me.public_key, dek, sid, myUserId),
          },
        ],
      });
      toast("已创建（内容仅存密文）");
      onDone(sid);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="新建密钥条目" onClose={onClose}>
      <div className="secret-hint">
        内容在本页用随机 DEK 加密后上传；DEK 分别用你的公钥与组织公钥包装。
        服务端只见名称/项目/环境/标签（明文）。
        {pendingRow && (
          <>
            {" "}
            认领占位符：<code>{`{{secret:${pendingRow.slug}}}`}</code>
            （真实凭据值请凭记忆填入下方，与文档被替换处对应）
          </>
        )}
      </div>
      <Field label="名称 *">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Redis 生产密码"
        />
      </Field>
      <div className="row">
        <Field label="项目">
          <input
            type="text"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
        </Field>
        <Field label="环境">
          <select value={env} onChange={(e) => setEnv(e.target.value)}>
            <option value="">未指定</option>
            <option value="prod">prod</option>
            <option value="staging">staging</option>
            <option value="dev">dev</option>
          </select>
        </Field>
      </div>
      <Field label="标签（逗号分隔）">
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </Field>
      <div className="row">
        <Field label="用户名">
          <input
            type="text"
            value={content.username}
            onChange={(e) =>
              setContent({ ...content, username: e.target.value })
            }
          />
        </Field>
        <Field label="密码">
          <input
            type="text"
            value={content.password}
            onChange={(e) =>
              setContent({ ...content, password: e.target.value })
            }
          />
        </Field>
      </div>
      <Field label="URL / 地址">
        <input
          type="text"
          value={content.url}
          onChange={(e) => setContent({ ...content, url: e.target.value })}
        />
      </Field>
      <Field label="令牌 / 其他">
        <input
          type="text"
          value={content.tokens}
          onChange={(e) => setContent({ ...content, tokens: e.target.value })}
        />
      </Field>
      <Field label="备注">
        <textarea
          value={content.notes}
          onChange={(e) => setContent({ ...content, notes: e.target.value })}
        />
      </Field>
      <Button kind="primary" disabled={busy} onClick={() => void create()}>
        {busy ? "加密上传中…" : "加密并创建"}
      </Button>
    </Modal>
  );
}

/* ================= 查看 / 共享 / 轮换 / 删除 ================= */

function ViewModal({
  vault,
  row,
  myUserId,
  onClose,
  onChanged,
}: {
  vault: UnlockedVault;
  row: SecretFull;
  myUserId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [content, setContent] = useState<SecretContent | null>(null);
  const [contentCt, setContentCt] = useState("");
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [targets, setTargets] = useState<{
    users: ShareTarget[];
    groups: Group[];
  } | null>(null);
  const [err, setErr] = useState("");
  const isOwner = row.is_owner;

  const reveal = useCallback(async () => {
    try {
      const r = await api.get<{
        content_ct: string;
        wrapped_dek: string;
        version: number;
      }>(`/secrets/${row.id}/reveal`);
      setContentCt(r.content_ct);
      setContent(
        openSecret(vault, r.wrapped_dek, r.content_ct, row.id, myUserId),
      );
      if (isOwner) {
        const g = await api.get<{ grants: Grant[] }>(
          `/secrets/${row.id}/grants`,
        );
        setGrants(g.grants);
        const t = await api.get<{ users: ShareTarget[]; groups: Group[] }>(
          "/secrets/share-targets",
        );
        setTargets(t);
      }
    } catch (e) {
      setErr(
        e instanceof Error
          ? e.message
          : "取回失败（限流 20 次/分钟，或未解锁）",
      );
    }
  }, [vault, row, myUserId, isOwner]);

  useEffect(() => {
    void reveal();
  }, [reveal]);

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    toast(`${label} 已复制`);
  };

  const myDek = (): Uint8Array =>
    eciesOpen(
      vault.priv,
      b64d(row.my_wrapped_dek),
      `${AAD.dek}${row.id}:${myUserId}`,
    );

  const shareTo = async (target: ShareTarget) => {
    const dek = myDek();
    const wrapped = b64e(
      eciesSeal(
        b64d(target.public_key),
        dek,
        `${AAD.dek}${row.id}:${target.id}`,
      ),
    );
    await api.post(`/secrets/${row.id}/grants`, {
      user_id: target.id,
      wrapped_dek: wrapped,
    });
    toast(
      `已共享给 ${target.display_name || target.username}（撤销不回收已看内容，敏感条目请轮换）`,
    );
    const g = await api.get<{ grants: Grant[] }>(`/secrets/${row.id}/grants`);
    setGrants(g.grants);
  };

  const revoke = async (uid: string) => {
    if (
      !window.confirm(
        "撤销后对方已看过的内容收不回来；敏感条目建议同时轮换真实密码。确定撤销？",
      )
    )
      return;
    await api.delete(`/secrets/${row.id}/grants/${uid}`);
    toast("已撤销授权");
    const g = await api.get<{ grants: Grant[] }>(`/secrets/${row.id}/grants`);
    setGrants(g.grants);
  };

  const rotate = async (newContent: SecretContent) => {
    if (!grants || !targets) return;
    const pubkeyMap: Record<string, string> = {};
    for (const u of targets.users) pubkeyMap[u.id] = u.public_key;
    const orgStatus = await api.get<{ org_pubkey: string }>(
      "/admin/recovery/status",
    );
    const plan = buildRotationPlan({
      secretId: row.id,
      myUserId,
      content: newContent,
      orgPubB64: orgStatus.org_pubkey,
      pubkeyMap,
      grants,
      oldContentCt: contentCt,
    });
    await api.put(`/secrets/${row.id}/rotate`, {
      content_ct: plan.contentCt,
      dek_wrapped_org: plan.dekWrappedOrg,
      wrapped_deks: plan.wrappedDeks,
      old_content_ct: plan.oldContentCt,
      old_wrapped_deks: plan.oldWrappedDeks,
    });
    toast(`已轮换到 v${row.version + 1}；旧版本已归档`);
    onChanged();
  };

  const remove = async () => {
    if (!window.confirm(`删除条目《${row.name}》？历史版本一并删除。`)) return;
    await api.delete(`/secrets/${row.id}`);
    toast("已删除");
    onChanged();
  };

  const shareUsers = (targets?.users ?? []).filter(
    (u) => u.id !== myUserId && !(grants ?? []).some((g) => g.user_id === u.id),
  );

  let contentBody = <Spinner text="取回密文并本地解密…" />;
  if (content !== null) {
    contentBody = (
      <div className="kv-list">
        {content.username && (
          <>
            <span className="k">用户名</span>
            <span>
              {content.username}{" "}
              <Button
                kind="ghost"
                onClick={() => void copy(content.username!, "用户名")}
              >
                复制
              </Button>
            </span>
          </>
        )}
        {content.password && (
          <>
            <span className="k">密码</span>
            <span className="reveal-box">
              {content.password}{" "}
              <Button
                kind="ghost"
                onClick={() => void copy(content.password!, "密码")}
              >
                复制
              </Button>
            </span>
          </>
        )}
        {content.url && (
          <>
            <span className="k">地址</span>
            <span>{content.url}</span>
          </>
        )}
        {content.tokens && (
          <>
            <span className="k">令牌</span>
            <span className="reveal-box">
              {content.tokens}{" "}
              <Button
                kind="ghost"
                onClick={() => void copy(content.tokens!, "令牌")}
              >
                复制
              </Button>
            </span>
          </>
        )}
        {content.notes && (
          <>
            <span className="k">备注</span>
            <span style={{ whiteSpace: "pre-wrap" }}>{content.notes}</span>
          </>
        )}
      </div>
    );
  }

  return (
    <Modal title={row.name} wide onClose={onClose}>
      {err && (
        <div className="blocked-banner" style={{ marginBottom: 10 }}>
          {err}
        </div>
      )}
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <Badge tone="info">v{row.version}</Badge>
        {row.env && (
          <Badge tone={row.env === "prod" ? "err" : "info"}>{row.env}</Badge>
        )}
        {row.project && <Badge>{row.project}</Badge>}
        {(row.tags ?? []).map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
        <span style={{ flex: 1 }} />
        <Button onClick={() => void copy(JSON.stringify(content), "条目 JSON")}>
          复制 JSON
        </Button>
      </div>

      {contentBody}

      {isOwner && grants && (
        <div
          style={{
            marginTop: 18,
            borderTop: "1px solid var(--line)",
            paddingTop: 12,
          }}
        >
          <h4 style={{ margin: "0 0 8px" }}>
            共享（{grants.length} 人有权访问）
          </h4>
          <table className="grid">
            <tbody>
              {grants.map((g) => (
                <tr key={g.user_id}>
                  <td>
                    {g.display_name || g.username}
                    {g.user_id === myUserId ? "（我）" : ""}
                  </td>
                  <td className="muted">
                    {new Date(g.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    {g.user_id !== myUserId && (
                      <Button
                        kind="danger"
                        onClick={() => void revoke(g.user_id)}
                      >
                        撤销
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shareUsers.length > 0 && (
            <div className="toolbar" style={{ marginTop: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                共享给：
              </span>
              {shareUsers.map((u) => (
                <Button key={u.id} onClick={() => void shareTo(u)}>
                  {u.display_name || u.username}
                </Button>
              ))}
              {(targets?.groups ?? []).map((gr) => (
                <Button
                  key={gr.id}
                  title={`组成员 ${gr.member_ids.length} 人`}
                  onClick={async () => {
                    // 组共享：模型不变，授权展开到个人（设计 8.1）
                    if (!targets) return;
                    for (const uid of gr.member_ids) {
                      if (
                        uid === myUserId ||
                        (grants ?? []).some((g) => g.user_id === uid)
                      )
                        continue;
                      const pub = targets.users.find((u) => u.id === uid);
                      if (!pub) continue;
                      const wrapped = b64e(
                        eciesSeal(
                          b64d(pub.public_key),
                          myDek(),
                          `${AAD.dek}${row.id}:${uid}`,
                        ),
                      );
                      await api.post(`/secrets/${row.id}/grants`, {
                        user_id: uid,
                        wrapped_dek: wrapped,
                      });
                    }
                    toast(`已按组成员展开授权：${gr.name}`);
                    const g2 = await api.get<{ grants: Grant[] }>(
                      `/secrets/${row.id}/grants`,
                    );
                    setGrants(g2.grants);
                  }}
                >
                  👥 {gr.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {isOwner && (
        <div
          className="toolbar"
          style={{
            marginTop: 16,
            borderTop: "1px solid var(--line)",
            paddingTop: 12,
          }}
        >
          <Button onClick={() => void showVersions()}>查看历史版本</Button>
          <Button onClick={() => void editAndRotate(content)}>
            轮换（改内容 + 换新 DEK）
          </Button>
          <span style={{ flex: 1 }} />
          <Button kind="danger" onClick={() => void remove()}>
            删除条目
          </Button>
        </div>
      )}
      {!isOwner && (
        <div className="secret-hint" style={{ marginTop: 14 }}>
          你是被共享方：可查看与复制；轮换/共享管理由条目所有者操作。
        </div>
      )}
    </Modal>
  );

  async function showVersions() {
    const r = await api.get<{
      versions: Array<{
        version: number;
        content_ct: string;
        wrapped_deks: Record<string, string>;
        created_at: string;
      }>;
    }>(`/secrets/${row.id}/versions`);
    const lines = await Promise.all(
      r.versions.map(async (v) => {
        const mine = v.wrapped_deks[myUserId];
        let decoded = "（无法解密：该版本创建时你没有授权）";
        if (mine) {
          try {
            const dek = eciesOpen(
              vault.priv,
              b64d(mine),
              `${AAD.dek}${row.id}:${myUserId}`,
            );
            decoded = fromUtf8(
              aeadOpen(dek, b64d(v.content_ct), `${AAD.entry}${row.id}`),
            );
          } catch {
            decoded = "（解密失败）";
          }
        }
        return `v${v.version} · ${new Date(v.created_at).toLocaleString()}\n${decoded}`;
      }),
    );
    window.alert(lines.join("\n\n———\n\n") || "没有历史版本");
  }

  async function editAndRotate(current: SecretContent | null) {
    if (!current) {
      toastErr("先完成解密");
      return;
    }
    const password = window.prompt(
      "新密码（轮换后请同步修改源头系统）",
      current.password ?? "",
    );
    if (password === null) return;
    await rotate({ ...current, password });
  }
}
