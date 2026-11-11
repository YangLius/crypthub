/** 密钥批量导入：纯前端解析（零知识——文件内容不上传）。
 *  支持 .env/.txt（空行分块或 KEY=VALUE 逐行）、.csv、.json、.xlsx。
 *  解析结果在页面内预览勾选后逐条加密创建。 */
import type { SecretContent } from "../crypto/flows";

export const IMPORT_MAX_ENTRIES = 200;
export const IMPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ParsedEntry {
  name: string;
  content: SecretContent;
}

export interface ParseResult {
  format: string; // 人类可读的识别格式
  entries: ParsedEntry[];
  skipped: number; // 无法识别而跳过的行/行数
}

/* ---------------- 字段别名 ---------------- */

/** SecretContent 中值为字符串的可写字段（custom 是结构化数组，不参与别名映射） */
type StringField = "username" | "password" | "url" | "tokens" | "notes";
type AliasKey = StringField | "name" | "project" | "env";

const FIELD_ALIASES: Record<StringField | "name" | "project" | "env", string[]> = {
  name: ["name", "名称", "名字", "标题", "条目", "title", "item"],
  username: [
    "username",
    "用户名",
    "账号",
    "user",
    "login",
    "account",
    "user_name",
  ],
  password: ["password", "密码", "pass", "pwd", "passwd"],
  url: ["url", "地址", "网址", "链接", "uri", "host", "endpoint"],
  tokens: [
    "token",
    "tokens",
    "apikey",
    "api_key",
    "api key",
    "密钥",
    "令牌",
    "secret",
    "access_key",
    "secret_key",
    "key",
  ],
  notes: ["notes", "note", "备注", "说明", "描述", "comment", "remark"],
  project: ["project", "项目"],
  env: ["env", "环境", "environment"],
};

function normalizeKey(k: string): string {
  return k.trim().toLowerCase().replace(/[\s_-]+/g, "_");
}

/** 行（键值对集合）→ SecretContent + name/project/env 元信息 */
function rowToEntry(
  row: Record<string, string>,
  fallbackName: string,
): { name: string; project: string; env: string; content: SecretContent } | null {
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) norm[normalizeKey(k)] = String(v ?? "").trim();

  const pick = (field: AliasKey): string => {
    const aliases = FIELD_ALIASES[field].map(normalizeKey);
    // 先精确匹配，再后缀/包含匹配（如 password1、db_password）
    for (const [k, v] of Object.entries(norm)) {
      if (aliases.includes(k) && v) return v;
    }
    for (const [k, v] of Object.entries(norm)) {
      if (v && aliases.some((a) => k.endsWith(a) || k.includes(a))) return v;
    }
    return "";
  };

  const content: SecretContent = {
    username: pick("username"),
    password: pick("password"),
    url: pick("url"),
    tokens: pick("tokens"),
    notes: pick("notes"),
  };
  const name = pick("name");
  const project = pick("project");
  const env = pick("env");

  const hasValue =
    content.username || content.password || content.url || content.tokens || content.notes;
  if (!hasValue && !name) return null;
  if (!content.notes) delete content.notes;
  return {
    name: name || content.username || fallbackName,
    project,
    env,
    content,
  };
}

function uniqueNames(entries: ParsedEntry[]): ParsedEntry[] {
  const seen = new Map<string, number>();
  return entries.map((e) => {
    const base = e.name || "未命名";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? e : { ...e, name: `${base} ${n}` };
  });
}

/* ---------------- CSV ---------------- */

/** 手写 CSV 解析（支持引号包裹、引号转义、跨行单元格） */
export function parseCsv(text: string): { rows: Record<string, string>[]; skipped: number } {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuote = false;
      } else cell += c;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === "," || c === "\t") {
      cur.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cur.push(cell);
      cell = "";
      if (cur.some((x) => x.trim() !== "")) rows.push(cur);
      cur = [];
    } else cell += c;
  }
  cur.push(cell);
  if (cur.some((x) => x.trim() !== "")) rows.push(cur);

  if (rows.length < 2) return { rows: [], skipped: Math.max(0, rows.length - 1) };
  const header = rows[0];
  const entries: Record<string, string>[] = [];
  for (const r of rows.slice(1)) {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h.trim()) obj[h] = r[i] ?? "";
    });
    entries.push(obj);
  }
  return { rows: entries, skipped: 0 };
}

/* ---------------- 行式（CSV / xlsx 共用） ---------------- */

function rowsToEntries(
  rows: Record<string, string>[],
  format: string,
): ParseResult {
  const entries: ParsedEntry[] = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    const e = rowToEntry(row, `条目 ${i + 1}`);
    if (e) entries.push({ name: e.name, content: e.content });
    else skipped++;
  });
  return { format, entries: uniqueNames(entries), skipped };
}

/* ---------------- JSON ---------------- */

function keyToField(key: string, value: string): [StringField, string] {
  const k = normalizeKey(key);
  const hasAlias = (list: string[]) =>
    list.map(normalizeKey).some((a) => k === a || k.includes(a));
  if (hasAlias(FIELD_ALIASES.username)) return ["username", value];
  if (hasAlias(FIELD_ALIASES.password)) return ["password", value];
  if (hasAlias(FIELD_ALIASES.url)) return ["url", value];
  if (hasAlias(FIELD_ALIASES.notes)) return ["notes", value];
  return ["tokens", value];
}

export function parseJsonLike(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { format: "JSON（解析失败）", entries: [], skipped: 1 };
  }
  // 数组：密码管理器导出的常见形态（对象数组按字段别名映射）
  if (Array.isArray(data)) {
    const rows: Record<string, string>[] = [];
    for (const item of data) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj: Record<string, string> = {};
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          obj[k] = v === null || v === undefined ? "" : String(v);
        }
        rows.push(obj);
      }
    }
    return rowsToEntries(rows, "JSON 数组");
  }
  // 对象：每个 key 一条（value 放入语义最接近的字段）
  if (data && typeof data === "object") {
    const entries: ParsedEntry[] = [];
    let skipped = 0;
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      if (!s.trim()) {
        skipped++;
        continue;
      }
      const [field, val] = keyToField(k, s);
      entries.push({ name: k, content: { [field]: val } });
    }
    return { format: "JSON 键值对象", entries: uniqueNames(entries), skipped };
  }
  return { format: "JSON（不支持的形态）", entries: [], skipped: 1 };
}

/* ---------------- .env / .txt ---------------- */

const KV_RE = /^([A-Za-z0-9_\u4e00-\u9fa5.-]+?)\s*[=:：]\s*(.*)$/;
const COMMENT_RE = /^\s*(#|\/\/|;)/;

function kvFieldFor(key: string, value: string): [StringField, string] {
  return keyToField(key, value);
}

export function parseEnvText(text: string): ParseResult {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else cur.push(l);
  }
  if (cur.length) blocks.push(cur);

  const entries: ParsedEntry[] = [];
  let skipped = 0;

  if (blocks.length > 1) {
    // 分块模式：一个空行分隔的块 = 一个条目
    for (const block of blocks) {
      const content: SecretContent = { username: "", password: "", url: "", tokens: "" };
      const extra: string[] = [];
      let name = "";
      for (const l of block) {
        if (COMMENT_RE.test(l)) continue;
        const m = KV_RE.exec(l);
        if (m) {
          const key = m[1].trim();
          const [field, val] = kvFieldFor(key, m[2].trim());
          if (normalizeKey(key) === "name" || key.includes("名称") || key.includes("标题")) {
            name = val;
            continue;
          }
          content[field] = val;
        } else {
          // 首个自由文本行作为条目标题（不重复塞入备注）；其余进备注追加
          if (!name) name = l.trim().slice(0, 24);
          else extra.push(l);
        }
      }
      if (extra.length) {
        // 追加而非覆盖：保留已识别的备注字段（如“备注: 主实例”）
        content.notes = content.notes
          ? `${content.notes}\n${extra.join("\n")}`
          : extra.join("\n");
      }
      if (!content.username && !content.password && !content.url && !content.tokens && !content.notes) {
        skipped++;
        continue;
      }
      entries.push({ name: name || block[0].trim().slice(0, 24), content });
    }
    return { format: "文本分块", entries: uniqueNames(entries), skipped };
  }

  // 单块：全部是 KEY=VALUE → 每行一条
  const kvLines = lines.filter((l) => l.trim() && !COMMENT_RE.test(l));
  if (kvLines.length > 0 && kvLines.every((l) => KV_RE.test(l))) {
    for (const l of kvLines) {
      const m = KV_RE.exec(l);
      if (!m) continue;
      const [field, val] = kvFieldFor(m[1], m[2].trim());
      entries.push({ name: m[1].trim(), content: { [field]: val } });
    }
    skipped = lines.filter((l) => l.trim() && COMMENT_RE.test(l)).length;
    return { format: "KEY=VALUE 逐行", entries: uniqueNames(entries), skipped };
  }

  return { format: "文本（无法识别结构）", entries: [], skipped: kvLines.length };
}

/* ---------------- 入口 ---------------- */

export function isXlsxName(name: string): boolean {
  return /\.xlsx$/i.test(name);
}

export function supportedImportName(name: string): boolean {
  return /\.(env|txt|csv|tsv|json|md|conf|ini|properties|xlsx)$/i.test(name);
}

export async function parseImportFile(
  file: File,
): Promise<ParseResult> {
  if (file.size > IMPORT_MAX_FILE_BYTES) {
    throw new Error("文件超过 2MB，请拆分后导入");
  }
  if (isXlsxName(file.name)) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { format: "xlsx（空工作簿）", entries: [], skipped: 0 };
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
    });
    const strRows = rows.map((r) => {
      const o: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) o[k] = v == null ? "" : String(v);
      return o;
    });
    return rowsToEntries(strRows, "Excel xlsx");
  }
  const text = await file.text();
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".json")) return parseJsonLike(text);
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
    const { rows, skipped } = parseCsv(text);
    if (!rows.length) return { format: "CSV（无数据行）", entries: [], skipped };
    return rowsToEntries(rows, "CSV 表格");
  }
  // .env/.txt/.md/.conf/.ini/.properties
  return parseEnvText(text);
}

/** 把解析结果裁剪到上限内 */
export function clampEntries(result: ParseResult): {
  result: ParseResult;
  clamped: number;
} {
  if (result.entries.length <= IMPORT_MAX_ENTRIES) return { result, clamped: 0 };
  return {
    result: { ...result, entries: result.entries.slice(0, IMPORT_MAX_ENTRIES) },
    clamped: result.entries.length - IMPORT_MAX_ENTRIES,
  };
}
