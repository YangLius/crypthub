/** 基础 UI 组件：Modal / Button / Field / Badge / 空态。
 *  全部基于 Astryx 设计系统（@astryxdesign/core）封装，保持项目既有 props 兼容；
 *  新页面开发请直接使用 Astryx 组件（见 AGENTS.md），本文件仅作迁移兼容层。 */
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { Button as AButton } from "@astryxdesign/core/Button";
import { Badge as ABadge } from "@astryxdesign/core/Badge";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Field as AField } from "@astryxdesign/core/Field";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Spinner as ASpinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";

/** ReactNode → 纯文本（用作 Astryx Button 的无障碍 label）。 */
function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (typeof node === "object" && "props" in (node as never)) {
    return flattenText(
      (node as { props: { children?: ReactNode } }).props?.children,
    );
  }
  return "";
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "danger" | "default";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const variant = BADGE_VARIANT[props.kind ?? "default"];
  return (
    <AButton
      label={flattenText(props.children) || props.title || "按钮"}
      variant={variant}
      type={props.type ?? "button"}
      isDisabled={props.disabled}
      tooltip={props.title}
      onClick={props.onClick}
    >
      {props.children}
    </AButton>
  );
}

export function Field(props: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <AField label={props.label} inputID={id} description={props.hint}>
      {props.children}
    </AField>
  );
}

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      width={props.wide ? 760 : 520}
      purpose="info"
    >
      <DialogHeader title={props.title} onOpenChange={props.onClose} />
      {/* Astryx 面板是 height:fit-content 无高度约束，高内容会溢出屏幕；
          包一层限高滚动容器让面板始终在视口内（认领/导入等高弹窗底部被截断的修复） */}
      <div className="modal-scroll">{props.children}</div>
    </Dialog>
  );
}

export function Badge(props: {
  children: ReactNode;
  tone?: "ok" | "warn" | "err" | "info";
}) {
  const variant = TONE_VARIANT[props.tone ?? "info"];
  return <ABadge variant={variant} label={props.children} />;
}

const BADGE_VARIANT = {
  primary: "primary",
  ghost: "ghost",
  danger: "destructive",
  default: "secondary",
} as const;

const TONE_VARIANT = {
  ok: "success",
  warn: "warning",
  err: "error",
  info: "info",
} as const;

const STATUS_TONE: Record<string, "ok" | "err" | "warn"> = {
  ready: "ok",
  failed: "err",
  processing: "warn",
};

const STATUS_LABEL: Record<string, string> = {
  ready: "已就绪",
  failed: "失败",
  processing: "处理中",
};

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "warn";
  return <Badge tone={tone}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function Empty({ text }: { text: string }) {
  return <EmptyState title={text} isCompact />;
}

export function Spinner({ text = "加载中…" }: { text?: string }) {
  return (
    <div className="center-row">
      <ASpinner size="lg" label={text} />
    </div>
  );
}

export function SecretHint({ children }: { children: ReactNode }) {
  return <div className="secret-hint">{children}</div>;
}

/** 应用内确认框（替代 window.confirm——原生对话框可被浏览器禁用导致静默无响应）。 */
export function ConfirmModal(props: {
  title: string;
  message: string;
  danger?: boolean;
  okLabel?: string;
  onOk: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <div style={{ whiteSpace: "pre-wrap", marginBlockEnd: 14 }}>
        {props.message}
      </div>
      <Button
        kind={props.danger ? "danger" : "primary"}
        onClick={() => {
          props.onOk();
          props.onClose();
        }}
      >
        {props.okLabel ?? "确认"}
      </Button>{" "}
      <Button kind="ghost" onClick={props.onClose}>
        取消
      </Button>
    </Modal>
  );
}

/** 应用内单字段输入框（替代 window.prompt，同上原因）。 */
export function PromptModal(props: {
  title: string;
  label: string;
  initial?: string;
  multiline?: boolean;
  placeholder?: string;
  allowEmpty?: boolean;
  okLabel?: string;
  onOk: (value: string) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState(props.initial ?? "");
  const ok = () => {
    const t = v.trim();
    if (!t && !props.allowEmpty) return;
    props.onOk(t);
    props.onClose();
  };
  return (
    <Modal title={props.title} onClose={props.onClose}>
      {props.multiline ? (
        <TextArea
          label={props.label}
          value={v}
          onChange={setV}
          placeholder={props.placeholder ?? ""}
          rows={4}
        />
      ) : (
        <TextInput
          label={props.label}
          value={v}
          onChange={setV}
          placeholder={props.placeholder ?? ""}
          onEnter={ok}
        />
      )}
      <div style={{ marginBlockStart: 14 }}>
        <Button
          kind="primary"
          disabled={!props.allowEmpty && !v.trim()}
          onClick={ok}
        >
          {props.okLabel ?? "确定"}
        </Button>{" "}
        <Button kind="ghost" onClick={props.onClose}>
          取消
        </Button>
      </div>
    </Modal>
  );
}
