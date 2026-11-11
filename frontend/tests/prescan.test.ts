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
      {
        slug: "s1",
        kind: "prefix",
        value: "ghp_abcdef",
        title: "T",
        project: "P",
      },
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
    savePrescanHits(
      [{ slug: "x", kind: "kv", value: "password=old" }],
      "a",
      "",
    );
    savePrescanHits(
      [{ slug: "x", kind: "kv", value: "password=new" }],
      "b",
      "",
    );
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
    const text =
      "数据库密码是 password=Super$ecret99x 这里。token: ghp_XYZABCDEF123456 结束";
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
  const base: CachedHit = {
    slug: "s",
    kind: "kv",
    value: "",
    title: "",
    project: "",
  };

  it("password/密码 类键 → password 字段", () => {
    expect(suggestFields({ ...base, value: "password=Abc12345" })).toEqual({
      password: "Abc12345",
    });
    expect(suggestFields({ ...base, value: "数据库密码: Xy98765z" })).toEqual({
      password: "Xy98765z",
    });
  });

  it("user/账号 类键 → username 字段", () => {
    expect(suggestFields({ ...base, value: "username=svc_app" })).toEqual({
      username: "svc_app",
    });
    expect(suggestFields({ ...base, value: "账号：admin" })).toEqual({
      username: "admin",
    });
  });

  it("token/key 类键 → tokens 字段", () => {
    expect(suggestFields({ ...base, value: "api_key=sk-abc123" })).toEqual({
      tokens: "sk-abc123",
    });
    expect(suggestFields({ ...base, value: "令牌: xoxb-999" })).toEqual({
      tokens: "xoxb-999",
    });
  });

  it("未知键 → notes；无法拆键 → tokens；prefix/connstr/entropy → tokens", () => {
    expect(suggestFields({ ...base, value: "region=cn-north" })).toEqual({
      notes: "region: cn-north",
    });
    expect(suggestFields({ ...base, value: "随便一串没有键名的文本" })).toEqual(
      {
        tokens: "随便一串没有键名的文本",
      },
    );
    expect(
      suggestFields({ ...base, kind: "prefix", value: "AKIAIOSFODNN7EXAMPLE" }),
    ).toEqual({
      tokens: "AKIAIOSFODNN7EXAMPLE",
    });
    expect(
      suggestFields({ ...base, kind: "connstr", value: "postgres://u:p@h/db" }),
    ).toEqual({ tokens: "postgres://u:p@h/db" });
  });
});

import { matchPendingsToLocal } from "../src/secrets/prescanCache";
import { scan } from "../src/gates/redact";

describe("matchPendingsToLocal 上下文配对", () => {
  it("占位符与本机命中按上下文正确配对（模拟旧上传恢复）", () => {
    const local = "前情提要 数据库密码 password=Real#1x 后续文字。api_key=sk-ABCDEF123456 结尾";
    const hits = scan(local);
    expect(hits.length).toBeGreaterThan(0);
    const rd = redactAll(local);
    // 用固定 slug 构造"旧的脱敏文本"（从后往前替换避免位移）
    let redacted = local;
    for (let i = hits.length - 1; i >= 0; i--) {
      redacted =
        redacted.slice(0, hits[i].start) +
        `{{secret:${rd.resolved[i].slug}}}` +
        redacted.slice(hits[i].end);
    }
    expect(redacted).not.toBe(local);
    expect(redacted).toContain("{{secret:");
    const { pairs, total } = matchPendingsToLocal(redacted, local, scan(local));
    expect(total).toBe(rd.resolved.length);
    expect(pairs.size).toBe(rd.resolved.length);
    for (const r of rd.resolved) {
      expect(pairs.get(r.slug)).toBe(r.value);
    }
  });

  it("本机文件头部有改动（命中位置平移）仍按上下文正确配对", () => {
    const original = "标题行\n账号 admin_user_1\n密码: Str0ngPass!9\n尾部说明文字";
    const rd = redactAll(original);
    const hits = scan(original);
    let redacted = original;
    for (let i = hits.length - 1; i >= 0; i--) {
      redacted =
        redacted.slice(0, hits[i].start) +
        `{{secret:${rd.resolved[i].slug}}}` +
        redacted.slice(hits[i].end);
    }
    const edited = "新增的文件头说明文字（上传后追加）\n" + original;
    const { pairs } = matchPendingsToLocal(redacted, edited, scan(edited));
    for (const r of rd.resolved) {
      expect(pairs.get(r.slug)).toBe(r.value);
    }
  });

  it("占位符多于本机命中时只回填补上的部分且不崩溃", () => {
    const redacted = "x {{secret:aaaaaa1}} y {{secret:bbbbbb2}} z";
    const localText = "只有一处 password=OnlyOne99x";
    const { pairs, total } = matchPendingsToLocal(redacted, localText, scan(localText));
    expect(total).toBe(2);
    expect(pairs.size).toBeLessThanOrEqual(2);
  });
});
