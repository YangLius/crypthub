/**
 * 全局状态（zustand）。
 * 安全约束：encKey / 用户私钥只存内存态，绝不入 localStorage/sessionStorage；
 * 页面刷新即回锁定态（重新输入主密码解锁）。
 */
import { create } from "zustand";
import type { UnlockedVault } from "./crypto/flows";

export interface Me {
 user_id: string;
 username: string;
 display_name: string;
 role: "admin" | "member";
 public_key: string | null;
 salt_enc: string | null;
 local_check_ct: string | null;
 priv_wrapped: string | null;
 has_org: boolean;
 unlocked: boolean;
}

interface AppState {
 me: Me | null;
 meLoaded: boolean;
 vault: UnlockedVault | null; // null = 密钥区锁定
 setMe: (me: Me | null) => void;
 setVault: (v: UnlockedVault | null) => void;
}

export const useApp = create<AppState>((set) => ({
 me: null,
 meLoaded: false,
 vault: null,
 setMe: (me) => set({ me, meLoaded: true }),
 setVault: (vault) => set({ vault }),
}));

// ---------- 轻量 toast ----------

interface Toast {
 id: number;
 text: string;
 kind: "ok" | "err";
}
interface ToastState {
 toasts: Toast[];
 push: (text: string, kind?: Toast["kind"]) => void;
 remove: (id: number) => void;
}

export const useToasts = create<ToastState>((set) => ({
 toasts: [],
 push: (text, kind = "ok") => {
  const id = Date.now() + Math.random();
  set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(
   () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
   4000,
  );
 },
 remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(text: string) {
 useToasts.getState().push(text, "ok");
}
export function toastErr(text: string) {
 useToasts.getState().push(text, "err");
}
