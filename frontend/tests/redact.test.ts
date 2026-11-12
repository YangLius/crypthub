/** 脱敏闸测试（与 backend/tests/test_gates.py 同源用例，验证两端规则一致）。 */
import { describe, expect, it } from "vitest";
import {
  isTextLike,
  redactAll,
  scan,
  shannonEntropy,
} from "../src/gates/redact";

describe("前缀规则", () => {
  it("sk- 命中", () => {
    expect(
      scan("使用 sk-Abcd1234567890abcdef1234 作为 API key").some(
        (h) => h.kind === "prefix",
      ),
    ).toBe(true);
  });
  it("私钥块命中", () => {
    const t =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----";
    expect(scan(t).some((h) => h.kind === "prefix")).toBe(true);
  });
  it("AKIA 命中", () => {
    expect(
      scan("aws_secret_access_key = AKIAIOSFODNN7EXAMPLEEXTRA").some(
        (h) => h.kind === "prefix",
      ),
    ).toBe(true);
  });
});

describe("连接串规则", () => {
  it("postgres://user:pass@ 命中", () => {
    expect(
      scan(
        "DATABASE_URL=postgres://admin:P@ssw0rd123@db.internal:5432/kb",
      ).some((h) => h.kind === "connstr"),
    ).toBe(true);
  });
  it("redis:// 命中", () => {
    expect(
      scan("redis://default:cachePass99@rds:6379/0").some(
        (h) => h.kind === "connstr",
      ),
    ).toBe(true);
  });
});

describe("键值对规则", () => {
  it("password: 命中", () => {
    expect(scan("password: hunter2secret").some((h) => h.kind === "kv")).toBe(
      true,
    );
  });
  it("api_key = 命中", () => {
    expect(scan('api_key = "abcd1234"').some((h) => h.kind === "kv")).toBe(
      true,
    );
  });
  it("短值不命中", () => {
    expect(scan("password=ab").some((h) => h.kind === "kv")).toBe(false);
  });
  it("占位符不命中（幂等）", () => {
    expect(
      scan("password: {{secret:abcd1234}}").some((h) => h.kind === "kv"),
    ).toBe(false);
    expect(scan("{{secret:abcd1234}}").some((h) => h.kind === "kv")).toBe(
      false,
    );
  });
});

describe("高熵规则", () => {
  it("高熵字母数字串命中", () => {
    const hits = scan("signature: Xk9pQ2rS7tU8vW3xY4zA5bC6dE7fG8h");
    expect(hits.some((h) => h.kind === "entropy")).toBe(true);
  });
  it("普通长英文单词不命中", () => {
    expect(
      scan("internationalization constant").some((h) => h.kind === "entropy"),
    ).toBe(false);
  });
  it("普通中文文本不命中", () => {
    expect(
      scan("这是一段普通的文档内容，包含中文和数字 12345，不应命中任何规则。"),
    ).toEqual([]);
  });
});

describe("熵函数", () => {
  it("全同字符熵为 0", () => expect(shannonEntropy("aaaaaaaa")).toBe(0));
  it("高多样性字符熵 > 3.5", () =>
    expect(shannonEntropy("Xk9pQ2rS7tU8vW3xY4zA")).toBeGreaterThan(3.5));
});

describe("redactAll", () => {
  it("替换并产出 pending 列表；真实值不再出现", () => {
    const text = "db=postgres://u:pwd@h/x and password: letmein99";
    const rd = redactAll(text);
    expect(rd.pending.length).toBeGreaterThan(0);
    expect(rd.text).toContain("{{secret:");
    expect(rd.text).not.toContain("postgres://u:pwd@h/x");
    expect(rd.text).not.toContain("letmein99");
    // 幂等：再扫不命中
    expect(
      scan(rd.text).some((h) => h.kind === "kv" || h.kind === "connstr"),
    ).toBe(false);
  });
});

describe("文本类型判定", () => {
  it("与 Python is_text_mime 对齐", () => {
    expect(isTextLike("a.txt", "text/plain")).toBe(true);
    expect(isTextLike("readme.md", "")).toBe(true);
    expect(isTextLike("a.py", "application/octet-stream")).toBe(true);
    expect(isTextLike("a.pdf", "application/pdf")).toBe(false);
    expect(
      isTextLike(
        "a.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe(false);
  });
});

describe("中文键名规则（与 test_gates.py 同源）", () => {
  it("用户名/密码/账号/口令 + 中文冒号的短凭据命中 kv", () => {
    const rd = redactAll(
      "47.109.143.246\n用户名：root\n密码：Xx123456$\n账号：admin\n口令：p@ssw0rd!",
    );
    expect(rd.hits.filter((h) => h.kind === "kv").length).toBe(4);
  });
  it("无 ASCII 值的中文散文不误报", () => {
    const rd = redactAll(
      "账号：本文描述\n密钥：见下文\n账号体系如下：详细登录流程。密钥管理模块负责轮换。",
    );
    expect(rd.hits.length).toBe(0);
  });
  it("全角分号分隔的多组键值各自命中", () => {
    const rd = redactAll("用户名：user1；密码：pass1234");
    expect(rd.hits.filter((h) => h.kind === "kv").length).toBe(2);
  });
  it("kv 脱敏保留键名标签，只替换值；key/value 供字段归类（与 test_gates.py 同源）", () => {
    const rd = redactAll(
      "47.109.143.246\n用户名：root\n密码：Xzg2020$\n\n用户名：deploy\n密码：Xzg2020$",
    );
    expect(rd.hits.filter((h) => h.kind === "kv").length).toBe(4);
    expect(rd.text.match(/用户名：/g)?.length).toBe(2);
    expect(rd.text.match(/密码：/g)?.length).toBe(2);
    expect(rd.text).not.toContain("root");
    expect(rd.text).not.toContain("Xzg2020$");
    const kv = rd.hits.filter((h) => h.kind === "kv");
    expect(kv.map((h) => h.key)).toEqual(["用户名", "密码", "用户名", "密码"]);
    expect(
      kv.every((h) => !h.value.includes("：") && !h.value.includes(":")),
    ).toBe(true);
    // 占位符紧跟在键名后（同行可读）
    expect(rd.text).toMatch(/用户名：\{\{secret:[0-9a-f]+\}\}/);
    // resolved 必须透传 key：认领回填靠它把纯值归类为用户名/密码（回归：曾丢失导致类型误判）
    expect(rd.resolved.filter((r) => r.kind === "kv").map((r) => r.key)).toEqual(
      ["用户名", "密码", "用户名", "密码"],
    );
  });
});
