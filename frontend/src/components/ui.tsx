/** 基础 UI 组件：Modal / Button / Field / Badge / 空态。 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "danger" | "default";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const { kind = "default", ...rest } = props;
  void kind;
  return <button className={`btn btn-${props.kind ?? "default"}`} {...rest} />;
}

export function Field(props: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
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
    <div
      className="modal-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className={`modal ${props.wide ? "modal-wide" : ""}`}>
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button
            className="btn btn-ghost"
            onClick={props.onClose}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

export function Badge(props: {
  children: ReactNode;
  tone?: "ok" | "warn" | "err" | "info";
}) {
  return (
    <span className={`badge badge-${props.tone ?? "info"}`}>
      {props.children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === "ready" ? "ok" : status === "failed" ? "err" : "warn";
  const label =
    status === "ready" ? "已就绪" : status === "failed" ? "失败" : "处理中";
  return <Badge tone={tone}>{label}</Badge>;
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function Spinner({ text = "加载中…" }: { text?: string }) {
  return <div className="spinner">{text}</div>;
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
      <div style={{ whiteSpace: "pre-wrap", marginBottom: 14 }}>
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
      </Button>
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
      <Field label={props.label}>
        {props.multiline ? (
          <textarea
            rows={4}
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder={props.placeholder ?? ""}
          />
        ) : (
          <input
            type="text"
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder={props.placeholder ?? ""}
          />
        )}
      </Field>
      <Button
        kind="primary"
        disabled={!props.allowEmpty && !v.trim()}
        onClick={ok}
      >
        {props.okLabel ?? "确定"}
      </Button>
      <Button kind="ghost" onClick={props.onClose}>
        取消
      </Button>
    </Modal>
  );
}
