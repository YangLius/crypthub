/**
 * 密钥区（设计 M2/M3）：解锁门 → 条目列表 → 创建/查看/共享/轮换/删除/历史。
 * 所有加解密在浏览器完成；服务端只搬密文。
 * 创建条目时由客户端生成 UUID（AAD 需预先绑定 id），服务端原样落库。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { scan } from "../gates/redact";
import {
  findPairedHit,
  matchPendingsToLocal,
  peekPrescanHit,
  removePrescanHit,
  savePrescanHits,
  suggestFields,
  urlHintsFromRedacted,
  type CachedHit,
  type ContentPatch,
} from "../secrets/prescanCache";
import {
  Badge,
  Button,
  ConfirmModal,
  Empty,
  Field,
  Modal,
  PromptModal,
  SecretHint,
  Spinner,
} from "../components/ui";
import {
  FolderPickerModal,
  FolderTree,
  ensureMirroredSecretFolder,
  flattenFolders,
  folderPaths,
  useFolders,
  type FolderSel,
  type MirroredFolder,
} from "../components/FolderTree";
import {
  clampEntries,
  IMPORT_MAX_ENTRIES,
  parseImportFile,
  type ParseResult,
  type ParsedEntry,
} from "../secrets/importer";
import {
  contentForTemplate,
  guessTemplate,
  templateById,
  TEMPLATES,
  type TemplateId,
} from "../secrets/templates";

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
  folder_id: string | null;
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

/** 环境选项：值保持 prod/staging/dev 稳定标识，展示用中文。 */
const ENV_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "未指定" },
  { value: "prod", label: "生产" },
  { value: "staging", label: "预发" },
  { value: "dev", label: "开发" },
];

function envLabel(v: string): string {
  return ENV_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
interface PendingRow {
  id: string;
  slug: string;
  kind: string;
  source_doc_id: string | null;
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

  // 多级目录（每人自己的私有树）
  const [folder, setFolder] = useState<FolderSel>(null);
  const [folderKey, setFolderKey] = useState(0);
  const folderPathMap = folderPaths(useFolders("secret", folderKey));

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
      (!q || r.name.toLowerCase().includes(q.toLowerCase())) &&
      (folder === null ||
        (folder === "root" ? !r.folder_id : r.folder_id === folder)),
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

      <div className="with-folder-panel">
        <FolderTree
          kind="secret"
          selected={folder}
          onSelect={setFolder}
          reloadKey={folderKey}
          onMutate={() => setFolderKey((k) => k + 1)}
          rootLabel="未归档"
        />
        <div style={{ flex: 1, minWidth: 0 }}>
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
            activeFolder={folder}
            paths={folderPathMap}
            onPickFolder={setFolder}
          />
        </div>
      </div>
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
              autoComplete="new-password"
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
  activeFolder: FolderSel;
  paths: Map<string, string>;
  onPickFolder: (f: FolderSel) => void;
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
    activeFolder,
    paths,
    onPickFolder,
  } = props;
  // null=关闭 / {row:null}=新建 / {row}=认领该行 —— 避免用裸 null 表达两种含义
  const [creating, setCreating] = useState<{
    row: PendingRow | null;
    pairSlug?: string;
  } | null>(null);
  const [recovering, setRecovering] = useState<{
    docId: string;
    title: string;
  } | null>(null);
  const docGroups = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pending) {
      if (p.source_doc_id && !m.has(p.source_doc_id)) {
        m.set(p.source_doc_id, p.doc_title ?? p.source_hint);
      }
    }
    return [...m.entries()];
  }, [pending]);

  // 成对分组：同一组“用户名+密码”的两条占位符合并为一行展示；
  // 接管一次创建一条密钥，提交后两行一并销掉（CreateModal 内已处理双回填/双认领）
  // 配对来源：① 本机预扫缓存（同标签页上传，最准）② 服务端脱敏文本占位符
  // 顺序/标签推断（跨标签页兑底；凭据值始终只在浏览器，零知识不受影响）
  const [pairMap, setPairMap] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: Record<string, string> = {};
      for (const p of pending) {
        const hit = peekPrescanHit(p.slug);
        const paired = hit ? findPairedHit(p.slug) : null;
        if (paired) {
          out[p.slug] = paired.slug;
          out[paired.slug] = p.slug;
        }
      }
      const missing = pending.filter((p) => !out[p.slug]);
      const byDoc = new Map<string, string[]>();
      for (const p of missing) {
        if (p.source_doc_id)
          byDoc.set(p.source_doc_id, [
            ...(byDoc.get(p.source_doc_id) ?? []),
            p.slug,
          ]);
      }
      for (const [docId, slugs] of byDoc) {
        try {
          const r = await api.get<{ text: string }>(
            `/documents/${docId}/redacted`,
          );
          // 新格式：键名保留在占位符前 → 相邻「用户名+密码」成组
          const labeled = [
            ...r.text.matchAll(
              /(用户名|账号|帐号|密码|口令)\s*[:：]\s*\{\{secret:([0-9a-f]+)\}\}/g,
            ),
          ];
          if (labeled.length >= 2) {
            for (let i = 0; i + 1 < labeled.length; i += 2) {
              const a = labeled[i];
              const b = labeled[i + 1];
              const aUser = /用户名|账号|帐号/.test(a[1]);
              const bUser = /用户名|账号|帐号/.test(b[1]);
              if (aUser && !bUser) {
                out[a[2]] = b[2];
                out[b[2]] = a[2];
              }
            }
          } else {
            // 旧格式（无标签）：占位符按出现顺序「用户名在前、密码在后」两两配对
            const ordered = slugs
              .filter((s) => r.text.includes(`{{secret:${s}}}`))
              .sort(
                (x, y) =>
                  r.text.indexOf(`{{secret:${x}}}`) -
                  r.text.indexOf(`{{secret:${y}}}`),
              );
            for (let i = 0; i + 1 < ordered.length; i += 2) {
              out[ordered[i]] = ordered[i + 1];
              out[ordered[i + 1]] = ordered[i];
            }
          }
        } catch {
          // 无可读脱敏文本：放弃配对，逐条显示
        }
      }
      if (alive) setPairMap(out);
    })();
    return () => {
      alive = false;
    };
  }, [pending]);
  const groupedPending = useMemo(() => {
    const consumed = new Set<string>();
    const out: { row: PendingRow; pairRow?: PendingRow }[] = [];
    for (const p of pending) {
      if (consumed.has(p.id)) continue;
      const pairedSlug = pairMap[p.slug];
      const pairRow = pairedSlug
        ? pending.find((x) => x.slug === pairedSlug && x.id !== p.id)
        : undefined;
      if (pairRow) consumed.add(pairRow.id);
      out.push({ row: p, pairRow });
    }
    return out;
  }, [pending, pairMap]);
  const [importing, setImporting] = useState(false);
  const [viewing, setViewing] = useState<SecretFull | null>(null);
  const [moving, setMoving] = useState<SecretRow | null>(null);

  const moveRow = async (r: SecretRow, target: string | null) => {
    try {
      await api.patch(`/secrets/${r.id}/folder`, {
        folder_id: target ?? "root", // null=移回未归档；发 "root" 哨兵
      });
      toast(target ? "已归档" : "已移回未归档");
      setMoving(null);
      await refresh();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "移动失败");
    }
  };

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
              <th>目录</th>
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
                <td>
                  <span
                    role="button"
                    tabIndex={0}
                    style={{
                      cursor: "pointer",
                      textDecoration: "underline dotted",
                    }}
                    title="点击筛选该目录"
                    onClick={() => onPickFolder(r.folder_id ?? "root")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ")
                        onPickFolder(r.folder_id ?? "root");
                    }}
                  >
                    {r.folder_id ? (paths.get(r.folder_id) ?? "—") : "根目录"}
                  </span>
                </td>
                <td>{r.project || "—"}</td>
                <td>
                  {r.env ? (
                    <Badge tone={r.env === "prod" ? "err" : "info"}>
                      {envLabel(r.env)}
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
                  <Button
                    kind="ghost"
                    title="归档到我的目录"
                    onClick={() => setMoving(r)}
                  >
                    移动
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
        <Button kind="primary" onClick={() => setCreating({ row: null })}>
          ＋ 新建条目
        </Button>
        <Button
          title="从 .env/.txt/.csv/.json/.xlsx 文件批量解析导入"
          onClick={() => setImporting(true)}
        >
          从文件导入
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
            待认领占位符（预扫产生；认领时自动回填本机记录的命中值；成对的用户名+密码已合并为一行）
          </h4>
          {docGroups.length > 0 && (
            <div
              style={{
                marginBottom: 8,
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                旧上传（无本机缓存）可从原文回填：
              </span>
              {docGroups.map(([id, gTitle]) => (
                <Button
                  key={id}
                  kind="ghost"
                  onClick={() => setRecovering({ docId: id, title: gTitle })}
                >
                  从本机原文回填《{gTitle}》
                </Button>
              ))}
            </div>
          )}
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
              {groupedPending.map(({ row: p, pairRow }) => (
                <tr key={p.id}>
                  <td>
                    <code>{`{{secret:${p.slug}}}`}</code>
                    {pairRow && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        + <code>{`{{secret:${pairRow.slug}}}`}</code>
                      </div>
                    )}
                  </td>
                  <td>
                    {pairRow ? (
                      <Badge tone="info">用户名+密码（成对）</Badge>
                    ) : (
                      <Badge tone="warn">{p.kind}</Badge>
                    )}
                  </td>
                  <td>{p.doc_title ?? p.source_hint}</td>
                  <td>
                    <Button
                      title={
                        pairRow
                          ? "创建一条密钥同时填入用户名+密码，两条占位符一并归属"
                          : "创建条目后把占位符归属到它"
                      }
                      onClick={() =>
                        setCreating({ row: p, pairSlug: pairRow?.slug })
                      }
                    >
                      新建并认领
                    </Button>
                    <Button
                      kind="ghost"
                      onClick={async () => {
                        await api.post(`/secrets/pending/${p.id}/dismiss`);
                        if (pairRow)
                          await api.post(
                            `/secrets/pending/${pairRow.id}/dismiss`,
                          );
                        const drop = new Set(
                          [p.id, pairRow?.id].filter(Boolean) as string[],
                        );
                        onPendingChange(pending.filter((x) => !drop.has(x.id)));
                      }}
                    >
                      {pairRow ? "忽略（两条）" : "忽略"}
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
          pendingRow={creating.row}
          pairSlug={creating.pairSlug}
          vault={vault}
          defaultFolderSel={
            activeFolder && activeFolder !== "root" ? activeFolder : ""
          }
          onClose={() => setCreating(null)}
          onDone={(sid, pairedSlug) => {
            setCreating(null);
            // 归档目录由 CreateModal 内部处理（新建=弹窗内选择；认领=镜像源文档路径）
            void refresh();
            const claimed = creating.row;
            if (sid && claimed) {
              // 成对认领：配对的那条 pending（另一条 slug）也挂到同一条密钥上销掉
              const paired = pairedSlug
                ? pending.find((x) => x.slug === pairedSlug)
                : undefined;
              const dropIds = new Set(
                [claimed.id, paired?.id].filter(Boolean) as string[],
              );
              void api.post(`/secrets/pending/${claimed.id}/claim`, {
                secret_id: sid,
              });
              if (paired) {
                void api.post(`/secrets/pending/${paired.id}/claim`, {
                  secret_id: sid,
                });
              }
              onPendingChange(pending.filter((x) => !dropIds.has(x.id)));
            }
          }}
        />
      )}
      {recovering && (
        <RecoverModal
          docId={recovering.docId}
          title={recovering.title}
          pendings={pending.filter((p) => p.source_doc_id === recovering.docId)}
          onClose={() => setRecovering(null)}
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

      {moving && (
        <FolderPickerModal
          kind="secret"
          onClose={() => setMoving(null)}
          onPick={(target) => void moveRow(moving, target)}
        />
      )}

      {importing && (
        <ImportModal
          myUserId={me.user_id}
          defaultFolder={activeFolder}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

/* ================= 创建 ================= */

/* ================= 创建 / 批量导入 ================= */

/** 创建一条密钥（客户端加密：内容密文 + DEK 双重包装）。返回服务端 id。 */
async function createSecretRow(args: {
  myUserId: string;
  myPubkey: string;
  orgPub: string;
  name: string;
  project: string;
  env: string;
  tags: string[];
  content: SecretContent;
  folderId?: string; // uuid；导入/目录内新建时归档到该目录
}): Promise<string> {
  // 客户端生成 id → 所有密文（内容/owner 包装/组织包装）预先绑定该 id
  const sid = newSecretId();
  const dek = newDek();
  await api.post<{ id: string }>("/secrets", {
    id: sid,
    name: args.name,
    project: args.project,
    env: args.env,
    tags: args.tags,
    content_ct: encryptContent(dek, args.content, sid),
    dek_wrapped_org: sealDekForOrg(args.orgPub, dek, sid),
    grants: [
      {
        user_id: args.myUserId,
        wrapped_dek: sealDekForUser(args.myPubkey, dek, sid, args.myUserId),
      },
    ],
  });
  if (args.folderId) {
    await api
      .patch(`/secrets/${sid}/folder`, { folder_id: args.folderId })
      .catch(() => {});
  }
  return sid;
}

/** 从文件解析结果勾选导入（逐条加密上传，带进度；复用 createSecretRow 的加密链路） */
function ImportModal({
  myUserId,
  defaultFolder,
  onClose,
  onDone,
}: {
  myUserId: string;
  defaultFolder: FolderSel;
  onClose: () => void;
  onDone: (imported: number) => void;
}) {
  const { me } = useApp();
  const secFolders = useFolders("secret", 0);
  // 导入目标目录（uuid；空串=未归档）：弹窗内可选，默认跟随左侧目录树当前选中
  const [targetFolder, setTargetFolder] = useState(
    defaultFolder && defaultFolder !== "root" ? defaultFolder : "",
  );
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [project, setProject] = useState("");
  const [env, setEnv] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    failed: number;
  } | null>(null);
  const [orgPub, setOrgPub] = useState("");
  const [fileErr, setFileErr] = useState("");

  useEffect(() => {
    api
      .get<{ org_pubkey: string }>("/admin/recovery/status")
      .then((r) => setOrgPub(r.org_pubkey ?? ""))
      .catch(() => setOrgPub(""));
  }, []);

  const onFile = async (f: File) => {
    setFileErr("");
    try {
      const res = await parseImportFile(f);
      const { result, clamped } = clampEntries(res);
      if (!result.entries.length) {
        setFileErr(
          `未能从文件解析出条目（${result.format}，跳过 ${result.skipped} 行）。支持：.env/.txt（空行分块或 KEY=VALUE）、.csv（带表头）、.json、.xlsx`,
        );
        setParsed(null);
        return;
      }
      setParsed(result);
      setChecked(new Set(result.entries.map((_, i) => i)));
      if (clamped > 0)
        toastErr(
          `条目超过 ${IMPORT_MAX_ENTRIES} 上限，仅导入前 ${IMPORT_MAX_ENTRIES} 条`,
        );
    } catch (e) {
      setFileErr(e instanceof Error ? e.message : "解析失败");
      setParsed(null);
    }
  };

  const doImport = async () => {
    if (!me?.public_key || !orgPub) {
      toastErr("缺少自己的公钥或组织公钥");
      return;
    }
    const idxs = [...checked].sort((a, b) => a - b);
    if (!idxs.length) {
      toastErr("请至少勾选一条");
      return;
    }
    setBusy(true);
    setProgress({ done: 0, total: idxs.length, failed: 0 });
    let failed = 0;
    for (let i = 0; i < idxs.length; i++) {
      const e: ParsedEntry = parsed!.entries[idxs[i]];
      try {
        await createSecretRow({
          myUserId,
          myPubkey: me.public_key,
          orgPub,
          name: e.name,
          project,
          env,
          tags: [],
          content: { ...e.content, type: guessTemplate(e.content) },
          folderId: targetFolder || undefined,
        });
      } catch {
        failed++;
      }
      setProgress({ done: i + 1, total: idxs.length, failed });
    }
    setBusy(false);
    const ok = idxs.length - failed;
    if (ok > 0) {
      toast(
        failed
          ? `导入完成：成功 ${ok} 条，失败 ${failed} 条`
          : `已导入 ${ok} 条（内容仅存密文）`,
      );
      onDone(ok);
    } else {
      toastErr(`全部失败（${failed} 条），请检查网络后重试`);
    }
  };

  const fieldChips = (c: SecretContent): string[] =>
    [
      c.username ? "账号" : "",
      c.password ? "密码" : "",
      c.url ? "地址" : "",
      c.tokens ? "令牌" : "",
      c.notes ? "备注" : "",
    ].filter(Boolean);

  const allChecked = parsed !== null && checked.size === parsed.entries.length;

  return (
    <Modal title="从文件导入密钥" onClose={busy ? () => {} : onClose}>
      <div className="secret-hint">
        解析在本机浏览器完成，<b>文件不会上传</b>；每条条目加密后逐条创建。
        名称/项目/环境为明文元数据，勾选确认后才会写入。
      </div>
      <Field label="选择文件（.env / .txt / .csv / .json / .xlsx，≤ 2MB）">
        <input
          type="file"
          accept=".env,.txt,.csv,.tsv,.json,.md,.conf,.ini,.properties,.xlsx"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
          }}
        />
      </Field>
      <Field label="归档目录">
        <select
          value={targetFolder}
          disabled={busy}
          onChange={(e) => setTargetFolder(e.target.value)}
        >
          <option value="">未归档（根目录）</option>
          {flattenFolders(secFolders).map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </Field>
      {fileErr && <SecretHint>{fileErr}</SecretHint>}

      {parsed && (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              margin: "4px 0 8px",
            }}
          >
            <span className="auth-sub">
              {parsed.format} · 解析到 {parsed.entries.length} 条
              {parsed.skipped > 0 ? `（跳过 ${parsed.skipped} 行）` : ""}
            </span>
            <span style={{ flex: 1 }} />
            <Button
              kind="ghost"
              onClick={() =>
                setChecked(
                  allChecked
                    ? new Set()
                    : new Set(parsed.entries.map((_, i) => i)),
                )
              }
            >
              {allChecked ? "全不选" : "全选"}
            </Button>
          </div>

          <div className="import-list">
            {parsed.entries.map((e, i) => (
              <label key={i} className="import-item">
                <input
                  type="checkbox"
                  checked={checked.has(i)}
                  disabled={busy}
                  onChange={(ev) => {
                    const next = new Set(checked);
                    if (ev.target.checked) next.add(i);
                    else next.delete(i);
                    setChecked(next);
                  }}
                />
                <span className="import-name" title={e.name}>
                  {e.name}
                </span>
                <span className="import-chips">
                  {fieldChips(e.content).map((c) => (
                    <span key={c} className="badge">
                      {c}
                    </span>
                  ))}
                </span>
                <span className="import-preview" title={e.content.notes ?? ""}>
                  {e.content.notes
                    ? e.content.notes.slice(0, 30) +
                      (e.content.notes.length > 30 ? "…" : "")
                    : ""}
                </span>
              </label>
            ))}
          </div>

          <div className="row">
            <Field label="项目（应用到全部）">
              <input
                type="text"
                value={project}
                disabled={busy}
                onChange={(e) => setProject(e.target.value)}
              />
            </Field>
            <Field label="环境（应用到全部）">
              <select
                value={env}
                disabled={busy}
                onChange={(e) => setEnv(e.target.value)}
              >
                {ENV_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {progress && (
            <p className="auth-sub">
              正在加密上传… {progress.done}/{progress.total}
              {progress.failed > 0 ? `（失败 ${progress.failed}）` : ""}
            </p>
          )}

          <Button
            kind="primary"
            disabled={busy || checked.size === 0}
            onClick={() => void doImport()}
          >
            {busy
              ? `导入中（${progress?.done ?? 0}/${progress?.total ?? 0}）…`
              : `加密并导入勾选的 ${checked.size} 条`}
          </Button>
        </>
      )}
    </Modal>
  );
}

function CreateModal({
  myUserId,
  pendingRow,
  pairSlug,
  vault,
  defaultFolderSel,
  onClose,
  onDone,
}: {
  myUserId: string;
  pendingRow: PendingRow | null; // 从待认领进入时非空
  pairSlug?: string; // 成对认领的另一条 slug（本机缓存缺失时由外层传入）
  vault: UnlockedVault;
  defaultFolderSel: string; // 新建条目的默认归档目录（uuid；空串=未归档）
  onClose: () => void;
  onDone: (secretId: string, pairedSlug?: string) => void;
}) {
  const { me } = useApp();
  const secFolders = useFolders("secret", 0);
  // 新建条目的目标目录（uuid；空串=未归档）；认领场景不走此态，用镜像目录
  const [targetFolder, setTargetFolder] = useState(defaultFolderSel);
  const [name, setName] = useState(
    pendingRow?.doc_title ??
      (pendingRow ? `凭据（${pendingRow.slug.slice(0, 6)}…）` : ""),
  );
  const [project, setProject] = useState("");
  const [env, setEnv] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState<SecretContent>({ ...EMPTY_CONTENT });
  const [cachedHit, setCachedHit] = useState<CachedHit | null>(null);
  // 配对的另一条命中（用户名↔密码成对认领）；创建成功后一并从待认领清单销掉
  const [cachedPair, setCachedPair] = useState<CachedHit | null>(null);
  // 合并认领候选：本文档先前已认领的条目（本机解密比对）。认领用户名+密码时，
  // 若密码/用户名与旧条目一致，应补齐字段更新旧条目，而不是再新建一条
  const [mergeCandidates, setMergeCandidates] = useState<
    {
      sid: string;
      name: string;
      project?: string | null;
      env?: string | null;
      tags?: string[] | null;
      content: SecretContent;
      contentCt: string;
    }[]
  >([]);
  const [mergeSel, setMergeSel] = useState(""); // ""=新建条目，否则=合并目标 sid
  const [tplId, setTplId] = useState<TemplateId>("login");
  // 认领时把源文档的目录链镜像到密钥区（逐级 find-or-create），归档到最深层
  const [mirror, setMirror] = useState<MirroredFolder | null>(null);
  // 镜像解析是异步的：把 Promise 存 ref，提交时 await，避免用户快速点提交时 mirror 还未解析完 → 归到根目录
  const mirrorRef = useRef<Promise<MirroredFolder> | null>(null);

  // 认领回填：本机预扫缓存里有该 slug 的命中原文时，自动填名称/项目/内容字段；
  // 用户名↔密码配对的另一条也一并回填；命中附近有网址时自动识别为「网站」类型。
  // 旧版缓存（脱敏后只存了纯值、丢了键名标签）或本机无缓存时，
  // 从服务端脱敏文本的「键名：{{secret:slug}}」还原字段归类（值仍在浏览器，零知识）
  useEffect(() => {
    if (!pendingRow) return;
    const hit = peekPrescanHit(pendingRow.slug);
    const paired = hit ? findPairedHit(pendingRow.slug) : null;
    setCachedHit(hit);
    setCachedPair(paired);
    if (hit?.title) setName(hit.title);
    if (hit?.project) setProject(hit.project);
    // 旧格式缓存（kv 无 key 且纯值无法拆键）不乱猜字段，交给脱敏文本标签修复
    const sf = (h?: CachedHit | null): ContentPatch => {
      if (!h) return {};
      if (h.kind === "kv" && !h.key && !/^[^=:：]{1,48}[=:：]/.test(h.value))
        return {};
      return suggestFields(h);
    };
    const merged: ContentPatch = paired
      ? { ...sf(hit), ...sf(paired) }
      : sf(hit);
    const url = paired?.url ?? hit?.url;
    if (url) merged.url = url;
    const knownPair = Boolean(paired ?? pairSlug);
    let t0 = guessTemplate({ ...EMPTY_CONTENT, ...merged });
    // 配对已知时按用户名密码/网站归类（孤密码/孤用户名不再误判其他/API密钥）
    if (knownPair && !merged.tokens) t0 = merged.url ? "web" : "login";
    setContent((c) => ({ ...c, ...merged }));
    setTplId(t0);
    if (!pendingRow.source_doc_id) return;
    let alive = true;
    api
      .get<{ text: string }>(
        `/documents/${pendingRow.source_doc_id}/redacted`,
      )
      .then((r) => {
        if (!alive) return;
        const partnerSlug = paired?.slug ?? pairSlug;
        const slugs = [pendingRow.slug, partnerSlug].filter(
          Boolean,
        ) as string[];
        // 占位符前的键名标签 → 字段归类（用户名/密码/令牌/网址等）
        const labelOf = new Map<string, string>();
        for (const m of r.text.matchAll(
          /([^\s：:]{1,12})\s*[:：]\s*\{\{secret:([0-9a-f]+)\}\}/g,
        )) {
          labelOf.set(m[2], m[1]);
        }
        const fixed: ContentPatch = {};
        for (const s of slugs) {
          const label = labelOf.get(s);
          const v = peekPrescanHit(s)?.value;
          if (!label || !v) continue;
          if (/^(网址|域名|站点|网站|url)$/i.test(label)) {
            fixed.url = v;
            continue;
          }
          Object.assign(
            fixed,
            suggestFields({ kind: "kv", value: v, key: label }),
          );
        }
        const hints = urlHintsFromRedacted(r.text, slugs);
        const u = hints.get(pendingRow.slug) ?? hints.get(partnerSlug ?? "");
        if (u) fixed.url = u;
        const hasPairFields =
          slugs.some((s) => /用户名|账号|帐号/.test(labelOf.get(s) ?? "")) &&
          slugs.some((s) => /密码|口令/.test(labelOf.get(s) ?? ""));
        const knownPair2 = knownPair || hasPairFields;
        if (Object.keys(fixed).length === 0 && knownPair2 === knownPair) return;
        setContent((c) => ({ ...c, ...fixed }));
        let t = guessTemplate({ ...EMPTY_CONTENT, ...merged, ...fixed });
        if (knownPair2 && !fixed.tokens && !merged.tokens)
          t = fixed.url ? "web" : "login";
        setTplId(t);
      })
      .catch(() => {}); // 非客户端脱敏文档或临时失败：保持当前回填
    return () => {
      alive = false;
    };
  }, [pendingRow, pairSlug]);

  // 解析源文档目录链并镜像到密钥区；失败不阻塞（mirror 保持 null → 不归档）
  useEffect(() => {
    setMirror(null);
    const docId = pendingRow?.source_doc_id;
    if (!docId) {
      mirrorRef.current = null;
      return;
    }
    const p = ensureMirroredSecretFolder(docId);
    mirrorRef.current = p;
    let alive = true;
    p.then((m) => {
      if (alive && m.id) setMirror(m);
    });
    return () => {
      alive = false;
    };
  }, [pendingRow]);

  // 拉取本文档先前已认领的条目（本机解密）作为合并候选；已认领过的密码，
  // 再认领用户名+密码时应补齐字段更新旧条目，而不是再新建一条
  useEffect(() => {
    const docId = pendingRow?.source_doc_id;
    if (!docId) return;
    let alive = true;
    void (async () => {
      try {
        const r = await api.get<{
          placeholders: {
            slug: string;
            status: string;
            secret_id: string | null;
            secret_name?: string | null;
            secret_project?: string | null;
            secret_env?: string | null;
            secret_tags?: string[] | null;
          }[];
        }>(`/documents/${docId}/placeholders`);
        const out: {
          sid: string;
          name: string;
          project?: string | null;
          env?: string | null;
          tags?: string[] | null;
          content: SecretContent;
          contentCt: string;
        }[] = [];
        for (const p of r.placeholders) {
          if (!p.secret_id) continue;
          try {
            const rr = await api.get<{
              content_ct: string;
              wrapped_dek: string;
            }>(`/secrets/${p.secret_id}/reveal`);
            const c = openSecret(
              vault,
              rr.wrapped_dek,
              rr.content_ct,
              p.secret_id,
              myUserId,
            );
            out.push({
              sid: p.secret_id,
              name:
                p.secret_name ||
                c.notes?.slice(0, 20) ||
                p.secret_id.slice(0, 6),
              project: p.secret_project,
              env: p.secret_env,
              tags: p.secret_tags,
              content: c,
              contentCt: rr.content_ct,
            });
          } catch {
            // 限流或无授权：跳过该候选
          }
        }
        if (alive && out.length) setMergeCandidates(out);
      } catch {
        // 无占位符映射或临时失败：无合并候选，按新建处理
      }
    })();
    return () => {
      alive = false;
    };
  }, [pendingRow, vault, myUserId]);

  // 默认合并目标：优先用户名精确匹配，其次缺用户名的条目（等待补齐）
  useEffect(() => {
    if (!mergeCandidates.length) return;
    const patch = cachedPair
      ? { ...suggestFields(cachedHit!), ...suggestFields(cachedPair) }
      : cachedHit
        ? suggestFields(cachedHit)
        : null;
    const u = patch?.username;
    const p = patch?.password;
    let best = "";
    let bestScore = -1;
    for (const c of mergeCandidates) {
      let s = 0;
      if (u && c.content.username === u) s += 2;
      else if (!c.content.username) s += 1;
      if (p && c.content.password === p) s += 1;
      if (s > bestScore) {
        bestScore = s;
        best = c.sid;
      }
    }
    setMergeSel(best || mergeCandidates[0].sid);
  }, [mergeCandidates, cachedHit, cachedPair]);

  // 合并目标变化：回填旧条目的元数据（名称/项目/环境/标签/备注）供确认或微调；
  // 切回「新建条目」时恢复认领预填值
  const prefillSnapRef = useRef<{
    name: string;
    project: string;
    env: string;
    tags: string;
    notes: string;
  } | null>(null);
  useEffect(() => {
    if (!pendingRow) return;
    const c = mergeCandidates.find((x) => x.sid === mergeSel);
    if (c) {
      prefillSnapRef.current ??= {
        name,
        project,
        env,
        tags,
        notes: content.notes ?? "",
      };
      setName(c.name);
      setProject(c.project ?? "");
      setEnv(c.env ?? "");
      setTags((c.tags ?? []).join(", "));
      setContent((s) => ({ ...s, notes: c.content.notes ?? "" }));
    } else if (!mergeSel && prefillSnapRef.current) {
      const s = prefillSnapRef.current;
      prefillSnapRef.current = null;
      setName(s.name);
      setProject(s.project);
      setEnv(s.env);
      setTags(s.tags);
      setContent((cur) => ({ ...cur, notes: s.notes }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在合并目标/候选变化时回填
  }, [mergeSel, mergeCandidates]);

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
      // 合并认领：更新先前已认领的条目（只补齐空字段），不再新建
      if (pendingRow && mergeSel) {
        const c = mergeCandidates.find((x) => x.sid === mergeSel);
        if (!c) throw new Error("合并目标不存在，请重选");
        // 元数据按表单当前值一并更新（表单已回填旧条目值，可直接确认或微调）
        const mtags = tags
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean);
        await api.patch(`/secrets/${mergeSel}`, {
          name: name || null,
          project: project || null,
          env: env || null,
          tags: mtags,
        });
        const merged: SecretContent = { ...c.content };
        for (const k of ["username", "password", "url", "tokens"] as const) {
          const v = content[k];
          if (!merged[k] && v) merged[k] = v;
        }
        if (!merged.notes && content.notes) merged.notes = content.notes;
        merged.type = guessTemplate(merged);
        const [grantsR, targetsR] = await Promise.all([
          api.get<{ grants: { user_id: string; wrapped_dek: string }[] }>(
            `/secrets/${mergeSel}/grants`,
          ),
          api.get<{ users: { id: string; public_key: string }[] }>(
            "/secrets/share-targets",
          ),
        ]);
        const pubkeyMap: Record<string, string> = {};
        for (const u of targetsR.users) pubkeyMap[u.id] = u.public_key;
        const plan = buildRotationPlan({
          secretId: mergeSel,
          myUserId,
          content: merged,
          orgPubB64: orgPub,
          pubkeyMap,
          grants: grantsR.grants,
          oldContentCt: c.contentCt,
        });
        await api.put(`/secrets/${mergeSel}/rotate`, {
          content_ct: plan.contentCt,
          dek_wrapped_org: plan.dekWrappedOrg,
          wrapped_deks: plan.wrappedDeks,
          old_content_ct: plan.oldContentCt,
          old_wrapped_deks: plan.oldWrappedDeks,
        });
        removePrescanHit(pendingRow.slug);
        if (cachedPair) removePrescanHit(cachedPair.slug);
        toast(`已合并更新《${c.name}》（旧密文归档为历史版本）`);
        onDone(mergeSel, cachedPair?.slug ?? pairSlug);
        return;
      }
      // 认领场景：镜像目录可能在提交时才解析完——await 兑底，杜绝快速提交归错目录
      const m =
        pendingRow && mirrorRef.current ? await mirrorRef.current : mirror;
      const sid = await createSecretRow({
        myUserId,
        myPubkey: me.public_key,
        orgPub,
        name,
        project,
        env,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        content: contentForTemplate(tplId, content),
        // 认领场景：归档到源文档同路径的镜像目录；新建：用弹窗内选择的目录
        folderId: pendingRow ? m?.id : targetFolder || undefined,
      });
      if (pendingRow) removePrescanHit(pendingRow.slug); // 认领成功即删本机缓存
      if (cachedPair) removePrescanHit(cachedPair.slug); // 配对命中一并删除
      toast(
        cachedPair
          ? "已创建（用户名+密码成对认领，内容仅存密文）"
          : "已创建（内容仅存密文）",
      );
      onDone(sid, cachedPair?.slug ?? pairSlug);
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
            {cachedHit
              ? cachedPair
                ? "（已自动成对填入上传预扫时的用户名+密码，请核对后提交；提交后两条待认领一并销掉）"
                : "（已自动填入上传预扫时的命中值，请核对后提交；提交后本机缓存即删除）"
              : "（服务端从不保存命中原文，本机缓存中也没有该值，请凭记忆填入）"}
          </>
        )}
      </div>
      {pendingRow && (
        <div className="secret-hint" style={{ marginTop: -8 }}>
          {mirror?.id
            ? `认领后将归档到密钥区目录：📁 ${mirror.path}（与源文档同路径，目录不存在自动创建）`
            : "源文档在根目录（或目录解析失败），认领后不自动归档目录。"}
        </div>
      )}
      {!pendingRow && (
        <Field label="归档目录">
          <select
            value={targetFolder}
            onChange={(e) => setTargetFolder(e.target.value)}
          >
            <option value="">未归档（根目录）</option>
            {flattenFolders(secFolders).map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      {pendingRow && mergeCandidates.length > 0 && (
        <Field label="合并选项">
          <select
            value={mergeSel}
            onChange={(e) => setMergeSel(e.target.value)}
          >
            <option value="">新建条目</option>
            {mergeCandidates.map((c) => (
              <option key={c.sid} value={c.sid}>
                合并到《{c.name}》（本文档先前认领）
              </option>
            ))}
          </select>
          <div className="muted" style={{ fontSize: 12 }}>
            选择合并时，本次填写的字段只补齐该条目缺少的字段（旧密文自动归档
            历史版本），不再新建条目；本机比对，明文不出浏览器。
          </div>
        </Field>
      )}
      <Field label="名称 *">
        <input
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Redis 生产密码"
        />
      </Field>
      <div className="row">
        <Field label="项目">
          <input
            type="text"
            autoComplete="off"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
        </Field>
        <Field label="环境">
          <select value={env} onChange={(e) => setEnv(e.target.value)}>
            {ENV_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="标签（逗号分隔）">
        <input
          type="text"
          autoComplete="off"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </Field>
      <Field label="类型">
        <select
          value={tplId}
          onChange={(e) => setTplId(e.target.value as TemplateId)}
        >
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <div className="muted" style={{ fontSize: 12 }}>
          {templateById(tplId).desc}
        </div>
      </Field>
      {templateById(tplId).fields.map((f) => (
        <Field key={f.key} label={f.label}>
          {f.multiline ? (
            <textarea
              rows={4}
              autoComplete="off"
              value={content[f.key] ?? ""}
              onChange={(e) =>
                setContent({ ...content, [f.key]: e.target.value })
              }
              placeholder={f.placeholder ?? ""}
            />
          ) : (
            <input
              type="text"
              autoComplete="off"
              value={content[f.key] ?? ""}
              onChange={(e) =>
                setContent({ ...content, [f.key]: e.target.value })
              }
              placeholder={f.placeholder ?? ""}
            />
          )}
        </Field>
      ))}
      <Field label="备注">
        <textarea
          autoComplete="off"
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

function RecoverModal({
  docId,
  title,
  pendings,
  onClose,
}: {
  docId: string;
  title: string;
  pendings: PendingRow[];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const onFile = async (f: File | null) => {
    if (!f || busy) return;
    setBusy(true);
    try {
      const text = await f.text();
      const hits = scan(text);
      const rd = await api.get<{ text: string; project: string }>(
        `/documents/${docId}/redacted`,
      );
      const { pairs, total } = matchPendingsToLocal(rd.text, text, hits);
      const rows: CachedHit[] = [];
      for (const p of pendings) {
        const value = pairs.get(p.slug);
        if (value) {
          rows.push({
            slug: p.slug,
            kind: p.kind,
            value,
            title,
            project: rd.project ?? "",
          });
        }
      }
      if (rows.length) {
        savePrescanHits(rows, title, rd.project ?? "");
        const miss = total - rows.length;
        toast(
          `已回填 ${rows.length}/${total} 处${miss > 0 ? `（${miss} 处未配对）` : ""}，点"新建并认领"即可自动带入`,
        );
        onClose();
      } else {
        toastErr("未能配对：本机文件与上传时差异过大，请手工填写");
      }
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "回填失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`从本机原文回填《${title}》`} onClose={onClose}>
      <div className="secret-hint">
        选择上传时使用的<b>本机原始文件</b>
        ：本页重新扫描并把命中的真实值与文档里的
        占位符按上下文配对，回填到"新建并认领"表单。文件只在本机解析、不会上传；
        回填的值在提交前始终可见可改。
      </div>
      <input
        type="file"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = "";
          void onFile(f);
        }}
      />
      {busy && <Spinner />}
    </Modal>
  );
}

/* ================= 查看 / 共享 / 轮换 / 删除 ================= */

/* ================= 编辑条目（元数据 + 内容复用轮换通道） ================= */
function EditMetaModal({
  row,
  content,
  onRotate,
  onClose,
  onDone,
}: {
  row: SecretFull;
  content: SecretContent;
  onRotate: (c: SecretContent) => Promise<void>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(row.name);
  const [project, setProject] = useState(row.project ?? "");
  const [env, setEnv] = useState(row.env ?? "");
  const [tags, setTags] = useState((row.tags ?? []).join(", "));
  const [tplId, setTplId] = useState<TemplateId>(
    (content.type as TemplateId) || guessTemplate(content),
  );
  const [draft, setDraft] = useState<SecretContent>({ ...content });
  const [busy, setBusy] = useState(false);

  const sameContent = (a: SecretContent, b: SecretContent) =>
    (a.username ?? "") === (b.username ?? "") &&
    (a.password ?? "") === (b.password ?? "") &&
    (a.url ?? "") === (b.url ?? "") &&
    (a.tokens ?? "") === (b.tokens ?? "") &&
    (a.notes ?? "") === (b.notes ?? "");

  const save = async () => {
    if (!name.trim()) {
      toastErr("名称不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/secrets/${row.id}`, {
        name: name.trim(),
        project: project.trim(),
        env,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      // 内容有变化才走轮换通道（重新加密 + 换新 DEK + 旧密文自动归档为历史版本）
      const newContent = contentForTemplate(tplId, draft);
      if (!sameContent(content, newContent)) {
        await onRotate(newContent);
      }
      toast("已保存");
      onDone();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`编辑《${row.name}》`} onClose={busy ? () => {} : onClose}>
      <div className="secret-hint">
        名称/项目/环境/标签为明文元数据；备注与类型字段属加密内容，
        变更后旧密文自动归档为历史版本。
      </div>
      <Field label="名称 *">
        <input
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="row">
        <Field label="项目">
          <input
            type="text"
            autoComplete="off"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
        </Field>
        <Field label="环境">
          <select value={env} onChange={(e) => setEnv(e.target.value)}>
            {ENV_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="标签（逗号分隔）">
        <input
          type="text"
          autoComplete="off"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </Field>
      <Field label="类型">
        <select
          value={tplId}
          onChange={(e) => setTplId(e.target.value as TemplateId)}
        >
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      {templateById(tplId).fields.map((f) => (
        <Field key={f.key} label={f.label}>
          {f.multiline ? (
            <textarea
              rows={4}
              autoComplete="off"
              value={draft[f.key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              placeholder={f.placeholder ?? ""}
            />
          ) : (
            <input
              type="text"
              autoComplete="off"
              value={draft[f.key] ?? ""}
              onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              placeholder={f.placeholder ?? ""}
            />
          )}
        </Field>
      ))}
      <Field label="备注">
        <textarea
          autoComplete="off"
          value={draft.notes ?? ""}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </Field>
      <div className="toolbar">
        <Button kind="primary" disabled={busy} onClick={() => void save()}>
          {busy ? "保存中…" : "保存"}
        </Button>
        <Button kind="ghost" disabled={busy} onClick={onClose}>
          取消
        </Button>
      </div>
    </Modal>
  );
}

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
  const [confirming, setConfirming] = useState<null | {
    message: string;
    danger?: boolean;
    action: () => Promise<void>;
  }>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const [versionsText, setVersionsText] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // 敏感字段（密码/令牌）默认打码，按字段独立显隐
  const [showPwd, setShowPwd] = useState(false);
  const [showTok, setShowTok] = useState(false);
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
    await api.delete(`/secrets/${row.id}`);
    toast("已删除");
    onChanged();
  };

  const shareUsers = (targets?.users ?? []).filter(
    (u) => u.id !== myUserId && !(grants ?? []).some((g) => g.user_id === u.id),
  );

  let contentBody = <Spinner text="取回密文并本地解密…" />;
  if (content !== null) {
    const fields: {
      key: string;
      label: string;
      value: string;
      mono?: boolean;
      mask?: boolean;
      shown?: boolean;
      link?: boolean;
    }[] = [];
    if (content.type)
      fields.push({
        key: "type",
        label: "类型",
        value: templateById(content.type).label,
      });
    if (content.username)
      fields.push({
        key: "username",
        label: "用户名",
        value: content.username,
      });
    if (content.password)
      fields.push({
        key: "password",
        label: "密码",
        value: content.password,
        mono: true,
        mask: true,
        shown: showPwd,
      });
    if (content.url)
      fields.push({
        key: "url",
        label: "网址",
        value: content.url,
        link: true,
      });
    if (content.tokens)
      fields.push({
        key: "tokens",
        label: "令牌",
        value: content.tokens,
        mono: true,
        mask: true,
        shown: showTok,
      });
    contentBody = (
      <div className="sec-detail">
        <div className="sec-section">
          <div className="sec-section-title">字段</div>
          <div className="secret-fields">
            {fields.map((f) => (
              <div className="secret-field" key={f.key}>
                <span className="sf-label">{f.label}</span>
                <span className={`sf-value${f.mono ? " mono" : ""}`}>
                  {f.mask && !f.shown ? (
                    <span className="sf-masked">••••••••••••</span>
                  ) : f.link ? (
                    <a href={f.value} target="_blank" rel="noreferrer">
                      {f.value}
                    </a>
                  ) : (
                    f.value
                  )}
                </span>
                <span className="sf-actions">
                  {f.mask && (
                    <button
                      type="button"
                      className="sf-btn"
                      onClick={() =>
                        f.key === "password"
                          ? setShowPwd(!showPwd)
                          : setShowTok(!showTok)
                      }
                    >
                      {f.shown ? "隐藏" : "显示"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="sf-btn"
                    onClick={() => void copy(f.value, f.label)}
                  >
                    复制
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
        {content.notes && (
          <div className="sec-section">
            <div className="sec-section-title">备注</div>
            <div className="sec-notes">{content.notes}</div>
          </div>
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
          <Badge tone={row.env === "prod" ? "err" : "info"}>
            {envLabel(row.env)}
          </Badge>
        )}
        {row.project && <Badge>{row.project}</Badge>}
        {(row.tags ?? []).map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
        <span className="muted" style={{ fontSize: 12 }}>
          更新于 {new Date(row.updated_at).toLocaleString()}
        </span>
        <span style={{ flex: 1 }} />
        <Button onClick={() => void copy(JSON.stringify(content), "条目 JSON")}>
          复制 JSON
        </Button>
      </div>

      {contentBody}

      {isOwner && grants && (
        <div className="sec-section">
          <div className="sec-section-title">
            共享（{grants.length} 人有权访问）
          </div>
          <div className="share-chips">
            {grants.map((g) => (
              <span className="share-chip" key={g.user_id}>
                {g.display_name || g.username}
                {g.user_id === myUserId ? "（我）" : ""}
                {g.user_id !== myUserId && (
                  <button
                    type="button"
                    className="sf-btn danger"
                    onClick={() =>
                      setConfirming({
                        message:
                          "撤销后对方已看过的内容收不回来；敏感条目建议同时轮换真实密码。确定撤销？",
                        action: async () => {
                          await revoke(g.user_id);
                        },
                      })
                    }
                  >
                    撤销
                  </button>
                )}
              </span>
            ))}
          </div>
          {(shareUsers.length > 0 || (targets?.groups ?? []).length > 0) && (
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
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            撤销不回收已看过的内容；敏感条目建议同时轮换真实密码。
          </div>
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
          <Button
            onClick={() => {
              if (!content) {
                toastErr("先完成解密");
                return;
              }
              setEditing(true);
            }}
          >
            编辑（名称/环境/标签/备注等）
          </Button>
          <Button onClick={() => void showVersions()}>查看历史版本</Button>
          <Button
            onClick={() => {
              if (!content) {
                toastErr("先完成解密");
                return;
              }
              setRotating(content.password ?? "");
            }}
          >
            轮换（改内容 + 换新 DEK）
          </Button>
          <span style={{ flex: 1 }} />
          <Button
            kind="danger"
            onClick={() =>
              setConfirming({
                message: `删除条目《${row.name}》？历史版本一并删除。`,
                danger: true,
                action: async () => {
                  await remove();
                },
              })
            }
          >
            删除条目
          </Button>
        </div>
      )}
      {!isOwner && (
        <div className="secret-hint" style={{ marginTop: 14 }}>
          你是被共享方：可查看与复制；轮换/共享管理由条目所有者操作。
        </div>
      )}
      {editing && content && (
        <EditMetaModal
          row={row}
          content={content}
          onRotate={rotate}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
      {confirming && (
        <ConfirmModal
          title="确认操作"
          message={confirming.message}
          danger={confirming.danger}
          onOk={() => void confirming.action()}
          onClose={() => setConfirming(null)}
        />
      )}
      {rotating !== null && (
        <PromptModal
          title="轮换密码（改内容 + 换新 DEK）"
          label="新密码（轮换后请同步修改源头系统）"
          initial={rotating}
          okLabel="轮换并重授权"
          onOk={(v) => {
            if (!content) return;
            void (async () => {
              try {
                await rotate({ ...content, password: v });
              } catch (e) {
                toastErr(e instanceof Error ? e.message : "轮换失败");
              }
            })();
          }}
          onClose={() => setRotating(null)}
        />
      )}
      {versionsText !== null && (
        <Modal title="历史版本" onClose={() => setVersionsText(null)}>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
            {versionsText}
          </pre>
        </Modal>
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
    setVersionsText(lines.join("\n\n———\n\n") || "没有历史版本");
  }
}
