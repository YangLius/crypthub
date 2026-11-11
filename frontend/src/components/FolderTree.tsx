/** 多级目录树：文档区（全局共享树）与密钥区（每人私有树）共用。
 *  选中值语义：null=显示全部；"root"=仅未归档；其余=目录 id。
 *  注意：涉及「null 是合法值」的状态一律用对象或 "root" 哨兵，禁止用
 *  `x !== undefined` 之类对 null 恒真的判断（见 SecretsPage 历史缺陷）。 */
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { toast, toastErr } from "../store";
import { Button, Modal } from "./ui";

export type FolderSel = string | null; // null=全部 / "root"=未归档 / uuid=目录

export interface Folder {
  id: string;
  parent_id: string | null;
  name: string;
}

export function useFolders(
  kind: "doc" | "secret",
  reloadKey: number,
): Folder[] {
  const [folders, setFolders] = useState<Folder[]>([]);
  useEffect(() => {
    let alive = true;
    api
      .get<{ folders: Folder[] }>(`/folders?kind=${kind}`)
      .then((r) => {
        if (alive) setFolders(r.folders);
      })
      .catch((e) => toastErr(e instanceof Error ? e.message : "目录加载失败"));
    return () => {
      alive = false;
    };
  }, [kind, reloadKey]);
  return folders;
}

interface FlatItem {
  id: string;
  label: string;
}

export function flattenFolders(folders: Folder[]): FlatItem[] {
  const byParent = new Map<string, Folder[]>();
  for (const f of folders) {
    const key = f.parent_id ?? "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(f);
  }
  const out: FlatItem[] = [];
  const walk = (parent: string, depth: number) => {
    for (const f of byParent.get(parent) ?? []) {
      const indent = "　".repeat(depth);
      out.push({ id: f.id, label: `${indent}${depth ? "└ " : ""}${f.name}` });
      walk(f.id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/** id → 完整路径（"父/子"），供列表行显示所在目录；防环。 */
export function folderPaths(folders: Folder[]): Map<string, string> {
  const byId = new Map<string, Folder>();
  for (const f of folders) byId.set(f.id, f);
  const out = new Map<string, string>();
  for (const f of folders) {
    const parts: string[] = [f.name];
    const seen = new Set<string>([f.id]);
    let p = f.parent_id;
    while (p && byId.has(p) && !seen.has(p)) {
      seen.add(p);
      parts.unshift(byId.get(p)!.name);
      p = byId.get(p)!.parent_id;
    }
    out.set(f.id, parts.join("/"));
  }
  return out;
}

interface FolderTreeProps {
  kind: "doc" | "secret";
  selected: FolderSel;
  onSelect: (sel: FolderSel) => void;
  reloadKey: number;
  onMutate: () => void;
  rootLabel?: string; // 提供「未归档」项的文案则显示该过滤项
}

export function FolderTree({
  kind,
  selected,
  onSelect,
  reloadKey,
  onMutate,
  rootLabel,
}: FolderTreeProps) {
  const folders = useFolders(kind, reloadKey);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // {parentId} 包一层避免「null 合法值 + !== undefined」陷阱
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(
    null,
  );
  const [newName, setNewName] = useState("");

  const toggle = (id: string) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const childrenOf = (parent: string | null) =>
    folders.filter((f) => (f.parent_id ?? null) === parent);

  const submitCreate = async () => {
    if (!creating) return;
    const name = newName.trim();
    if (!name) {
      setCreating(null);
      return;
    }
    try {
      await api.post("/folders", {
        kind,
        name,
        parent_id: creating.parentId,
      });
      if (creating.parentId) toggle(creating.parentId);
      toast("目录已创建");
      onMutate();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "创建失败");
    } finally {
      setCreating(null);
      setNewName("");
    }
  };

  const renameFolder = async (f: Folder) => {
    const name = window.prompt("新的目录名", f.name);
    if (name === null || name.trim() === "" || name === f.name) return;
    try {
      await api.patch(`/folders/${f.id}`, {
        name: name.trim(),
        parent_id: f.parent_id,
      });
      onMutate();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "重命名失败");
    }
  };

  const removeFolder = async (f: Folder) => {
    if (
      !window.confirm(
        `删除目录「${f.name}」？\n子目录将一并删除，其中的内容回到未归档状态。`,
      )
    )
      return;
    try {
      await api.delete(`/folders/${f.id}`);
      if (selected === f.id) onSelect(null);
      toast("目录已删除");
      onMutate();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "删除失败");
    }
  };

  const renderNode = (f: Folder, depth: number) => {
    const kids = childrenOf(f.id);
    const expanded = open.has(f.id) || kids.length === 0;
    return (
      <div key={f.id}>
        <div
          className={`folder-row${selected === f.id ? " active" : ""}`}
          style={{ paddingLeft: depth * 14 }}
        >
          {kids.length > 0 && (
            <button
              type="button"
              className="folder-caret"
              onClick={() => toggle(f.id)}
              title="展开/折叠"
            >
              {expanded ? "▾" : "▸"}
            </button>
          )}
          <button
            type="button"
            className="folder-name"
            onClick={() => onSelect(f.id)}
            title={`进入目录 ${f.name}`}
          >
            📁 {f.name}
          </button>
          <span className="folder-actions">
            <button
              type="button"
              className="folder-act"
              title="新建子目录"
              onClick={() => {
                setCreating({ parentId: f.id });
                setNewName("");
              }}
            >
              ＋
            </button>
            <button
              type="button"
              className="folder-act"
              title="重命名"
              onClick={() => void renameFolder(f)}
            >
              ✎
            </button>
            <button
              type="button"
              className="folder-act"
              title="删除"
              onClick={() => void removeFolder(f)}
            >
              ✕
            </button>
          </span>
        </div>
        {expanded && kids.map((k) => renderNode(k, depth + 1))}
        {creating?.parentId === f.id && renderCreateInput(depth + 1)}
      </div>
    );
  };

  const renderCreateInput = (depth: number) => (
    <div className="folder-row" style={{ paddingLeft: depth * 14 }}>
      <input
        type="text"
        autoFocus
        className="folder-new-input"
        placeholder="目录名，回车确认"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submitCreate();
          if (e.key === "Escape") {
            setCreating(null);
            setNewName("");
          }
        }}
      />
    </div>
  );

  return (
    <div className="folder-panel">
      <div className="folder-panel-head">
        <span className="muted">目录</span>
        <Button
          kind="ghost"
          onClick={() => {
            setCreating({ parentId: null });
            setNewName("");
          }}
        >
          ＋ 新建根目录
        </Button>
      </div>
      {creating?.parentId === null && renderCreateInput(0)}
      <div className={`folder-row${selected === null ? " active" : ""}`}>
        <button
          type="button"
          className="folder-name"
          onClick={() => onSelect(null)}
        >
          🗂 全部
        </button>
      </div>
      {rootLabel && (
        <div className={`folder-row${selected === "root" ? " active" : ""}`}>
          <button
            type="button"
            className="folder-name"
            onClick={() => onSelect("root")}
          >
            📄 {rootLabel}
          </button>
        </div>
      )}
      {childrenOf(null).map((f) => renderNode(f, 0))}
    </div>
  );
}

export function FolderPickerModal({
  kind,
  onClose,
  onPick,
}: {
  kind: "doc" | "secret";
  onClose: () => void;
  onPick: (folderId: string | null) => void; // null = 根目录（未归档）
}) {
  const folders = useFolders(kind, 0);
  const flat = flattenFolders(folders);
  return (
    <Modal title="移动到目录" onClose={onClose}>
      <div className="folder-pick-list">
        <button
          type="button"
          className="folder-item"
          onClick={() => onPick(null)}
        >
          📄 根目录（未归档）
        </button>
        {flat.map((f) => (
          <button
            key={f.id}
            type="button"
            className="folder-item"
            onClick={() => onPick(f.id)}
          >
            📁 {f.label}
          </button>
        ))}
        {flat.length === 0 && (
          <div className="muted" style={{ padding: 8 }}>
            还没有目录，可先在左侧目录面板创建。
          </div>
        )}
      </div>
    </Modal>
  );
}
