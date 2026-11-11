/** 审计中心：成员看自己，管理员看全部；含通知列表。 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { Badge, Button, Empty, Spinner } from "../components/ui";
import { useApp } from "../store";

interface Log {
  id: number;
  user_id: string | null;
  username: string;
  action: string;
  target_type: string;
  target_id: string;
  ip: string;
  reason: string;
  severity: string;
  created_at: string;
}
interface Notification {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

const ACTION_LABELS: Record<string, string> = {
  login: "登录",
  login_failed: "登录失败",
  logout: "退出",
  unlock: "解锁密钥区",
  lock: "锁定密钥区",
  user_created: "开号",
  user_disabled: "停用账号",
  user_enabled: "启用账号",
  role_changed: "角色调整",
  user_reset: "重置账号",
  doc_uploaded: "上传文档",
  doc_updated: "更新文档",
  doc_deleted: "删除文档",
  doc_reindexed: "重建索引",
  secret_created: "创建条目",
  secret_updated: "更新条目",
  secret_deleted: "删除条目",
  secret_rotated: "轮换条目",
  secret_revealed: "查看密钥",
  grant_created: "新增共享",
  grant_revoked: "撤销共享",
  org_recovery_prepare: "组织恢复·解封",
  org_recovery_entries_listed: "组织恢复·读取条目",
  org_recovery_regrant: "组织恢复·重授权",
  offline_package_exported: "导出离线恢复包",
  output_gate_blocked: "输出闸拦截",
  handover: "离职交接",
  pending_claimed: "认领占位符",
  dify_retrieval: "Dify 检索",
  setup_completed: "完成开号设置",
  group_created: "新建组",
  group_members_set: "设置组成员",
};

export default function AuditPage() {
  const { me } = useApp();
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [action, setAction] = useState("");
  const [userId, setUserId] = useState("");
  const [notifs, setNotifs] = useState<Notification[]>([]);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams({ limit: "200" });
    if (action) params.set("action", action);
    if (userId) params.set("user_id", userId);
    const r = await api.get<{ logs: Log[] }>(`/audit?${params}`);
    setLogs(r.logs);
    const n = await api.get<{ notifications: Notification[] }>(
      "/notifications",
    );
    setNotifs(n.notifications);
  }, [action, userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const markAll = async () => {
    await api.post("/notifications/read-all");
    await refresh();
  };

  return (
    <div>
      <div className="page-head">
        <h2>审计{me?.role !== "admin" && "（本人）"}</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          只记动作，绝不记录任何内容
        </span>
      </div>

      {notifs.some((n) => !n.read_at) && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="toolbar">
            <b>🔔 通知</b>
            <span style={{ flex: 1 }} />
            <Button onClick={() => void markAll()}>全部已读</Button>
          </div>
          {notifs
            .filter((n) => !n.read_at)
            .map((n) => (
              <div key={n.id} className="hit-row">
                <Badge tone="warn">{n.type}</Badge>
                <span style={{ flex: 1 }}>
                  {describeNotification(n.type, n.payload)}
                  <span
                    className="muted"
                    style={{ marginLeft: 8, fontSize: 12 }}
                  >
                    {new Date(n.created_at).toLocaleString()}
                  </span>
                </span>
                <Button
                  kind="ghost"
                  onClick={async () => {
                    await api.post(`/notifications/${n.id}/read`);
                    void refresh();
                  }}
                >
                  已读
                </Button>
              </div>
            ))}
        </div>
      )}

      <div className="card">
        <div className="toolbar">
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            style={{ width: 180 }}
          >
            <option value="">全部动作</option>
            {Object.entries(ACTION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          {me?.role === "admin" && (
            <input
              type="text"
              placeholder="按 user_id 过滤（管理员）"
              value={userId}
              style={{ width: 280 }}
              onChange={(e) => setUserId(e.target.value)}
            />
          )}
          <Button onClick={() => void refresh()}>查询</Button>
        </div>

        {logs === null ? (
          <Spinner />
        ) : logs.length === 0 ? (
          <Empty text="没有记录" />
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>时间</th>
                <th>谁</th>
                <th>动作</th>
                <th>目标</th>
                <th>IP</th>
                <th>理由</th>
                <th>级别</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {new Date(l.created_at).toLocaleString()}
                  </td>
                  <td>{l.username || l.user_id || "系统"}</td>
                  <td>{ACTION_LABELS[l.action] ?? l.action}</td>
                  <td
                    className="muted"
                    style={{ maxWidth: 220, wordBreak: "break-all" }}
                  >
                    {l.target_type}:{l.target_id.slice(0, 18)}
                  </td>
                  <td className="muted">{l.ip}</td>
                  <td className="log-reason">{l.reason}</td>
                  <td>
                    <Badge
                      tone={
                        l.severity === "alert"
                          ? "err"
                          : l.severity === "warn"
                            ? "warn"
                            : "info"
                      }
                    >
                      {l.severity}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function describeNotification(
  type: string,
  payload: Record<string, unknown>,
): string {
  const by = typeof payload.by === "string" ? payload.by : "";
  switch (type) {
    case "grant_created":
      return `${by} 向你共享了一个条目`;
    case "grant_revoked":
      return `${by} 撤销了给你的条目授权`;
    case "org_recovery_used":
      return `管理员 ${by} 可能已查看你的条目（组织恢复）`;
    case "handover_in":
      return `${by} 将 ${payload.count ?? "?"} 个条目交接给你${payload.transfer ? "（含所有权转移）" : ""}`;
    case "handover_out":
      return `你名下的条目被交接给 ${payload.successor ?? "他人"}（操作人 ${by}）`;
    case "account_disabled":
      return `账号已被 ${by} 停用`;
    default:
      return `${type} ${by}`;
  }
}
