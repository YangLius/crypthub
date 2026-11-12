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
 /** 同批扫描中配对的另一条命中 slug（用户名↔密码成对认领） */
 pair?: string;
 /** 命中附近发现的网址（用于把成对凭据识别为「网站」类型并预填 URL） */
 url?: string;
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

/** 从 kv 命中值（整行“键：值”）归类出用户名/密码字段，非成对候选返回 null。 */
function loginFieldOf(hit: {
 kind: string;
 value: string;
}): "username" | "password" | null {
 if (hit.kind !== "kv") return null;
 const patch = suggestFields(hit);
 if (patch.username) return "username";
 if (patch.password) return "password";
 return null;
}

/**
 * 同批扫描命中内计算用户名↔密码配对（纯函数，便于单测）。
 * 规则：相邻（数组顺序=文本顺序）且互补的一对 kv 命中配为一组；
 * 用户名优先向右找、密码优先向左找（兼容“密码在前”的写法），
 * 全局贪心去重，避免 user1-pass1-user2-pass2 里密码跨组误配。
 */
function computeBatchPairs(hits: ResolvedPending[]): Map<string, string> {
 const fields = hits.map((h) => ({ slug: h.slug, f: loginFieldOf(h) }));
 const pairs = new Map<string, string>();
 for (let i = 0; i < fields.length; i++) {
  const cur = fields[i];
  if (!cur.f || pairs.has(cur.slug)) continue; // 已配对的不再重配（防跨组）
  const order = cur.f === "username" ? [i + 1, i - 1] : [i - 1, i + 1];
  for (const j of order) {
   const o = fields[j];
   if (o && o.f && o.f !== cur.f && !pairs.has(o.slug)) {
    pairs.set(cur.slug, o.slug);
    pairs.set(o.slug, cur.slug);
    break;
   }
  }
 }
 return pairs;
}

export function savePrescanHits(
 hits: ResolvedPending[],
 title: string,
 project: string,
 urlHints?: Map<string, string>,
): void {
 if (!hits.length) return;
 const pairs = computeBatchPairs(hits);
 const extra = hits.map((h) => ({
  ...h,
  title,
  project,
  pair: pairs.get(h.slug),
  url: urlHints?.get(h.slug),
 }));
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

/**
 * 成对认领：取该 slug 配对的另一条命中（用户名↔密码）。
 * 优先用保存时计算的显式 pair；旧缓存（无 pair 字段）按“同标题相邻互补”兼底，
 * 让老上传（KV 中文键修复前后的存量）也能成对回填。
 */
export function findPairedHit(slug: string): CachedHit | null {
 const list = load();
 const self = list.find((h) => h.slug === slug);
 if (!self) return null;
 if (self.pair) {
  const p = list.find((h) => h.slug === self.pair);
  if (p) return p;
 }
 const idx = list.indexOf(self);
 const selfField = loginFieldOf(self);
 if (selfField === null) return null;
 const order =
  selfField === "username" ? [idx + 1, idx - 1] : [idx - 1, idx + 1];
 for (const i of order) {
  const h = list[i];
  if (!h || h.title !== self.title) continue;
  const f = loginFieldOf(h);
  if (f && f !== selfField) return h;
 }
 return null;
}

export type ContentPatch = Partial<
 Pick<SecretContent, "username" | "password" | "url" | "tokens" | "notes">
>;

/** 按命中类型/键名把原文建议填到哪个内容字段（纯函数，便于单测）。 */
export function suggestFields(hit: {
 kind: string;
 value: string;
 key?: string;
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
 // kv：新版命中带 key（键名标签）且 value 只有纯值；
 // 旧缓存（value=整行）走拆键名归类的老路径
 if (hit.key) {
  const key = hit.key.trim();
  if (/pass(word|wd)?|pwd|密码/i.test(key)) return { password: value };
  if (/user(name)?|账号|用户|login|email/i.test(key))
   return { username: value };
  if (/token|令牌|api[\s_-]?key|secret|密钥|key/i.test(key))
   return { tokens: value };
  return { notes: `${key}: ${value}` };
 }
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

/** 完整链接（http(s):// 或 www. 开头）；排除常见中文标点与闭合符号 */
const URL_LINE_RE = /(?:https?:\/\/|www\.)[^\s"'<>，。；、）】》"']{3,150}/i;
/** 网址类键值行：网址/域名/站点/网站：xxx（不含“地址/host”，避免把服务器 IP 当网址） */
const URL_KV_RE =
 /(?:网址|域名|站点|网站|url)\s*[:：=]\s*([^\s，。；、）】》"']{3,150})/i;

function urlInWindow(win: string): string | undefined {
 const strip = (s: string) => s.replace(/[.,;:)）】》]+$/, "");
 const line = win.match(URL_LINE_RE);
 if (line)
  return line[0].startsWith("www.") ? `https://${line[0]}` : strip(line[0]);
 const kv = win.match(URL_KV_RE);
 if (kv) return strip(kv[1]);
 return undefined;
}

const URL_WINDOW = 400; // 命中±400 字符内找网址线索

/**
 * 从原文中提取每个命中附近的网址（纯函数，便于单测）。
 * hits 需带原文位置（start/end）与对应 slug。
 */
export function urlHintsFromText(
 text: string,
 hits: { start: number; end: number; slug: string }[],
): Map<string, string> {
 const hints = new Map<string, string>();
 for (const h of hits) {
  if (!h.slug) continue;
  const win = text.slice(
   Math.max(0, h.start - URL_WINDOW),
   Math.min(text.length, h.end + URL_WINDOW),
  );
  const url = urlInWindow(win);
  if (url) hints.set(h.slug, url);
 }
 return hints;
}

/**
 * 存量待认领兑底：服务端脱敏文本里网址未被替换（不是凭据），
 * 按占位符位置在附近找网址，供认领时把用户名+密码识别为「网站」类型。
 */
export function urlHintsFromRedacted(
 redacted: string,
 slugs: string[],
): Map<string, string> {
 const hints = new Map<string, string>();
 for (const slug of slugs) {
  const at = redacted.indexOf(`{{secret:${slug}}}`);
  if (at < 0) continue;
  const win = redacted.slice(
   Math.max(0, at - URL_WINDOW),
   Math.min(redacted.length, at + URL_WINDOW + 20),
  );
  const url = urlInWindow(win);
  if (url) hints.set(slug, url);
 }
 return hints;
}

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
   if (
    localText.slice(Math.max(0, hits[i].start - context), hits[i].start) ===
    left
   ) {
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
