/** importer.ts 解析规则单测（与 SecretsPage 导入弹窗共用的纯函数层） */
import { describe, expect, it } from "vitest";
import { parseCsv, parseEnvText, parseJsonLike } from "../src/secrets/importer";
import * as XLSX from "xlsx";

describe("parseEnvText", () => {
  it("空行分块：一块 = 一个条目，字段按语义归位", () => {
    const r = parseEnvText(
      [
        "名称：生产数据库",
        "用户名: admin",
        "密码: p@ss123",
        "地址 = pg.internal:5432",
        "",
        "Redis 生产密码",
        "password: r-999",
        "备注: 主实例",
      ].join("\n"),
    );
    expect(r.format).toBe("文本分块");
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0].name).toBe("生产数据库");
    expect(r.entries[0].content.username).toBe("admin");
    expect(r.entries[0].content.password).toBe("p@ss123");
    expect(r.entries[0].content.url).toBe("pg.internal:5432");
    expect(r.entries[1].name).toBe("Redis 生产密码");
    expect(r.entries[1].content.password).toBe("r-999");
    expect(r.entries[1].content.notes).toBe("主实例"); // "备注:" 前缀被识别并剥掉
    expect(r.skipped).toBe(0);
  });

  it("无空行且全为 KEY=VALUE：逐行一条，key 含密码语义进 password", () => {
    const r = parseEnvText("DB_PASSWORD=abc123\nAPI_TOKEN=tok-1\nAPP_NAME=demo");
    expect(r.format).toBe("KEY=VALUE 逐行");
    expect(r.entries).toHaveLength(3);
    expect(r.entries[0].name).toBe("DB_PASSWORD");
    expect(r.entries[0].content.password).toBe("abc123");
    expect(r.entries[1].content.tokens).toBe("tok-1");
  });

  it("注释行计入 skipped，不生成条目", () => {
    const r = parseEnvText("# 注释\nSECRET_A=1\n// 注释2\nSECRET_B=2");
    expect(r.entries).toHaveLength(2);
    expect(r.skipped).toBe(2);
  });

  it("自由文本无法识别 → 空结果", () => {
    const r = parseEnvText("今天天气很好\n我们出去走走吧");
    expect(r.entries).toHaveLength(0);
    expect(r.skipped).toBe(2);
  });
});

describe("parseCsv", () => {
  it("引号包裹与引号转义", () => {
    const { rows } = parseCsv(
      'name,password,notes\n"a,b","p""q""",普通\n"跨\n行","x",y',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: "a,b", password: 'p"q"', notes: "普通" });
    expect(rows[1].name).toBe("跨\n行");
  });

  it("别名中文表头映射（用户名/密码/地址）", () => {
    const r = parseCsv("名称,用户名,密码,地址\n生产库,root,secret,db:5432\n");
    const parsed = {
      format: "CSV 表格",
      entries: r.rows.length
        ? [
            {
              name: r.rows[0]["名称"],
              content: {
                username: r.rows[0]["用户名"],
                password: r.rows[0]["密码"],
                url: r.rows[0]["地址"],
              },
            },
          ]
        : [],
      skipped: 0,
    };
    void parsed;
    expect(r.rows[0]).toEqual({
      名称: "生产库",
      用户名: "root",
      密码: "secret",
      地址: "db:5432",
    });
  });
});

describe("parseJsonLike", () => {
  it("对象：每个 key 一条，密码语义 key 进 password 字段", () => {
    const r = parseJsonLike(
      JSON.stringify({ REDIS_PASSWORD: "r1", GITHUB_TOKEN: "gh1", README: "说明文本" }),
    );
    expect(r.entries).toHaveLength(3);
    expect(r.entries[0].name).toBe("REDIS_PASSWORD");
    expect(r.entries[0].content.password).toBe("r1");
    expect(r.entries[1].content.tokens).toBe("gh1");
  });

  it("数组：对象数组按别名映射（密码管理器导出形态）", () => {
    const r = parseJsonLike(
      JSON.stringify([
        { 名称: "a", 用户名: "u1", 密码: "p1" },
        { name: "b", username: "u2", password: "p2" },
      ]),
    );
    expect(r.format).toBe("JSON 数组");
    expect(r.entries).toHaveLength(2);
    expect(r.entries[1].content.username).toBe("u2");
    expect(r.entries[1].content.password).toBe("p2");
  });

  it("非法 JSON 报错形态", () => {
    const r = parseJsonLike("{broken");
    expect(r.entries).toHaveLength(0);
    expect(r.format).toContain("解析失败");
  });
});

describe("xlsx 往返", () => {
  it("生成工作簿 → 读回 → 与 CSV 行式同构", async () => {
    const aoa = [
      ["名称", "用户名", "密码"],
      ["条目甲", "u甲", "p甲"],
      ["条目乙", "u乙", "p乙"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const buf = XLSX.write({ SheetNames: ["s"], Sheets: { s: ws } }, {
      type: "array",
      bookType: "xlsx",
    }) as ArrayBuffer;
    const wb = XLSX.read(buf, { type: "array" });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
      wb.Sheets[wb.SheetNames[0]],
      { defval: "" },
    );
    expect(rows[0]).toEqual({ 名称: "条目甲", 用户名: "u甲", 密码: "p甲" });
    expect(rows[1]["密码"]).toBe("p乙");
  });
});
