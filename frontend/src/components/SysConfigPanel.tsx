/** 系统配置面板（仅管理员，挂在密钥区）：大模型 / 向量嵌入 / 数据库连接的查看与维护。
 *  - LLM·嵌入改动写 system_settings 表，即时生效；API Key 默认打码，点「查看明文」解掩码（写 warn 审计）。
 *  - 数据库连接改动经连通性测试后写回 .env，重启后端生效（红色确认弹窗）。 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { toast, toastErr } from "../store";
import { Button, ConfirmModal, Field } from "./ui";

interface SysCfg {
  llm: {
    api_base: string;
    model: string;
    api_key_masked: string;
    api_key_set: boolean;
    api_key_source: "db" | "env";
  };
  embedding: {
    provider: string;
    api_base: string;
    model: string;
    api_key_masked: string;
    api_key_set: boolean;
    api_key_source: "db" | "env";
    send_dims: boolean;
  };
  db: {
    host: string;
    port: string;
    name: string;
    user: string;
    password_masked: string;
    password_set: boolean;
    source: string;
  };
  overrides: string[];
}

const SECRET_INPUT = { letterSpacing: 1 } as const;

export function SysConfigPanel() {
  const [cfg, setCfg] = useState<SysCfg | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCfg(await api.get<SysCfg>("/admin/system-config"));
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "读取系统配置失败");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!cfg) return null;
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h3 style={{ marginTop: 0 }}>🔐 系统配置 · 仅管理员</h3>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        大模型与向量嵌入改动即时生效；数据库连接改动写回 .env，重启后端生效。
        所有查看明文与修改动作都会写入审计。
      </div>
      <LlmSection cfg={cfg} onChanged={refresh} />
      <EmbeddingSection cfg={cfg} onChanged={refresh} />
      <DbSection cfg={cfg} />
    </div>
  );
}

/* ---------- 大模型 ---------- */

function LlmSection({
  cfg,
  onChanged,
}: {
  cfg: SysCfg;
  onChanged: () => void;
}) {
  const [base, setBase] = useState(cfg.llm.api_base);
  const [model, setModel] = useState(cfg.llm.model);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");

  const save = async () => {
    setBusy("save");
    try {
      const body: Record<string, string> = {};
      if (base !== cfg.llm.api_base) body.llm_api_base = base.trim();
      if (model !== cfg.llm.model) body.llm_model = model.trim();
      if (key.trim()) body.llm_api_key = key.trim();
      if (Object.keys(body).length === 0) {
        toast("没有需要保存的改动");
        return;
      }
      await api.put("/admin/system-config", body);
      toast("已保存，即时生效");
      setKey("");
      onChanged();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy("");
    }
  };

  const reveal = async () => {
    try {
      const r = await api.post<{ values: Record<string, string> }>(
        "/admin/system-config/reveal",
        { fields: ["llm_api_key"] },
      );
      setKey(r.values.llm_api_key ?? "");
      toast("已填入明文（查看动作已记审计）");
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "查看失败");
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const r = await api.post<{ ok: boolean; reply?: string; error?: string }>(
        "/admin/system-config/test-llm",
        {
          api_base: base.trim() || null,
          api_key: key.trim() || null,
          model: model.trim() || null,
        },
      );
      if (r.ok) toast(`连通正常：${r.reply ?? ""}`);
      else toastErr(r.error ?? "测试失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--line)",
        paddingTop: 12,
        marginBottom: 16,
      }}
    >
      <h4 style={{ margin: "0 0 8px" }}>
        大模型（AI 问答）{" "}
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          Key 来源：{cfg.llm.api_key_source === "db" ? "界面配置" : ".env 默认"}
        </span>
      </h4>
      <Field label="API Base URL">
        <input
          value={base}
          onChange={(e) => setBase(e.target.value)}
          placeholder="https://open.bigmodel.cn/api/paas/v4"
        />
      </Field>
      <Field label="模型名">
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="glm-4-flash"
        />
      </Field>
      <Field label="API Key">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1, ...SECRET_INPUT }}
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={cfg.llm.api_key_masked || "未设置"}
            autoComplete="off"
          />
          <Button onClick={() => void reveal()}>查看明文</Button>
        </div>
      </Field>
      <div className="toolbar">
        <Button kind="primary" disabled={!!busy} onClick={() => void test()}>
          {busy === "test" ? "测试中…" : "测试连通"}
        </Button>
        <Button disabled={!!busy} onClick={() => void save()}>
          保存
        </Button>
        <span className="muted" style={{ fontSize: 12 }}>
          Key 留空保存 = 维持现状
        </span>
      </div>
    </div>
  );
}

/* ---------- 向量嵌入 ---------- */

function EmbeddingSection({
  cfg,
  onChanged,
}: {
  cfg: SysCfg;
  onChanged: () => void;
}) {
  const [provider, setProvider] = useState(cfg.embedding.provider);
  const [base, setBase] = useState(cfg.embedding.api_base);
  const [model, setModel] = useState(cfg.embedding.model);
  const [key, setKey] = useState("");
  const [sendDims, setSendDims] = useState(cfg.embedding.send_dims);
  const [busy, setBusy] = useState("");

  const save = async () => {
    setBusy("save");
    try {
      const body: Record<string, string> = {};
      if (provider !== cfg.embedding.provider)
        body.embedding_provider = provider;
      if (base !== cfg.embedding.api_base)
        body.embedding_api_base = base.trim();
      if (model !== cfg.embedding.model) body.embedding_model = model.trim();
      if (key.trim()) body.embedding_api_key = key.trim();
      if (sendDims !== cfg.embedding.send_dims)
        body.embedding_api_send_dims = sendDims ? "true" : "false";
      if (Object.keys(body).length === 0) {
        toast("没有需要保存的改动");
        return;
      }
      await api.put("/admin/system-config", body);
      toast("已保存（更换嵌入模型后，旧文档需重新上传或重建索引）");
      setKey("");
      onChanged();
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy("");
    }
  };

  const reveal = async () => {
    try {
      const r = await api.post<{ values: Record<string, string> }>(
        "/admin/system-config/reveal",
        { fields: ["embedding_api_key"] },
      );
      setKey(r.values.embedding_api_key ?? "");
      toast("已填入明文（查看动作已记审计）");
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "查看失败");
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const r = await api.post<{
        ok: boolean;
        dims?: number;
        note?: string;
        error?: string;
      }>("/admin/system-config/test-embedding", {
        provider,
        api_base: base.trim() || null,
        api_key: key.trim() || null,
        model: model.trim() || null,
        send_dims: sendDims,
      });
      if (r.ok) toast(r.note ?? `连通正常，向量维度 ${r.dims}`);
      else toastErr(r.error ?? "测试失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--line)",
        paddingTop: 12,
        marginBottom: 16,
      }}
    >
      <h4 style={{ margin: "0 0 8px" }}>
        向量嵌入（文档索引）{" "}
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          Key 来源：
          {cfg.embedding.api_key_source === "db" ? "界面配置" : ".env 默认"}
        </span>
      </h4>
      <Field label="Provider">
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="openai_compat">openai_compat（API）</option>
          <option value="local">local（本地 BGE，worker 加载）</option>
        </select>
      </Field>
      {provider === "openai_compat" && (
        <>
          <Field label="API Base URL">
            <input
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="https://open.bigmodel.cn/api/paas/v4"
            />
          </Field>
          <Field label="模型名">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="embedding-3"
            />
          </Field>
          <Field label="API Key">
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{ flex: 1, ...SECRET_INPUT }}
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={cfg.embedding.api_key_masked || "未设置"}
                autoComplete="off"
              />
              <Button onClick={() => void reveal()}>查看明文</Button>
            </div>
          </Field>
          <label
            style={{ display: "block", margin: "4px 0 8px", fontSize: 13 }}
          >
            <input
              type="checkbox"
              checked={sendDims}
              onChange={(e) => setSendDims(e.target.checked)}
            />{" "}
            请求指定维度（dimensions 参数，当前 512）
          </label>
        </>
      )}
      <div className="toolbar">
        <Button kind="primary" disabled={!!busy} onClick={() => void test()}>
          {busy === "test" ? "测试中…" : "测试连通"}
        </Button>
        <Button disabled={!!busy} onClick={() => void save()}>
          保存
        </Button>
        <span className="muted" style={{ fontSize: 12 }}>
          ⚠ 更换嵌入模型后，已索引文档需要重建索引才能被搜到
        </span>
      </div>
    </div>
  );
}

/* ---------- 数据库 ---------- */

function DbSection({ cfg }: { cfg: SysCfg }) {
  const [host, setHost] = useState(cfg.db.host);
  const [port, setPort] = useState(cfg.db.port);
  const [name, setName] = useState(cfg.db.name);
  const [user, setUser] = useState(cfg.db.user);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState(false);

  const reveal = async () => {
    try {
      const r = await api.post<{ values: Record<string, string> }>(
        "/admin/system-config/reveal",
        { fields: ["db_password"] },
      );
      setPassword(r.values.db_password ?? "");
      toast("已填入明文（查看动作已记审计）");
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "查看失败");
    }
  };

  const dbTest = async () => {
    setBusy("test");
    try {
      const r = await api.post<{ ok: boolean; error?: string }>(
        "/admin/system-config/db-test",
        { host, port, name, user, password },
      );
      if (r.ok) toast("连接成功");
      else toastErr(r.error ?? "连接失败");
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "连接失败");
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    setBusy("save");
    setConfirming(false);
    try {
      const r = await api.put<{ note: string }>("/admin/system-config/db", {
        host,
        port,
        name,
        user,
        password,
      });
      toast(r.note);
    } catch (e) {
      toastErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <h4 style={{ margin: "0 0 8px" }}>
        数据库连接{" "}
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          当前来源：.env · 修改需重启后端生效
        </span>
      </h4>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Field label="主机">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            style={{ width: 180 }}
          />
        </Field>
        <Field label="端口">
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            style={{ width: 80 }}
          />
        </Field>
        <Field label="库名">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: 140 }}
          />
        </Field>
        <Field label="用户">
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            style={{ width: 120 }}
          />
        </Field>
        <Field label="密码">
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ width: 160, ...SECRET_INPUT }}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={cfg.db.password_masked || "未设置"}
              autoComplete="off"
            />
            <Button onClick={() => void reveal()}>查看明文</Button>
          </div>
        </Field>
      </div>
      <div className="toolbar">
        <Button kind="primary" disabled={!!busy} onClick={() => void dbTest()}>
          {busy === "test" ? "测试中…" : "测试连接"}
        </Button>
        <Button disabled={!!busy} onClick={() => setConfirming(true)}>
          保存（写回 .env）
        </Button>
        <span className="muted" style={{ fontSize: 12 }}>
          保存前会先做连通性测试
        </span>
      </div>
      {confirming && (
        <ConfirmModal
          title="确认修改数据库连接"
          message={`将把新的数据库连接写入 .env（${host}:${port}/${name}），重启后端后生效。\n当前连接在重启前保持不变。确定保存？`}
          danger={true}
          onOk={() => void save()}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
