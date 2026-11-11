/** 基础 UI 组件：Modal / Button / Field / Badge / 空态。 */
import type { ReactNode } from "react";
import { useEffect } from "react";

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
