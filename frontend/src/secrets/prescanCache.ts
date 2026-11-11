/**
 * 上传预扫命中值本机缓存（sessionStorage，标签页关闭即清）。
 *
 * 零知识约束：服务端只登记 slug/kind，绝无原文；因此"待认领"回填所需的
 * 原文只能在上传那一刻由浏览器暂存。策略：
 *  - 上传预扫确认替换后，把 {slug → 命中原文/来源标题/项目} 写入本机；
 *  - 密钥区"新建并认领"时回填表单，成功认领后立即删除该条；
 *  - 只用 sessionStorage（非 localStorage），不落长期盘；写不进（隐私模式等）则静默降级为手工填写。
 */
import type { SecretContent } from "../crypto/flows";
import type { ResolvedPending } from "../gates/redact";

export interface CachedHit {
  slug: string;
  kind: string;
  value: string;
  title: string;
  project: string;
}

const KEY = "kb_prescan_hits";
const MAX_ENTRIES = 500;

function load(): CachedHit[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as CachedHit[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list: CachedHit[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch {
    // 隐私模式/配额不足：缓存不可用，认领时降级为手工填写
  }
}

export function savePrescanHits(hits: ResolvedPending[], title: string, project: string): void {
  if (!hits.length) return;
  const extra = hits.map((h) => ({ ...h, title, project }));
  save([...load().filter((h) => !hits.some((n) => n.slug === h.slug)), ...extra]);
}

export function peekPrescanHit(slug: string): CachedHit | null {
  return load().find((h) => h.slug === slug) ?? null;
}

export function removePrescanHit(slug: string): void {
  save(load().filter((h) => h.slug !== slug));
}

export type ContentPatch = Partial<
  Pick<SecretContent, "username" | "password" | "url" | "tokens" | "notes">
>;

/** 按命中类型/键名把原文建议填到哪个内容字段（纯函数，便于单测）。 */
export function suggestFields(hit: { kind: string; value: string }): ContentPatch {
  const value = hit.value.trim();
  if (!value) return {};
  if (hit.kind === "prefix" || hit.kind === "connstr" || hit.kind === "entropy") {
    return { tokens: value };
  }
  // kv：拆出键名归类
  const m = value.match(/^([^=:：]{1,48}?)[=:：]\s*(.+)$/s);
  if (!m) return { tokens: value };
  const key = m[1].trim();
  const val = m[2].trim();
  if (/pass(word|wd)?|pwd|密码/i.test(key)) return { password: val };
  if (/user(name)?|账号|用户|login|email/i.test(key)) return { username: val };
  if (/token|令牌|api[\s_-]?key|secret|密钥|key/i.test(key)) return { tokens: val };
  return { notes: `${key}: ${val}` };
}
