/** 文档区：上传（客户端预扫 + 确认替换）、列表、元数据、待认领队列、多级目录归档。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { isTextLike, redactAll, scan, type Hit } from "../gates/redact";
import { savePrescanHits, peekPrescanHit } from "../secrets/prescanCache";
import { urlHintsFromText } from "../secrets/prescanCache";
import { openSecret, unlockVault, type SecretContent } from "../crypto/flows";
import { useApp } from "../store";
import { toast, toastErr } from "../store";
import {
  Badge,
  Button,
  ConfirmModal,
  Empty,
  Field,
  Modal,
  SecretHint,
  Spinner,
  StatusBadge,
} from "../components/ui";
import {
  FolderPickerModal,
  FolderTree,
  flattenFolders,
  folderPaths,
  useFolders,
  type FolderSel,
} from "../components/FolderTree";

interface Doc {
  id: string;
  title: string;
  filename: string;
  project: string;
  tags: string[];
  status: string;
  error: string | null;
  chunk_count: number;
  secret_ref: string | null;
  folder_id: string | null;
  uploader: string;
  created_at: string;
}
interface PendingRow {
  id: string;
  slug: string;
  kind: string;
  source_hint: string;
  status: string;
  doc_title: string | null;
}

export default function DocsPage() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [q, setQ] = useState("");
  const [project, setProject] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // 多级目录
  const [folder, setFolder] = useState<FolderSel>(null);
  const [folderKey, setFolderKey] = useState(0);
  const folders = useFolders("doc", folderKey);
  const folderPathMap = folderPaths(folders);
  // 上传目标目录（uuid；空串=未归档）：弹窗内可选，默认跟随左侧目录树当前选中
  const [targetFolder, setTargetFolder] = useState("");
  const [confirming, setConfirming] = useState<null | {
    message: string;
    action: () => Promise<void>;
  }>(null);
  const [editing, setEditing] = useState<Doc | null>(null);
  const [moving, setMoving] = useState<Doc | null>(null);
  const [viewing, setViewing] = useState<Doc | null>(null);

  // 上传向导状态
  const [scanning, setScanning] = useState<{
    file: File;
    text: string;
    hits: Hit[];
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [meta, setMeta] = useState({ title: "", project: "", tags: "" });

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ documents: Doc[] }>(
        `/documents?${new URLSearchParams({ ...(project ? { project } : {}) })}`,
      );
      setDocs(r.documents);
      const p = await api.get<{ pending: PendingRow[] }>("/documents/pending");
      setPending(p.pending);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "加载失败");
    }
  }, [project]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // 处理中的文档每 3 秒轮询状态
  useEffect(() => {
    if (!docs?.some((d) => d.status === "processing")) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [docs, refresh]);

  const onPick = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      toastErr("文件超过 50MB 限制");
      return;
    }
    setMeta({ title: file.name.replace(/\.[^.]+$/, ""), project, tags: "" });
    if (isTextLike(file.name, file.type)) {
      const text = await file.text();
      const hits = scan(text);
      // 弹窗内可选目标目录，默认跟随左侧目录树当前选中（"root"/null → 未归档）
      setTargetFolder(folder && folder !== "root" ? folder : "");
      setScanning({ file, text, hits });
    } else {
      // pdf/docx 等二进制：直接上传，服务端兜底扫描（模式 B）
      await upload(file, false, [], folder && folder !== "root" ? folder : "");
    }
  };

  const upload = async (
    file: File,
    clientRedacted: boolean,
    pendingItems: { slug: string; kind: string }[],
    folderId: string,
  ) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", meta.title);
      form.append("project", meta.project);
      form.append("tags", meta.tags);
      form.append("client_redacted", String(clientRedacted));
      form.append("folder_id", folderId);
      const r = await api.form<{ id: string; updated?: boolean }>(
        "/documents",
        form,
      );
      if (pendingItems.length) {
        await api.post(`/documents/${r.id}/pending`, { items: pendingItems });
      }
      toast(
        r.updated
          ? clientRedacted
            ? `文档已存在，已更新并重建索引（本次替换 ${pendingItems.length} 处疑似凭据，可到下方"待认领"存入密钥区）`
            : "文档已存在，已更新内容并重建索引"
          : clientRedacted
            ? `已上传（已替换 ${pendingItems.length} 处疑似凭据，可到下方"待认领"存入密钥区）`
            : "已上传，服务端解析后建立索引",
      );
      setScanning(null);
      await refresh();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const confirmRedact = async (replace: boolean) => {
    if (!scanning) return;
    if (!replace) {
      // 不替换直接上传原文（仍会过服务端兜底）
      await upload(scanning.file, false, [], targetFolder);
      return;
    }
    const rd = redactAll(scanning.text);
    // 命中原文只存本机 sessionStorage，供密钥区“新建并认领”时回填；绝不发给服务端
    // 同一 zip 记录每个命中附近的网址线索（成对凭据 → 「网站」类型 + 预填 URL）
    savePrescanHits(
      rd.resolved,
      meta.title || scanning.file.name,
      meta.project,
      urlHintsFromText(
        scanning.text,
        scanning.hits.map((h, i) => ({
          start: h.start,
          end: h.end,
          slug: rd.resolved[i]?.slug ?? "",
        })),
      ),
    );
    const redactedFile = new File([rd.text], scanning.file.name, {
      type: "text/plain",
      lastModified: scanning.file.lastModified,
    });
    await upload(redactedFile, true, rd.pending, targetFolder);
  };

  const filtered = (docs ?? []).filter(
    (d) =>
      (!q ||
        d.title.toLowerCase().includes(q.toLowerCase()) ||
        d.project.includes(q)) &&
      (folder === null ||
        (folder === "root" ? !d.folder_id : d.folder_id === folder)),
  );

  const moveDoc = async (d: Doc, target: string | null) => {
    try {
      await api.patch(`/documents/${d.id}`, {
        folder_id: target ?? "root", // null=移回根；发 "root" 哨兵
      });
      toast(target ? "已移动" : "已移回未归档");
      setMoving(null);
      await refresh();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "移动失败");
    }
  };

  return (
    <div>
      <div className="page-head">
        <h2>文档知识库</h2>
        <Button kind="primary" onClick={() => fileRef.current?.click()}>
          上传文档
        </Button>
        <input
          ref={fileRef}
          type="file"
          hidden
          accept=".md,.markdown,.txt,.csv,.tsv,.log,.json,.yaml,.yml,.toml,.ini,.conf,.py,.js,.ts,.jsx,.tsx,.go,.rs,.java,.kt,.c,.h,.cpp,.hpp,.cs,.rb,.php,.sh,.bat,.ps1,.sql,.html,.css,.xml,.env,.pdf,.docx"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
            e.target.value = "";
          }}
        />
      </div>

      <div className="with-folder-panel">
        <FolderTree
          kind="doc"
          selected={folder}
          onSelect={setFolder}
          reloadKey={folderKey}
          onMutate={() => setFolderKey((k) => k + 1)}
          rootLabel="未归档"
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="toolbar">
              <input
                type="text"
                placeholder="按标题/项目过滤"
                value={q}
                style={{ width: 220 }}
                onChange={(e) => setQ(e.target.value)}
              />
              <input
                type="text"
                placeholder="项目"
                value={project}
                style={{ width: 140 }}
                onChange={(e) => setProject(e.target.value)}
              />
              <Button onClick={() => void refresh()}>刷新</Button>
              <span className="muted" style={{ fontSize: 12 }}>
                上传前系统会在浏览器里扫描疑似凭据（sk- / 连接串 / password= /
                高熵串），由你确认替换后才会离开本机。
              </span>
            </div>

            {docs === null ? (
              <Spinner />
            ) : filtered.length === 0 ? (
              <Empty text="还没有文档" />
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>标题</th>
                    <th>目录</th>
                    <th>项目</th>
                    <th>标签</th>
                    <th>状态</th>
                    <th>分块</th>
                    <th>上传者</th>
                    <th>关联凭据</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.id}>
                      <td>
                        {d.title}
                        {d.status === "failed" && (
                          <div className="muted" style={{ fontSize: 12 }}>
                            {d.error}
                          </div>
                        )}
                      </td>
                      <td>
                        <span
                          style={{
                            cursor: "pointer",
                            textDecoration: "underline dotted",
                          }}
                          title="点击筛选该目录"
                          onClick={() => setFolder(d.folder_id ?? "root")}
                        >
                          {d.folder_id
                            ? (folderPathMap.get(d.folder_id) ?? "—")
                            : "根目录"}
                        </span>
                      </td>
                      <td>{d.project || "—"}</td>
                      <td>{(d.tags ?? []).join("、") || "—"}</td>
                      <td>
                        <StatusBadge status={d.status} />
                      </td>
                      <td>{d.chunk_count}</td>
                      <td>{d.uploader}</td>
                      <td>
                        {d.secret_ref ? <Badge tone="info">已关联</Badge> : "—"}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {d.status === "ready" && (
                          <Button
                            kind="ghost"
                            title="在线查看正文（已脱敏安全文本）"
                            onClick={() => setViewing(d)}
                          >
                            查看
                          </Button>
                        )}
                        <Button
                          kind="ghost"
                          title="重新解析建索引"
                          onClick={async () => {
                            await api.post(`/documents/${d.id}/reindex`);
                            toast("已重新排队");
                            void refresh();
                          }}
                        >
                          重建索引
                        </Button>
                        <Button
                          kind="ghost"
                          title="移动到目录"
                          onClick={() => setMoving(d)}
                        >
                          移动
                        </Button>
                        <Button
                          kind="ghost"
                          title="编辑元数据"
                          onClick={() => setEditing(d)}
                        >
                          编辑
                        </Button>
                        <Button
                          kind="danger"
                          onClick={() =>
                            setConfirming({
                              message: `删除《${d.title}》？片段与索引一并删除。`,
                              action: async () => {
                                await api.delete(`/documents/${d.id}`);
                                toast("已删除");
                                await refresh();
                              },
                            })
                          }
                        >
                          删除
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {pending.length > 0 && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>
                待认领的占位符（真实值只在你上传时的浏览器里）
              </h3>
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
                        <Link to="/secrets">去密钥区创建条目 →</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {scanning && (
            <Modal
              title={`扫描到 ${scanning.hits.length} 处疑似凭据`}
              wide
              onClose={() => setScanning(null)}
            >
              <Field label={`文档：${scanning.file.name}`}>
                {scanning.hits.length === 0 ? (
                  <span className="muted">未发现疑似凭据，可直接上传。</span>
                ) : (
                  <div>
                    {scanning.hits.map((h, i) => (
                      <div className="hit-row" key={i}>
                        <Badge tone="warn">{h.kind}</Badge>
                        <span className="hit-value">
                          {h.value.slice(0, 120)}
                          {h.value.length > 120 ? "…" : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Field>
              <Field label="归档目录">
                <select
                  value={targetFolder}
                  onChange={(e) => setTargetFolder(e.target.value)}
                >
                  <option value="">未归档（根目录）</option>
                  {flattenFolders(folders).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="标题">
                <input
                  type="text"
                  value={meta.title}
                  onChange={(e) => setMeta({ ...meta, title: e.target.value })}
                />
              </Field>
              <div className="row">
                <Field label="项目">
                  <input
                    type="text"
                    value={meta.project}
                    onChange={(e) =>
                      setMeta({ ...meta, project: e.target.value })
                    }
                  />
                </Field>
                <Field label="标签（逗号分隔）">
                  <input
                    type="text"
                    value={meta.tags}
                    onChange={(e) => setMeta({ ...meta, tags: e.target.value })}
                  />
                </Field>
              </div>
              <div className="secret-hint">
                替换后原文中的凭据会变成 <code>{"{{secret:…}}"}</code> 占位符；
                真实值不会上传，可在上传后"送入密钥区"加密保存。
              </div>
              <div className="toolbar">
                {scanning.hits.length > 0 && (
                  <Button
                    kind="primary"
                    disabled={uploading}
                    onClick={() => void confirmRedact(true)}
                  >
                    {uploading
                      ? "上传中…"
                      : `替换 ${scanning.hits.length} 处并上传`}
                  </Button>
                )}
                <Button
                  disabled={uploading}
                  onClick={() => void confirmRedact(false)}
                >
                  不替换直接上传（服务端仍会兜底扫描）
                </Button>
                <Button
                  kind="ghost"
                  disabled={uploading}
                  onClick={() => setScanning(null)}
                >
                  取消
                </Button>
              </div>
            </Modal>
          )}

          {moving && (
            <FolderPickerModal
              kind="doc"
              onClose={() => setMoving(null)}
              onPick={(target) => void moveDoc(moving, target)}
            />
          )}

          {confirming && (
            <ConfirmModal
              title="确认删除"
              message={confirming.message}
              danger={true}
              onOk={() => void confirming.action()}
              onClose={() => setConfirming(null)}
            />
          )}
          {editing && (
            <EditDocModal
              doc={editing}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                void refresh();
              }}
            />
          )}
          {viewing && (
            <ViewDocModal doc={viewing} onClose={() => setViewing(null)} />
          )}
        </div>
      </div>
    </div>
  );
}

function EditDocModal({
  doc,
  onClose,
  onSaved,
}: {
  doc: Doc;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(doc.title);
  const [project, setProject] = useState(doc.project);
  const [tags, setTags] = useState((doc.tags ?? []).join(","));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/documents/${doc.id}`, {
        title,
        project,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      toast("已更新");
      onSaved();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`编辑《${doc.title}》`} onClose={onClose}>
      <Field label="标题 *">
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="项目">
        <input value={project} onChange={(e) => setProject(e.target.value)} />
      </Field>
      <Field label="标签（逗号分隔）">
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
      <Button
        kind="primary"
        disabled={busy || !title.trim()}
        onClick={() => void save()}
      >
        保存
      </Button>
    </Modal>
  );
}

/** 在线查看文档正文：由索引分块拼接的已脱敏安全文本，非原始文件下载。 */
/* ---------- 占位符回显辅助 ---------- */

const FIELD_LABELS: Record<string, string> = {
  username: "用户名",
  password: "密码",
  url: "网址",
  tokens: "令牌",
};

/** 从占位符所在行的前置上下文推断字段：
 *  "密码：{{secret:x}}" → password（取同行占位符前最近的标签）。 */
function fieldFromContext(text: string, at: number): string | null {
  if (at < 0) return null;
  const lineStart = text.lastIndexOf("\n", at) + 1;
  const seg = text.slice(lineStart, at);
  const rules: [RegExp, string][] = [
    [/用户名|账号|帐号|user(?:name)?\s*[:：=＝]/i, "username"],
    [/密码|口令|pass(?:word|wd)?\s*[:：=＝]|\bpwd\b/i, "password"],
    [/网址|域名|站点|网站|链接|\burl\b/i, "url"],
    [/秘钥|密钥|令牌|token|api[_-]?key|access[_-]?key/i, "tokens"],
  ];
  let best: { idx: number; field: string } | null = null;
  for (const [re, field] of rules) {
    const m = seg.match(re);
    if (m && m.index !== undefined && (!best || m.index > best.idx)) {
      best = { idx: m.index, field };
    }
  }
  return best?.field ?? null;
}

/** 从解密后的密钥内容中取出占位符对应的值：
 *  字段明确 → 直接取；否则唯一非空字段；再否则按 密码>令牌>用户名>网址 取。 */
function pickValue(c: SecretContent, field: string | null): string {
  const get = (k: string) => (c as Record<string, string | undefined>)[k] ?? "";
  if (field && get(field)) return get(field);
  const order = ["password", "tokens", "username", "url"];
  const populated = order.filter((k) => get(k));
  if (populated.length === 1) return get(populated[0]);
  for (const k of order) if (get(k)) return get(k);
  return "";
}

function ViewDocModal({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const { me, vault, setVault } = useApp();
  const [data, setData] = useState<{
    text: string;
    truncated: boolean;
    chunk_count: number;
  } | null>(null);
  const [err, setErr] = useState("");
  // 占位符回显：slug -> 本机解密出的原值（仅内存，绝不上传）
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [phLabels, setPhLabels] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const [mp, setMp] = useState("");
  const [uBusy, setUBusy] = useState(false);
  const [uErr, setUErr] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .get<{
        text: string;
        truncated: boolean;
        chunk_count: number;
      }>(`/documents/${doc.id}/view`)
      .then((r) => {
        if (alive) setData(r);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : "读取失败");
      });
    return () => {
      alive = false;
    };
  }, [doc.id]);

  const phSlugs = useMemo(() => {
    if (!data) return [] as string[];
    return [
      ...new Set(
        [...data.text.matchAll(/\{\{secret:([0-9a-f]+)\}\}/g)].map((m) => m[1]),
      ),
    ];
  }, [data]);

  // 解析占位符原值：① 本机预扫缓存（上传同一标签页）② 服务端 slug→已认领密钥
  //   映射 + reveal 本地解密（需已解锁）。解密/回显全部在浏览器完成。
  useEffect(() => {
    if (!data || !phSlugs.length || !me) return;
    let alive = true;
    void (async () => {
      const vals: Record<string, string> = {};
      const labels: Record<string, string> = {};
      // 层①：本机预扫缓存（含未认领的占位符）
      for (const s of phSlugs) {
        const hit = peekPrescanHit(s);
        if (hit?.value) {
          vals[s] = hit.value;
          labels[s] = hit.kind === "kv" ? "预扫命中" : "预扫命中";
        }
      }
      // 层②：已认领占位符 → 密钥条目本机解密（需解锁）
      const missing = phSlugs.filter((s) => !vals[s]);
      if (missing.length && vault) {
        try {
          const r = await api.get<{
            placeholders: {
              slug: string;
              status: string;
              secret_id: string | null;
            }[];
          }>(`/documents/${doc.id}/placeholders`);
          const bySecret = new Map<string, string[]>();
          for (const p of r.placeholders) {
            if (p.secret_id && missing.includes(p.slug)) {
              const arr = bySecret.get(p.secret_id) ?? [];
              arr.push(p.slug);
              bySecret.set(p.secret_id, arr);
            }
          }
          for (const [sid, slugs] of bySecret) {
            const rr = await api.get<{
              content_ct: string;
              wrapped_dek: string;
            }>(`/secrets/${sid}/reveal`);
            const content = openSecret(
              vault,
              rr.wrapped_dek,
              rr.content_ct,
              sid,
              me.user_id,
            );
            // 旧版文档的占位符吃掉了行内标签，无法从上下文推断字段——
            // 按「用户名在前、密码在后」的配对顺序兜底
            const ordered = [...slugs].sort(
              (a, b) =>
                data.text.indexOf(`{{secret:${a}}}`) -
                data.text.indexOf(`{{secret:${b}}}`),
            );
            for (const s of ordered) {
              const at = data.text.indexOf(`{{secret:${s}}}`);
              let field = fieldFromContext(data.text, at);
              if (
                !field &&
                ordered.length >= 2 &&
                content.username &&
                content.password
              ) {
                field = s === ordered[0] ? "username" : "password";
              }
              const v = pickValue(content, field);
              if (v) {
                vals[s] = v;
                labels[s] = field ? FIELD_LABELS[field] : "密钥值";
              }
            }
          }
        } catch {
          // 回显是锦上添花：静默降级，占位符保持原样
        }
      }
      if (alive && Object.keys(vals).length) {
        setResolved((prev) => ({ ...prev, ...vals }));
        setPhLabels((prev) => ({ ...prev, ...labels }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [data, vault, me, doc.id, phSlugs]);

  const doUnlock = async () => {
    if (!me?.salt_enc || !mp) {
      if (!mp) setUErr("请输入主密码");
      return;
    }
    setUBusy(true);
    setUErr("");
    try {
      const v = await unlockVault(mp, {
        user_id: me.user_id,
        salt_enc: me.salt_enc,
        local_check_ct: me.local_check_ct!,
        priv_wrapped: me.priv_wrapped!,
      });
      await api.post("/secrets/unlock");
      setVault(v);
      setUnlocking(false);
      setMp("");
    } catch (e) {
      setUErr(e instanceof Error ? e.message : "解锁失败：主密码不正确？");
    } finally {
      setUBusy(false);
    }
  };

  const copyPh = async (s: string) => {
    await navigator.clipboard.writeText(resolved[s] ?? "");
    toast("已复制");
  };

  // 占位符拆段：普通文本 vs {{secret:slug}} 占位符
  const segments = useMemo(() => {
    if (!data) return null;
    const parts: { t: string; slug?: string }[] = [];
    const re = /\{\{secret:([0-9a-f]+)\}\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(data.text))) {
      if (m.index > last) parts.push({ t: data.text.slice(last, m.index) });
      parts.push({ t: m[0], slug: m[1] });
      last = m.index + m[0].length;
    }
    if (last < data.text.length) parts.push({ t: data.text.slice(last) });
    return parts;
  }, [data]);

  const resolvedCount = phSlugs.filter((s) => resolved[s]).length;

  return (
    <Modal title={`查看 · ${doc.title}`} onClose={onClose} wide>
      {err && <SecretHint>{err}</SecretHint>}
      {!err && !data && <Spinner text="加载正文…" />}
      {data && (
        <div className="doc-view">
          {phSlugs.length > 0 && (
            <div className="ph-toolbar">
              <Badge tone={resolvedCount ? "ok" : "warn"}>
                🔑 {phSlugs.length} 处密钥占位符
              </Badge>
              {vault ? (
                <label className="ph-toggle">
                  <input
                    type="checkbox"
                    checked={showSecrets}
                    onChange={(e) => setShowSecrets(e.target.checked)}
                  />
                  回显原值（本机解密，不上传）
                </label>
              ) : unlocking ? (
                <span className="ph-unlock">
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder="主密码"
                    value={mp}
                    onChange={(e) => setMp(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void doUnlock();
                    }}
                  />
                  <Button
                    kind="primary"
                    disabled={uBusy}
                    onClick={() => void doUnlock()}
                  >
                    {uBusy ? "派生中…" : "解锁并回显"}
                  </Button>
                  <Button kind="ghost" onClick={() => setUnlocking(false)}>
                    取消
                  </Button>
                </span>
              ) : (
                <Button kind="primary" onClick={() => setUnlocking(true)}>
                  🔓 输入主密码查看原值
                </Button>
              )}
              {resolvedCount > 0 && resolvedCount < phSlugs.length && (
                <span className="muted" style={{ fontSize: 12 }}>
                  {phSlugs.length - resolvedCount}{" "}
                  处未认领或本机无缓存，保持占位符
                </span>
              )}
            </div>
          )}
          {uErr && (
            <div className="blocked-banner" style={{ marginBottom: 8 }}>
              {uErr}
            </div>
          )}
          {data.truncated && (
            <SecretHint>内容过长，仅显示前 50 万字符。</SecretHint>
          )}
          <pre className="doc-view-text">
            {segments?.map((p, i) => {
              if (!p.slug) return <span key={i}>{p.t}</span>;
              const v = showSecrets ? resolved[p.slug] : undefined;
              if (v) {
                return (
                  <span
                    key={i}
                    className="ph-val"
                    title={`${phLabels[p.slug] ?? "密钥值"}（本机解密回显，点击复制）`}
                    onClick={() => void copyPh(p.slug!)}
                  >
                    {v}
                  </span>
                );
              }
              return (
                <span key={i} className="ph-mark" title="未解锁或未认领">
                  {p.t}
                </span>
              );
            })}
          </pre>
        </div>
      )}
    </Modal>
  );
}
