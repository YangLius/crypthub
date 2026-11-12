/** 条目类型模板：字段可见性、类型猜测、"所见即所存"内容裁剪。 */
import { describe, expect, it } from "vitest";
import type { SecretContent } from "../src/crypto/flows";
import {
  contentForTemplate,
  guessTemplate,
  TEMPLATES,
  templateById,
} from "../src/secrets/templates";

describe("TEMPLATES 定义完整性", () => {
  it("id 唯一且都有 label/desc/至少一个字段", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.desc.length).toBeGreaterThan(0);
      expect(t.fields.length).toBeGreaterThan(0);
    }
  });

  it("字段键只在 username/password/url/tokens 内且无重复", () => {
    const allowed = new Set(["username", "password", "url", "tokens"]);
    for (const t of TEMPLATES) {
      const keys = t.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(allowed.has(k)).toBe(true);
    }
  });

  it("templateById 未知 id 回退到第一个模板", () => {
    expect(templateById("nonexistent").id).toBe(TEMPLATES[0].id);
    expect(templateById("web").label).toBe("网站·用户名密码");
  });
});

describe("guessTemplate 按已填字段自动归类", () => {
  const c = (p: Partial<SecretContent>): SecretContent => p;

  it("用户名+密码 → login", () => {
    expect(guessTemplate(c({ username: "admin", password: "x" }))).toBe(
      "login",
    );
  });

  it("网址+用户名+密码 → web", () => {
    expect(
      guessTemplate(c({ url: "https://a.com", username: "u", password: "p" })),
    ).toBe("web");
  });

  it("地址+密码（无用户名）→ middleware", () => {
    expect(
      guessTemplate(c({ url: "redis.internal:6379", password: "p" })),
    ).toBe("middleware");
  });

  it("裸 token（sk-）→ apikey；PEM 私钥 → cert", () => {
    expect(guessTemplate(c({ tokens: "sk-ABCDEF123456" }))).toBe("apikey");
    expect(
      guessTemplate(c({ tokens: "-----BEGIN PRIVATE KEY-----\nabc" })),
    ).toBe("cert");
  });

  it("token+用户名 → ssh；孤密码 → login（非 apikey）；全空 → other", () => {
    expect(
      guessTemplate(c({ url: "10.0.0.5:22", username: "root", tokens: "AAA" })),
    ).toBe("ssh");
    expect(guessTemplate(c({ password: "Xzg2020$" }))).toBe("login");
    expect(guessTemplate(c({}))).toBe("other");
  });
});

describe("contentForTemplate 所见即所存", () => {
  it("只保留模板声明字段 + 备注，并写入 type", () => {
    const full = c({
      username: "u",
      password: "p",
      url: "https://a.com",
      tokens: "sk-x",
      notes: "备注",
    });
    const out = contentForTemplate("apikey", full);
    expect(out).toEqual({ type: "apikey", tokens: "sk-x", notes: "备注" });
  });

  it("切换类型不残留不可见字段；空值被剔除", () => {
    const full = c({ username: "u", password: "  ", tokens: "t" });
    // middleware 只声明 url+password：tokens 不属于该类型应被剔除，空白密码剔除
    expect(contentForTemplate("middleware", full)).toEqual({
      type: "middleware",
    });
    expect(contentForTemplate("login", full)).toEqual({
      type: "login",
      username: "u",
    });
  });
});

function c(p: Partial<SecretContent>): SecretContent {
  return p;
}
