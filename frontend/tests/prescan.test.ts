import { beforeEach, describe, expect, it } from "vitest";
import {
  findPairedHit,
  peekPrescanHit,
  removePrescanHit,
  savePrescanHits,
  suggestFields,
  urlHintsFromRedacted,
  urlHintsFromText,
  type CachedHit,
} from "../src/secrets/prescanCache";
import { guessTemplate } from "../src/secrets/templates";
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
    const local =
      "前情提要 数据库密码 password=Real#1x 后续文字。api_key=sk-ABCDEF123456 结尾";
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
    const original =
      "标题行\n账号 admin_user_1\n密码: Str0ngPass!9\n尾部说明文字";
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
    const { pairs, total } = matchPendingsToLocal(
      redacted,
      localText,
      scan(localText),
    );
    expect(total).toBe(2);
    expect(pairs.size).toBeLessThanOrEqual(2);
  });
});

describe("用户名↔密码成对认领（findPairedHit）", () => {
  const up = (slug: string, value: string) => ({
    slug,
    kind: "kv",
    value,
  });
  const saveBatch = (
    rows: { slug: string; kind: string; value: string }[],
    title = "运维手册",
  ) =>
    savePrescanHits(rows.map((r) => ({ ...r })) as never[], title, "billing");

  it("相邻的用户名+密码配成一对（顺序两种都支持）", () => {
    saveBatch([up("u1", "用户名：admin"), up("p1", "密码：Xx123456$")]);
    expect(findPairedHit("u1")?.slug).toBe("p1");
    expect(findPairedHit("p1")?.slug).toBe("u1");

    store.clear();
    saveBatch([up("p2", "密码：Xx123456$"), up("u2", "账号：root")]);
    expect(findPairedHit("p2")?.slug).toBe("u2");
    expect(findPairedHit("u2")?.slug).toBe("p2");
  });

  it("两组凭据全局贪心不跨组（user1-pass1 / user2-pass2）", () => {
    saveBatch([
      up("u1", "用户名：admin"),
      up("p1", "密码：Pass1abc$"),
      up("u2", "账号：root"),
      up("p2", "密码：Pass2def$"),
    ]);
    expect(findPairedHit("u1")?.slug).toBe("p1");
    expect(findPairedHit("p1")?.slug).toBe("u1");
    expect(findPairedHit("u2")?.slug).toBe("p2");
    expect(findPairedHit("p2")?.slug).toBe("u2");
  });

  it("非用户名/密码的 kv 与前缀类命中不参与配对", () => {
    saveBatch([
      up("k1", "access_key: AKIAIOSFODNN7EXAMPLE"),
      up("s1", "sk-proj-abcdefghijklmnop"),
      up("u3", "用户名：admin"),
    ]);
    expect(findPairedHit("k1")).toBeNull();
    expect(findPairedHit("s1")).toBeNull();
    expect(findPairedHit("u3")).toBeNull();
  });

  it("旧缓存（无 pair 字段）按同标题相邻互补兜底配对", () => {
    // 模拟存量：分两次单独保存（各自批内无配对），靠相邻+同标题兜底
    saveBatch([up("lu", "用户名：legacy")]);
    saveBatch([up("lp", "密码：Legacy99$")]);
    expect(findPairedHit("lu")?.slug).toBe("lp");
    expect(findPairedHit("lp")?.slug).toBe("lu");
  });

  it("不同标题的相邻命中不误配", () => {
    saveBatch([up("tu", "用户名：admin")], "文档A");
    saveBatch([up("tp", "密码：Xx123456$")], "文档B");
    expect(findPairedHit("tu")).toBeNull();
    expect(findPairedHit("tp")).toBeNull();
  });

  it("认领删除自身后配对方也不再被找到", () => {
    saveBatch([up("u9", "用户名：admin"), up("p9", "密码：Xx123456$")]);
    removePrescanHit("u9");
    expect(findPairedHit("p9")).toBeNull();
  });
});

describe("网址线索识别（urlHints）", () => {
  const pos = (text: string, kw: string) => {
    const start = text.indexOf(kw);
    return { start, end: start + kw.length + 10 };
  };

  it("命中附近的完整链接被提取，用户名+密码+网址 → 网站类型", () => {
    const text =
      "财务系统 https://fin.example.com/login\n用户名：admin\n密码：Xx123456$";
    const hints = urlHintsFromText(text, [
      { slug: "u1", ...pos(text, "用户名") },
      { slug: "p1", ...pos(text, "密码") },
    ]);
    expect(hints.get("u1")).toBe("https://fin.example.com/login");
    expect(hints.get("p1")).toBe("https://fin.example.com/login");
    expect(
      guessTemplate({
        username: "admin",
        password: "Xx123456$",
        url: hints.get("u1"),
      }),
    ).toBe("web");
  });

  it("www. 前缀自动补 https://；无 scheme 的 域名： 行也能提取", () => {
    const t1 = "官网 www.demo.cn\n账号：ops\n密码：Passw0rd!";
    const h1 = urlHintsFromText(t1, [{ slug: "s1", ...pos(t1, "账号") }]);
    expect(h1.get("s1")).toBe("https://www.demo.cn");

    const t2 = "域名：portal.corp.com\n用户名：u\n密码：p";
    const h2 = urlHintsFromText(t2, [{ slug: "s2", ...pos(t2, "用户名") }]);
    expect(h2.get("s2")).toBe("portal.corp.com");
  });

  it("远离命中的网址不算线索；服务器地址（IP）不误识别", () => {
    const t1 =
      "网址：https://far.example.com\n" +
      "x".repeat(450) +
      "\n用户名：admin\n密码：p";
    const h1 = urlHintsFromText(t1, [{ slug: "f1", ...pos(t1, "用户名") }]);
    expect(h1.size).toBe(0);

    const t2 = "服务器地址：10.0.0.8\n用户名：admin\n密码：p";
    const h2 = urlHintsFromText(t2, [
      { slug: "f2", ...pos(t2, "用户名") },
      { slug: "f3", ...pos(t2, "密码") },
    ]);
    expect(h2.size).toBe(0);
  });

  it("urlHintsFromRedacted：按占位符位置在脱敏文本里找网址（存量兕底）", () => {
    const redacted =
      "入口 https://s.example.com\n{{secret:aaaaaa01}}\n{{secret:bbbbbb02}}";
    const hints = urlHintsFromRedacted(redacted, ["aaaaaa01", "bbbbbb02"]);
    expect(hints.get("aaaaaa01")).toBe("https://s.example.com");
    expect(hints.get("bbbbbb02")).toBe("https://s.example.com");
  });
});
