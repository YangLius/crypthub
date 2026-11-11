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
import type { Hit, ResolvedPending } from "../gates/redact";

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

export function savePrescanHits(
 hits: ResolvedPending[],
 title: string,
 project: string,
): void {
 if (!hits.length) return;
 const extra = hits.map((h) => ({ ...h, title, project }));
 save([
  ...load().filter((h) => !hits.some((n) => n.slug === h.slug)),
  ...extra,
 ]);
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
export function suggestFields(hit: {
 kind: string;
 value: string;
}): ContentPatch {
 const value = hit.value.trim();
 if (!value) return {};
 if (
  hit.kind === "prefix" ||
  hit.kind === "connstr" ||
  hit.kind === "entropy"
 ) {
  return { tokens: value };
 }
 // kv：拆出键名归类
 const m = value.match(/^([^=:：]{1,48}?)[=:：]\s*(.+)$/s);
 if (!m) return { tokens: value };
 const key = m[1].trim();
 const val = m[2].trim();
 if (/pass(word|wd)?|pwd|密码/i.test(key)) return { password: val };
 if (/user(name)?|账号|用户|login|email/i.test(key)) return { username: val };
 if (/token|令牌|api[\s_-]?key|secret|密钥|key/i.test(key))
  return { tokens: val };
  return { notes: `${key}: ${val}` };
}

const PH_RE = /\{\{secret:[a-f0-9]{6,64}\}\}/g;

export interface MatchResult {
  /** slug → 本机原文命中值 */
  pairs: Map<string, string>;
  /** 脱敏文本里占位符总数（便于提示未配对余量） */
  total: number;
}

/**
 * 旧上传的待认领恢复：把脱敏文本中的占位符与本机原文重新扫描出的命中配对。
 * 锚定策略：占位符左侧 context 字符在两份文本中应一致（上传时只有命中段被替换）；
 * 上下文对不上（文件被改动）时退化为按顺序兜底，回填后表单可见可改。
 */
export function matchPendingsToLocal(
  redacted: string,
  localText: string,
  hits: Hit[],
  context = 50,
): MatchResult {
  const pairs = new Map<string, string>();
  const phs: { slug: string; start: number }[] = [];
  for (const m of redacted.matchAll(PH_RE)) {
    phs.push({ slug: m[0].slice(9, -2), start: m.index ?? 0 });
  }
  let cursor = 0;
  for (const ph of phs) {
    const left = redacted.slice(Math.max(0, ph.start - context), ph.start);
    let idx = -1;
    for (let i = cursor; i < hits.length; i++) {
      if (localText.slice(Math.max(0, hits[i].start - context), hits[i].start) === left) {
        idx = i;
        break;
      }
    }
    if (idx === -1 && cursor < hits.length) idx = cursor;
    if (idx >= 0) {
      pairs.set(ph.slug, hits[idx].value);
      cursor = idx + 1;
    }
  }
  return { pairs, total: phs.length };
}
