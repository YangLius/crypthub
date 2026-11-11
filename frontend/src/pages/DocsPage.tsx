/** 文档区：上传（客户端预扫 + 确认替换）、列表、元数据、待认领队列、多级目录归档。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { isTextLike, redactAll, scan, type Hit } from "../gates/redact";
import { savePrescanHits } from "../secrets/prescanCache";
import { toast, toastErr } from "../store";
import {
  Badge,
  Button,
  Empty,
  Field,
  Modal,
  Spinner,
  StatusBadge,
} from "../components/ui";
import {
  FolderPickerModal,
  FolderTree,
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
  const [moving, setMoving] = useState<Doc | null>(null);

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
      setScanning({ file, text, hits });
    } else {
      // pdf/docx 等二进制：直接上传，服务端兜底扫描（模式 B）
      await upload(file, false, []);
    }
  };

  const upload = async (
    file: File,
    clientRedacted: boolean,
    pendingItems: { slug: string; kind: string }[],
  ) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", meta.title);
      form.append("project", meta.project);
      form.append("tags", meta.tags);
      form.append("client_redacted", String(clientRedacted));
      form.append("folder_id", folder && folder !== "root" ? folder : "");
      const r = await api.form<{ id: string }>("/documents", form);
      if (pendingItems.length) {
        await api.post(`/documents/${r.id}/pending`, { items: pendingItems });
      }
      toast(
        clientRedacted
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
      await upload(scanning.file, false, []);
      return;
    }
    const rd = redactAll(scanning.text);
    // 命中原文只存本机 sessionStorage，供密钥区“新建并认领”时回填；绝不发给服务端
    savePrescanHits(rd.resolved, meta.title || scanning.file.name, meta.project);
    const redactedFile = new File([rd.text], scanning.file.name, {
      type: "text/plain",
      lastModified: scanning.file.lastModified,
    });
    await upload(redactedFile, true, rd.pending);
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
                          onClick={() => void editDoc(d)}
                        >
                          编辑
                        </Button>
                        <Button
                          kind="danger"
                          onClick={async () => {
                            if (
                              !window.confirm(
                                `删除《${d.title}》？片段与索引一并删除。`,
                              )
                            )
                              return;
                            await api.delete(`/documents/${d.id}`);
                            toast("已删除");
                            void refresh();
                          }}
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
        </div>
      </div>
    </div>
  );
}

async function editDoc(d: Doc) {
  const title = window.prompt("标题", d.title);
  if (title === null) return;
  const project = window.prompt("项目", d.project);
  if (project === null) return;
  const tags = window.prompt("标签（逗号分隔）", (d.tags ?? []).join(","));
  if (tags === null) return;
  await api.patch(`/documents/${d.id}`, {
    title,
    project,
    tags: tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  });
  toast("已更新");
  window.location.reload();
}
