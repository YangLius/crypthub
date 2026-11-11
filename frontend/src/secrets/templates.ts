/** 条目类型模板：按类型只显示相关字段，"所见即所存"。
 *  分类参考市面通用密码管理器（Bitwarden/1Password/KeePass）并贴合后端运维场景。
 *  字段键固定映射 SecretContent 的加密字段：username/password/url/tokens（notes 恒显示）。 */

import type { SecretContent } from "../crypto/flows";

export type TemplateId =
  | "login"
  | "web"
  | "db"
  | "middleware"
  | "apikey"
  | "aksk"
  | "ssh"
  | "cert"
  | "other";

export interface FieldSpec {
  key: "username" | "password" | "url" | "tokens";
  label: string;
  placeholder?: string;
  multiline?: boolean;
}

export interface SecretTemplate {
  id: TemplateId;
  label: string;
  desc: string;
  fields: FieldSpec[];
}

export const TEMPLATES: SecretTemplate[] = [
  {
    id: "login",
    label: "用户名密码",
    desc: "纯账号口令（无地址），如内部系统、第三方平台账号",
    fields: [
      { key: "username", label: "用户名 / 账号", placeholder: "admin" },
      { key: "password", label: "密码", placeholder: "" },
    ],
  },
  {
    id: "web",
    label: "网站·用户名密码",
    desc: "带登录地址的网站、管理控制台账号",
    fields: [
      { key: "url", label: "网址", placeholder: "https://example.com/login" },
      { key: "username", label: "用户名 / 账号", placeholder: "" },
      { key: "password", label: "密码", placeholder: "" },
    ],
  },
  {
    id: "db",
    label: "数据库连接",
    desc: "MySQL / PostgreSQL / Oracle / SQL Server / MongoDB 等",
    fields: [
      {
        key: "url",
        label: "主机:端口/库名",
        placeholder: "pg.internal:5432/orders",
      },
      { key: "username", label: "用户名", placeholder: "" },
      { key: "password", label: "密码", placeholder: "" },
    ],
  },
  {
    id: "middleware",
    label: "中间件·缓存",
    desc: "Redis / MQ / Kafka / ES 等（通常只有地址和密码）",
    fields: [
      { key: "url", label: "地址", placeholder: "redis.internal:6379" },
      { key: "password", label: "密码", placeholder: "" },
    ],
  },
  {
    id: "apikey",
    label: "API 密钥",
    desc: "独立 token / key，如 sk-…、Bearer token、AppSecret",
    fields: [
      {
        key: "tokens",
        label: "密钥 / 令牌",
        placeholder: "sk-…",
        multiline: true,
      },
    ],
  },
  {
    id: "aksk",
    label: "云 AK/SK",
    desc: "阿里云 / 腾讯云 / AWS AccessKey 对，OAuth clientId/secret",
    fields: [
      { key: "username", label: "AccessKeyId", placeholder: "LTAI…" },
      { key: "password", label: "AccessKeySecret", placeholder: "" },
    ],
  },
  {
    id: "ssh",
    label: "服务器·SSH",
    desc: "主机 + 账号，密码与私钥二选一",
    fields: [
      { key: "url", label: "主机:端口", placeholder: "10.0.0.5:22" },
      { key: "username", label: "用户名", placeholder: "root" },
      { key: "password", label: "密码（与私钥二选一）", placeholder: "" },
      {
        key: "tokens",
        label: "私钥（与密码二选一）",
        placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----",
        multiline: true,
      },
    ],
  },
  {
    id: "cert",
    label: "证书·私钥",
    desc: "TLS 证书、JWT 签名私钥、PEM / keystore 内容",
    fields: [
      {
        key: "tokens",
        label: "PEM / 私钥内容",
        placeholder: "-----BEGIN PRIVATE KEY-----",
        multiline: true,
      },
    ],
  },
  {
    id: "other",
    label: "其他·全部字段",
    desc: "不好归类时用，显示所有字段",
    fields: [
      { key: "username", label: "用户名" },
      { key: "password", label: "密码" },
      { key: "url", label: "URL / 地址" },
      { key: "tokens", label: "令牌 / 其他" },
    ],
  },
];

export function templateById(id: string): SecretTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

/** 按已填字段猜最合适的类型（导入解析、认领回填时自动归类）。 */
export function guessTemplate(c: SecretContent): TemplateId {
  const has = (v?: string) => Boolean(v && v.trim());
  const u = has(c.username);
  const p = has(c.password);
  const url = has(c.url);
  const t = has(c.tokens);
  if (t && u) return "ssh";
  if (t && !u && !url) {
    const looksPem = /BEGIN ([A-Z ]+ )?PRIVATE KEY|BEGIN CERTIFICATE/.test(
      c.tokens ?? "",
    );
    return looksPem ? "cert" : "apikey";
  }
  if (t) return "other";
  if (url && u && p) return "web";
  if (url && p && !u) return "middleware";
  if (u && p) return "login";
  if (p) return "apikey";
  return "other";
}

/** "所见即所存"：只保留当前类型模板声明的字段 + 备注，类型写进 content.type。
 *  防止切换类型后残留不可见字段被悄悄加密上传。 */
export function contentForTemplate(
  tplId: TemplateId,
  c: SecretContent,
): SecretContent {
  const spec = templateById(tplId);
  const out: SecretContent = { type: tplId };
  for (const f of spec.fields) {
    const v = c[f.key]?.trim();
    if (v) out[f.key] = v;
  }
  const notes = c.notes?.trim();
  if (notes) out.notes = notes;
  return out;
}
