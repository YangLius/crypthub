/**
 * 客户端预扫脱敏闸（设计 5.2 模式 A）——与 backend/app/gates.py 同一规则集。
 * 前端用宽松模式（strict=false，与 Python scan(strict=False) 对齐）。
 * 命中后由用户确认替换为 {{secret:<slug>}}；真实值只在前端内存，可"送入密钥区"。
 */
export interface Hit {
  kind: "prefix" | "connstr" | "kv" | "entropy";
  start: number;
  end: number;
  value: string; // 只在内存，绝不入库/入日志
}

export interface PendingItem {
  slug: string;
  kind: string;
}

/** 命中详情：value 仅存本机 sessionStorage 供认领回填，绝不发给服务端 */
export interface ResolvedPending extends PendingItem {
  value: string;
}

export interface RedactResult {
  text: string;
  pending: PendingItem[];
  hits: Hit[];
  /** 与 pending 一一对应，额外携带原文 value（只进本机缓存） */
  resolved: ResolvedPending[];
}

const PREFIXES = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN PRIVATE KEY-----",
  "github_pat_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "AKIA",
  "ASIA",
  "sk-ant-",
  "sk-",
  "Bearer ",
];

const RE_CONN =
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|rediss|mssql|ftp):\/\/[^\s:/@]+:[^\s@/]+@[^\s"'<>]+/gi;

const RE_KV =
  /(?<![A-Za-z0-9_{])(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*(?!\{\{secret:)("[^"]{4,}"|'[^']{4,}'|[^\s,;"'`]{4,})/gi;

const RE_TOKEN_CAND = /[A-Za-z0-9+/_.=-]{20,}/g;
const RE_WS_TOKEN = /\S+/g;

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function charClasses(s: string): number {
  let n = 0;
  if (/[a-z]/.test(s)) n++;
  if (/[A-Z]/.test(s)) n++;
  if (/[0-9]/.test(s)) n++;
  if (/[^A-Za-z0-9]/.test(s)) n++;
  return n;
}

function prefixHit(text: string, start: number, tokEnd: number): number | null {
  for (const p of PREFIXES) {
    if (text.startsWith(p, start)) {
      const end = start + p.length;
      const m = /^[^\s"']{6,}/.exec(text.slice(end, tokEnd));
      if (p === "Bearer ") return m ? end + m[0].length : null;
      return tokEnd;
    }
  }
  return null;
}

export function scan(text: string): Hit[] {
  const hits: Hit[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) =>
    taken.some(([s, e]) => !(b <= s || a >= e));

  for (const m of text.matchAll(RE_CONN)) {
    if (!overlaps(m.index, m.index + m[0].length)) {
      hits.push({
        kind: "connstr",
        start: m.index,
        end: m.index + m[0].length,
        value: m[0],
      });
      taken.push([m.index, m.index + m[0].length]);
    }
  }
  for (const m of text.matchAll(RE_KV)) {
    if (!overlaps(m.index, m.index + m[0].length)) {
      hits.push({
        kind: "kv",
        start: m.index,
        end: m.index + m[0].length,
        value: m[0],
      });
      taken.push([m.index, m.index + m[0].length]);
    }
  }
  for (const m of text.matchAll(RE_WS_TOKEN)) {
    const tokStart = m.index ?? 0;
    const tok = m[0];
    const tokEnd = tokStart + tok.length;
    if (overlaps(tokStart, tokEnd)) continue;
    const ph = prefixHit(text, tokStart, tokEnd);
    if (ph !== null) {
      hits.push({
        kind: "prefix",
        start: tokStart,
        end: ph,
        value: text.slice(tokStart, ph),
      });
      taken.push([tokStart, ph]);
      continue;
    }
    for (const cm of tok.matchAll(RE_TOKEN_CAND)) {
      const cand = cm[0];
      const cs = tokStart + (cm.index ?? 0);
      const ce = cs + cand.length;
      if (overlaps(cs, ce)) continue;
      if (cand.length >= 20 && shannonEntropy(cand) > 3.5) {
        const hasAlpha = /[A-Za-z]/.test(cand);
        const hasDigit = /[0-9]/.test(cand);
        const ok = hasAlpha && hasDigit && charClasses(cand) >= 2;
        if (ok) {
          hits.push({ kind: "entropy", start: cs, end: ce, value: cand });
          taken.push([cs, ce]);
        }
      }
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

function randomSlug(): string {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/** 用占位符替换全部命中（调用前应让用户逐条确认）。 */
export function redactAll(text: string): RedactResult {
  const hits = scan(text);
  if (!hits.length) return { text, pending: [], hits, resolved: [] };
  const out: string[] = [];
  let pos = 0;
  const pending: PendingItem[] = [];
  const resolved: ResolvedPending[] = [];
  for (const h of hits) {
    out.push(text.slice(pos, h.start));
    const slug = randomSlug();
    out.push("{{secret:" + slug + "}}");
    pending.push({ slug, kind: h.kind });
    resolved.push({ slug, kind: h.kind, value: h.value });
    pos = h.end;
  }
  out.push(text.slice(pos));
  return { text: out.join(""), pending, hits, resolved };
}

export function isTextLike(filename: string, mime: string): boolean {
  const exts = [
    ".md",
    ".markdown",
    ".txt",
    ".csv",
    ".tsv",
    ".log",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".conf",
    ".py",
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cs",
    ".rb",
    ".php",
    ".sh",
    ".bat",
    ".ps1",
    ".sql",
    ".html",
    ".css",
    ".xml",
    ".env",
  ];
  if (mime.startsWith("text/")) return true;
  if (
    [
      "application/json",
      "application/x-yaml",
      "application/toml",
      "application/javascript",
      "application/xml",
    ].includes(mime)
  )
    return true;
  return exts.some((e) => filename.toLowerCase().endsWith(e));
}
