import { beforeEach, describe, expect, it } from "vitest";
import {
  peekPrescanHit,
  removePrescanHit,
  savePrescanHits,
  suggestFields,
  type CachedHit,
} from "../src/secrets/prescanCache";
import { redactAll } from "../src/gates/redact";

// vitest node 环境没有 sessionStorage，桩一个内存实现
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { sessionStorage?: Storage }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
});

describe("prescanCache", () => {
  it("save → peek → remove 往返", () => {
    const hits = [
      { slug: "s1", kind: "prefix", value: "ghp_abcdef", title: "T", project: "P" },
    ];
    savePrescanHits(hits, "运维手册", "billing");
    const hit = peekPrescanHit("s1");
    expect(hit).not.toBeNull();
    expect(hit?.value).toBe("ghp_abcdef");
    expect(hit?.title).toBe("运维手册");
    expect(hit?.project).toBe("billing");
    removePrescanHit("s1");
    expect(peekPrescanHit("s1")).toBeNull();
  });

  it("同名 slug 再保存会覆盖旧值", () => {
    savePrescanHits([{ slug: "x", kind: "kv", value: "password=old" }], "a", "");
    savePrescanHits([{ slug: "x", kind: "kv", value: "password=new" }], "b", "");
    expect(peekPrescanHit("x")?.value).toBe("password=new");
    expect(peekPrescanHit("x")?.title).toBe("b");
  });

  it("sessionStorage 不可用时静默降级不抛错", () => {
    (globalThis as { sessionStorage?: Storage }).sessionStorage = undefined;
    expect(() =>
      savePrescanHits([{ slug: "y", kind: "kv", value: "a=b" }], "t", ""),
    ).not.toThrow();
    expect(peekPrescanHit("y")).toBeNull();
  });

  it("redactAll 的 resolved 与 pending 一一对应且带原文", () => {
    const text = "数据库密码是 password=Super$ecret99x 这里。token: ghp_XYZABCDEF123456 结束";
    const rd = redactAll(text);
    expect(rd.resolved.length).toBe(rd.pending.length);
    expect(rd.resolved.length).toBeGreaterThan(0);
    for (let i = 0; i < rd.resolved.length; i++) {
      expect(rd.resolved[i].slug).toBe(rd.pending[i].slug);
      expect(rd.resolved[i].value.length).toBeGreaterThan(0);
      expect(rd.pending[i]).not.toHaveProperty("value"); // 发给服务端的 pending 不含原文
    }
  });
});

describe("suggestFields 字段归类", () => {
  const base: CachedHit = { slug: "s", kind: "kv", value: "", title: "", project: "" };

  it("password/密码 类键 → password 字段", () => {
    expect(suggestFields({ ...base, value: "password=Abc12345" })).toEqual({ password: "Abc12345" });
    expect(suggestFields({ ...base, value: "数据库密码: Xy98765z" })).toEqual({ password: "Xy98765z" });
  });

  it("user/账号 类键 → username 字段", () => {
    expect(suggestFields({ ...base, value: "username=svc_app" })).toEqual({ username: "svc_app" });
    expect(suggestFields({ ...base, value: "账号：admin" })).toEqual({ username: "admin" });
  });

  it("token/key 类键 → tokens 字段", () => {
    expect(suggestFields({ ...base, value: "api_key=sk-abc123" })).toEqual({ tokens: "sk-abc123" });
    expect(suggestFields({ ...base, value: "令牌: xoxb-999" })).toEqual({ tokens: "xoxb-999" });
  });

  it("未知键 → notes；无法拆键 → tokens；prefix/connstr/entropy → tokens", () => {
    expect(suggestFields({ ...base, value: "region=cn-north" })).toEqual({ notes: "region: cn-north" });
    expect(suggestFields({ ...base, value: "随便一串没有键名的文本" })).toEqual({
      tokens: "随便一串没有键名的文本",
    });
    expect(suggestFields({ ...base, kind: "prefix", value: "AKIAIOSFODNN7EXAMPLE" })).toEqual({
      tokens: "AKIAIOSFODNN7EXAMPLE",
    });
    expect(
      suggestFields({ ...base, kind: "connstr", value: "postgres://u:p@h/db" }),
    ).toEqual({ tokens: "postgres://u:p@h/db" });
  });
});
