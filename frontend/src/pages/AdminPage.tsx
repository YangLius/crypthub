/** 管理台：用户管理、组管理、组织恢复 / 离职交接控制台、离线恢复包导出。 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import {
  openOrgDelegate,
  openOrgWrappedDek,
  sealDekForUser,
  type SecretContent,
} from "../crypto/flows";
import { toast, toastErr, useApp } from "../store";
import {
  Badge,
  Button,
  ConfirmModal,
  Empty,
  Field,
  Modal,
  PromptModal,
  Spinner,
} from "../components/ui";

interface User {
  id: string;
  username: string;
  display_name: string;
  role: string;
  status: string;
  has_keys: boolean;
  created_at: string;
}
interface Group {
  id: string;
  name: string;
  members: { id: string; username: string }[];
}
interface RecoveryEntry {
  id: string;
  name: string;
  project: string;
  env: string;
  version: number;
  owner_id: string;
  content_ct: string;
  dek_wrapped_org: string;
  is_owner: boolean;
  grantees: { user_id: string; username: string }[];
}

type Tab = "users" | "groups" | "recovery";

export default function AdminPage() {
  const { me } = useApp();
  const [tab, setTab] = useState<Tab>("users");
  if (!me || me.role !== "admin") {
    return <div className="blocked-banner">需要管理员权限</div>;
  }
  return (
    <div>
      <div className="page-head">
        <h2>管理台</h2>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          {(["users", "groups", "recovery"] as Tab[]).map((t) => (
            <Button
              key={t}
              kind={tab === t ? "primary" : "default"}
              onClick={() => setTab(t)}
            >
              {
                {
                  users: "用户与开号",
                  groups: "组",
                  recovery: "组织恢复 / 交接",
                }[t]
              }
            </Button>
          ))}
        </div>
      </div>
      {tab === "users" && <UsersPanel />}
      {tab === "groups" && <GroupsPanel />}
      {tab === "recovery" && <RecoveryPanel />}
    </div>
  );
}

/* ================= 用户 ================= */

function UsersPanel() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [created, setCreated] = useState<{
    username: string;
    setup_url: string;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [cuName, setCuName] = useState("");
  const [cuDisplay, setCuDisplay] = useState("");
  const [cuRole, setCuRole] = useState("member");
  const [confirming, setConfirming] = useState<null | {
    title: string;
    message: string;
    danger?: boolean;
    action: () => Promise<void>;
  }>(null);

  const refresh = useCallback(async () => {
    const r = await api.get<{ users: User[] }>("/admin/users");
    setUsers(r.users);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    if (!cuName.trim()) return;
    try {
      const r = await api.post<{ user: User; setup_url: string }>(
        "/admin/users",
        { username: cuName.trim(), display_name: cuDisplay, role: cuRole },
      );
      setCreated({ username: cuName.trim(), setup_url: r.setup_url });
      setCreating(false);
      setCuName("");
      setCuDisplay("");
      setCuRole("member");
      await refresh();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "创建失败");
    }
  };

  return (
    <div className="card">
      <div className="toolbar">
        <Button
          kind="primary"
          onClick={() => {
            setCuName("");
            setCuDisplay("");
            setCuRole("member");
            setCreating(true);
          }}
        >
          开新账号
        </Button>
        <span className="muted" style={{ fontSize: 12 }}>
          开号后把设置链接单独发给对方；主密码由本人设置，管理员无法代设。
        </span>
      </div>
      {creating && (
        <Modal title="开新账号" onClose={() => setCreating(false)}>
          <div className="secret-hint">
            创建后生成一次性设置链接（7 天有效），请把链接单独发给对方；
            主密码由本人打开链接后自行设置，管理员无法代设（零知识）。
          </div>
          <Field label="用户名 *（字母数字._-）">
            <input
              value={cuName}
              onChange={(e) => setCuName(e.target.value)}
              placeholder="zhang.san"
            />
          </Field>
          <Field label="显示名">
            <input
              value={cuDisplay}
              onChange={(e) => setCuDisplay(e.target.value)}
              placeholder="张三"
            />
          </Field>
          <Field label="角色">
            <select value={cuRole} onChange={(e) => setCuRole(e.target.value)}>
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
          </Field>
          <Button
            kind="primary"
            disabled={!cuName.trim()}
            onClick={() => void create()}
          >
            创建并生成设置链接
          </Button>
        </Modal>
      )}
      {confirming && (
        <ConfirmModal
          title={confirming.title}
          message={confirming.message}
          danger={confirming.danger}
          onOk={() => void confirming.action()}
          onClose={() => setConfirming(null)}
        />
      )}
      {created && (
        <div className="secret-hint">
          {created.username} 的设置链接（一次性，7 天有效）：
          <br />
          <code>
            {window.location.origin}
            {created.setup_url}
          </code>
          <Button
            kind="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(
                window.location.origin + created.setup_url,
              );
              toast("已复制");
            }}
          >
            复制
          </Button>
        </div>
      )}
      {users === null ? (
        <Spinner />
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>用户名</th>
              <th>显示名</th>
              <th>角色</th>
              <th>状态</th>
              <th>密钥</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.username}</b>
                </td>
                <td>{u.display_name}</td>
                <td>
                  <Badge tone={u.role === "admin" ? "warn" : "info"}>
                    {u.role === "admin" ? "管理员" : "成员"}
                  </Badge>
                </td>
                <td>
                  <Badge
                    tone={
                      u.status === "active"
                        ? "ok"
                        : u.status === "pending"
                          ? "warn"
                          : "err"
                    }
                  >
                    {u.status === "active"
                      ? "启用"
                      : u.status === "pending"
                        ? "待完成设置"
                        : "已停用"}
                  </Badge>
                </td>
                <td>{u.has_keys ? "✓" : "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {u.status === "active" ? (
                    <Button
                      kind="danger"
                      onClick={() =>
                        setConfirming({
                          title: "停用用户",
                          message: `停用 ${u.username}？其会话立即失效，数据保留（审计链不断）。`,
                          danger: true,
                          action: async () => {
                            await api.post(`/admin/users/${u.id}/disable`);
                            toast("已停用");
                            await refresh();
                          },
                        })
                      }
                    >
                      停用
                    </Button>
                  ) : (
                    u.status === "disabled" && (
                      <Button
                        onClick={async () => {
                          await api.post(`/admin/users/${u.id}/enable`);
                          toast("已启用");
                          void refresh();
                        }}
                      >
                        启用
                      </Button>
                    )
                  )}
                  <Button
                    kind="ghost"
                    onClick={() =>
                      setConfirming({
                        title: "重置开号",
                        message:
                          "生成新开号令牌？其原条目需通过组织恢复重新授权。",
                        action: async () => {
                          const r = await api.post<{ setup_url: string }>(
                            `/admin/users/${u.id}/reset`,
                          );
                          setCreated({
                            username: u.username,
                            setup_url: r.setup_url,
                          });
                        },
                      })
                    }
                  >
                    重置
                  </Button>
                  <Button
                    kind="ghost"
                    onClick={() => {
                      const role = u.role === "admin" ? "member" : "admin";
                      setConfirming({
                        title: "调整角色",
                        message: `将 ${u.username} 的角色改为${role === "admin" ? "管理员" : "成员"}？`,
                        action: async () => {
                          await api.post(`/admin/users/${u.id}/role`, { role });
                          toast("已调整");
                          await refresh();
                        },
                      });
                    }}
                  >
                    角色
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ================= 组 ================= */

function GroupsPanel() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [newGroupName, setNewGroupName] = useState<string | null>(null);
  const [memberEdit, setMemberEdit] = useState<Group | null>(null);

  const refresh = useCallback(async () => {
    const [g, u] = await Promise.all([
      api.get<{ groups: Group[] }>("/admin/groups"),
      api.get<{ users: User[] }>("/admin/users"),
    ]);
    setGroups(g.groups);
    setUsers(u.users);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createGroup = async (name: string) => {
    try {
      await api.post("/admin/groups", { name });
      toast("已创建组");
      await refresh();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "创建失败");
    }
  };

  return (
    <div className="card">
      <div className="toolbar">
        <Button
          kind="primary"
          onClick={() => setNewGroupName("")}
        >
          新建组
        </Button>
        <span className="muted" style={{ fontSize: 12 }}>
          组只是人的集合；共享给组时授权仍逐人展开（加密模型不变）。
        </span>
      </div>
      {groups === null ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <Empty text="还没有组" />
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>组名</th>
              <th>成员</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.id}>
                <td>
                  <b>{g.name}</b>
                </td>
                <td>{g.members.map((m) => m.username).join("、") || "—"}</td>
                <td>
                  <Button onClick={() => setMemberEdit(g)}>编辑成员</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {newGroupName !== null && (
        <PromptModal
          title="新建组"
          label="组名（如：运维 / 开发 / 财务）"
          placeholder="运维"
          onOk={(v) => void createGroup(v)}
          onClose={() => setNewGroupName(null)}
        />
      )}
      {memberEdit && (
        <GroupMembersModal
          group={memberEdit}
          users={users}
          onClose={() => setMemberEdit(null)}
          onSaved={() => {
            setMemberEdit(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function GroupMembersModal({
  group,
  users,
  onClose,
  onSaved,
}: {
  group: Group;
  users: User[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [ids, setIds] = useState<Set<string>>(
    () => new Set(group.members.map((m) => m.id)),
  );
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/groups/${group.id}/members`, {
        user_ids: [...ids],
      });
      toast("已更新组成员");
      onSaved();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`编辑组「${group.name}」成员`} onClose={onClose}>
      <div style={{ maxHeight: "50vh", overflow: "auto", marginBottom: 12 }}>
        {users.map((u) => (
          <label key={u.id} style={{ display: "block", padding: "4px 0" }}>
            <input
              type="checkbox"
              checked={ids.has(u.id)}
              onChange={(e) => {
                const next = new Set(ids);
                if (e.target.checked) next.add(u.id);
                else next.delete(u.id);
                setIds(next);
              }}
            />{" "}
            {u.display_name || u.username}
            <span className="muted" style={{ fontSize: 12 }}>
              （{u.username}）
            </span>
          </label>
        ))}
        {users.length === 0 && <Empty text="还没有用户" />}
      </div>
      <Button kind="primary" disabled={busy} onClick={() => void save()}>
        保存
      </Button>
    </Modal>
  );
}

/* ================= 组织恢复 / 离职交接 ================= */

function RecoveryPanel() {
  const { me, vault } = useApp();
  interface RecoveryStatus {
    has_org: boolean;
    i_am_delegate: boolean;
    sealed_for_me: string | null;
  }
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [reason, setReason] = useState("");
  const [orgPriv, setOrgPriv] = useState<Uint8Array | null>(null); // 内存
  const [targetId, setTargetId] = useState("");
  const [entries, setEntries] = useState<RecoveryEntry[] | null>(null);
  const [plain, setPlain] = useState<Record<string, SecretContent>>({});
  const [successorId, setSuccessorId] = useState("");
  const [transfer, setTransfer] = useState(false);
  const [users, setUsers] = useState<
    Array<{
      id: string;
      username: string;
      display_name: string;
      public_key: string;
    }>
  >([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<RecoveryStatus>("/admin/recovery/status")
      .then(setStatus)
      .catch(() => setStatus(null));
    api
      .get<{
        users: Array<{
          id: string;
          username: string;
          display_name: string;
          public_key: string;
        }>;
      }>("/secrets/share-targets")
      .then((r) => setUsers(r.users))
      .catch(() => {});
  }, []);

  const prepare = async () => {
    if (!vault) {
      toastErr("请先到密钥区解锁");
      return;
    }
    if (reason.trim().length < 5) {
      toastErr("请填写恢复理由（必填，写入审计）");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ sealed_for_me: string }>(
        "/admin/recovery/prepare",
        { reason },
      );
      const orgPrivKey = openOrgDelegate(vault, r.sealed_for_me, me!.user_id);
      setOrgPriv(orgPrivKey);
      toast("组织私钥已在本页内存解开，可选择目标用户");
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "prepare 失败");
    } finally {
      setBusy(false);
    }
  };

  const loadEntries = async () => {
    if (!orgPriv || !targetId) {
      toastErr("先 prepare 并选择目标用户");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ entries: RecoveryEntry[] }>(
        "/admin/recovery/entries",
        { user_id: targetId },
      );
      setEntries(r.entries);
      // 全部本地解密展示（管理员恢复能力，全程审计）
      const map: Record<string, SecretContent> = {};
      for (const e of r.entries) {
        try {
          const dek = openOrgWrappedDek(orgPriv, e.dek_wrapped_org, e.id);
          const { decryptContent } = await import("../crypto/flows");
          map[e.id] = decryptContent(dek, e.content_ct, e.id);
        } catch {
          /* 单条失败不影响其余 */
        }
      }
      setPlain(map);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "读取条目失败");
    } finally {
      setBusy(false);
    }
  };

  const [confirming, setConfirming] = useState<null | {
    message: string;
    action: () => Promise<void>;
  }>(null);

  const regrant = async () => {
    if (!orgPriv || !entries || entries.length === 0 || !successorId) {
      toastErr("先选接手人");
      return;
    }
    setConfirming({
      message: `为 ${entries.length} 条条目建立接手人授权${transfer ? "并转移所有权" : ""}？动作将写入审计并通知相关人员。`,
      action: async () => {
        await doRegrant();
      },
    });
  };

  const doRegrant = async () => {
    if (!orgPriv || !entries) return; // 调用方 regrant 已校验，此处仅类型收窄
    setBusy(true);
    try {
      const successor = users.find((u) => u.id === successorId);
      if (!successor) throw new Error("接手人公钥缺失");
      const items = [];
      for (const e of entries) {
        const dek = openOrgWrappedDek(orgPriv, e.dek_wrapped_org, e.id);
        items.push({
          secret_id: e.id,
          wrapped_dek: sealDekForUser(
            successor.public_key,
            dek,
            e.id,
            successor.id,
          ),
        });
      }
      await api.post("/admin/recovery/regrant", {
        reason,
        successor_id: successorId,
        transfer,
        items,
      });
      toast(
        `完成：${items.length} 条已授权${transfer ? "并转移" : ""}。敏感条目请提示轮换真实密码。`,
      );
      setEntries(null);
      setPlain({});
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "regrant 失败");
    } finally {
      setBusy(false);
    }
  };

  const exportPackage = async () => {
    try {
      const pkg = await api.get<Record<string, unknown>>(
        "/admin/recovery/offline-package",
      );
      const blob = new Blob([JSON.stringify(pkg, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "org-recovery-package.json";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("离线恢复包已下载（打印入柜；导出已写审计）");
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "导出失败");
    }
  };

  if (!vault) {
    return (
      <div className="card">
        <div className="secret-hint">
          组织恢复需要你的主密码解锁密钥区（解出自己的私钥才能打开组织私钥副本）。请先到「密钥区」解锁。
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="secret-hint">
        <b>能力与代价（设计 4.5）</b>
        ：管理员能在此代为恢复任何条目——每次使用都强制记录理由、写审计并通知所有者。
        离线路径用「离线恢复码 + 恢复包」走 scripts/offline_recover.py。
      </div>
      {confirming && (
        <ConfirmModal
          title="确认组织恢复 / 交接"
          message={confirming.message}
          onOk={() => void confirming.action()}
          onClose={() => setConfirming(null)}
        />
      )}
      <div className="toolbar">
        <Button
          onClick={() => void exportPackage()}
          disabled={!status?.has_org}
        >
          导出离线恢复包
        </Button>
        <span className="muted" style={{ fontSize: 12 }}>
          组织密钥：{status?.has_org ? "已初始化" : "未初始化"} · 你
          {status?.i_am_delegate ? "持有" : "没有"}委托副本
        </span>
      </div>

      <Field label="恢复理由 *（必填，写入审计与通知）">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="例：张三离职交接 / 李四忘记主密码"
        />
      </Field>
      <Button
        kind="primary"
        disabled={busy || !!orgPriv}
        onClick={() => void prepare()}
      >
        {orgPriv ? "✓ 组织私钥已解开" : busy ? "解封中…" : "① 解开组织私钥"}
      </Button>

      {orgPriv && (
        <div
          style={{
            marginTop: 16,
            borderTop: "1px solid var(--line)",
            paddingTop: 12,
          }}
        >
          <div className="row">
            <Field label="目标用户（其名下/被共享的条目）">
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">选择用户…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name || u.username}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="接手人">
              <select
                value={successorId}
                onChange={(e) => setSuccessorId(e.target.value)}
              >
                <option value="">选择接手人…</option>
                {users
                  .filter((u) => u.id !== targetId)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.display_name || u.username}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <div className="toolbar">
            <Button
              onClick={() => void loadEntries()}
              disabled={!targetId || busy}
            >
              ② 读取并本地解密条目
            </Button>
            <label style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={transfer}
                onChange={(e) => setTransfer(e.target.checked)}
              />{" "}
              同时转移所有权（离职交接）
            </label>
            <Button
              kind="primary"
              disabled={busy || !entries?.length || !successorId}
              onClick={() => void regrant()}
            >
              ③ 为接手人重新包装授权
            </Button>
          </div>

          {entries === null ? null : entries.length === 0 ? (
            <Empty text="该用户名下没有条目" />
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>条目</th>
                  <th>项目</th>
                  <th>环境</th>
                  <th>内容（本地解密）</th>
                  <th>当前授权</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <b>{e.name}</b>
                      {e.is_owner && " (名下)"}
                    </td>
                    <td>{e.project || "—"}</td>
                    <td>{e.env || "—"}</td>
                    <td style={{ maxWidth: 320, wordBreak: "break-all" }}>
                      {plain[e.id]
                        ? JSON.stringify(plain[e.id])
                        : "（解密失败）"}
                    </td>
                    <td>{e.grantees.map((g) => g.username).join("、")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
