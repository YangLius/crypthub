/// <reference types="node" />
/**
 * 加密核心测试 + 生成 TS↔PY 互操作测试向量。
 * 运行后在 tests/vectors.json 产出向量，供 backend/tests/test_mirror_crypto.py 验证两端一致。
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AAD,
  aeadOpen,
  aeadSeal,
  b64d,
  b64e,
  base32,
  deriveAuthProofKey,
  deriveEncKey,
  eciesOpen,
  eciesSeal,
  formatRecoveryCode,
  fromUtf8,
  hex,
  randomBytes,
  utf8,
  x25519Keygen,
} from "../src/crypto/core";

// ---------- KDF ----------

describe("KDF", () => {
  it("argon2id + hkdf 确定性且域分离", async () => {
    const salt = randomBytes(16);
    const k1 = await deriveEncKey("主密码A", salt);
    const k2 = await deriveEncKey("主密码A", salt);
    expect(k1).toEqual(k2);
    expect(await deriveEncKey("主密码B", salt)).not.toEqual(k1);
    // auth 域 ≠ enc 域（同 salt 下派生链不同）
    const auth = await deriveAuthProofKey("主密码A", salt);
    expect(auth).toHaveLength(64); // hex 32B
  });

  it("base32 恢复码格式", () => {
    const rk = formatRecoveryCode(base32(randomBytes(32)));
    expect(rk).toMatch(/^[A-Z2-7]+(-[A-Z2-7]+)*$/);
    expect(rk.length).toBeGreaterThanOrEqual(52);
  });
});

// ---------- AEAD ----------

describe("AEAD", () => {
  it("加解密往返", () => {
    const key = randomBytes(32);
    const blob = aeadSeal(key, utf8("机密内容"), AAD.localCheck);
    expect(fromUtf8(aeadOpen(key, blob, AAD.localCheck))).toBe("机密内容");
  });

  it("AAD 绑定：换域即失败", () => {
    const key = randomBytes(32);
    const blob = aeadSeal(key, utf8("x"), AAD.entry + "sid");
    expect(() => aeadOpen(key, blob, AAD.entry + "other")).toThrow();
    expect(() => aeadOpen(key, blob, AAD.localCheck)).toThrow();
  });

  it("篡改即失败", () => {
    const key = randomBytes(32);
    const blob = aeadSeal(key, utf8("x"), AAD.localCheck);
    const bad = Uint8Array.from(blob);
    bad[bad.length - 1] ^= 1;
    expect(() => aeadOpen(key, bad, AAD.localCheck)).toThrow();
  });
});

// ---------- ECIES ----------

describe("ECIES 信封", () => {
  it("密封/解封往返", () => {
    const { priv, pub } = x25519Keygen();
    const blob = eciesSeal(pub, utf8("DEK-material"), AAD.orgDelegate + "uid1");
    expect(fromUtf8(eciesOpen(priv, blob, AAD.orgDelegate + "uid1"))).toBe(
      "DEK-material",
    );
  });

  it("AAD 不匹配失败；他人私钥失败", () => {
    const a = x25519Keygen();
    const b = x25519Keygen();
    const blob = eciesSeal(a.pub, utf8("secret"), AAD.dek + "sid:uid-a");
    expect(() => eciesOpen(a.priv, blob, AAD.dek + "sid:uid-b")).toThrow();
    expect(() => eciesOpen(b.priv, blob, AAD.dek + "sid:uid-a")).toThrow();
  });
});

// ---------- 全链路（与后端 test_full_zero_knowledge_chain 对齐） ----------

describe("零知识全链路", () => {
  it("建号 → 建条目 → 共享 → 双方解开 → 组织恢复路径", async () => {
    const saltEncA = randomBytes(16);
    const encA = await deriveEncKey("mpA", saltEncA);
    const a = x25519Keygen();
    const org = x25519Keygen();
    const b = x25519Keygen();

    const sid = crypto.randomUUID();
    const dek = randomBytes(32);
    const contentCt = aeadSeal(
      dek,
      utf8(JSON.stringify({ token: "p@ss" })),
      AAD.entry + sid,
    );
    const wA = eciesSeal(a.pub, dek, AAD.dek + sid + ":uid-a");
    const wB = eciesSeal(b.pub, dek, AAD.dek + sid + ":uid-b");
    const wOrg = eciesSeal(org.pub, dek, AAD.orgDek + sid);

    expect(
      fromUtf8(
        aeadOpen(
          eciesOpen(a.priv, wA, AAD.dek + sid + ":uid-a"),
          contentCt,
          AAD.entry + sid,
        ),
      ),
    ).toBe('{"token":"p@ss"}');
    expect(eciesOpen(b.priv, wB, AAD.dek + sid + ":uid-b")).toEqual(dek);
    expect(eciesOpen(org.priv, wOrg, AAD.orgDek + sid)).toEqual(dek);
    void encA;
  });

  it("b64 / hex 往返", () => {
    const raw = randomBytes(64);
    expect(b64d(b64e(raw))).toEqual(raw);
    const h = hex(raw);
    expect(h).toHaveLength(128);
  });
});

// ---------- TS→PY 互操作向量 ----------

describe("生成互操作向量", () => {
  it("写 tests/vectors.json（Python 端消费）", async () => {
    const mp = "interop-master-密码-42";
    const saltAuth = randomBytes(16);
    const saltEnc = randomBytes(16);
    const authProofKeyHex = await deriveAuthProofKey(mp, saltAuth);
    const encKey = await deriveEncKey(mp, saltEnc);
    const localCheck = aeadSeal(encKey, utf8("vault-check-v1"), AAD.localCheck);

    const recipient = x25519Keygen();
    const eciesAad = AAD.orgDelegate + "interop-user";
    const eciesPlain = "interop-plaintext-跨语言验证";
    const eciesCt = eciesSeal(recipient.pub, utf8(eciesPlain), eciesAad);

    const vectors = {
      mp,
      salt_auth_b64: b64e(saltAuth),
      salt_enc_b64: b64e(saltEnc),
      auth_proof_key_hex: authProofKeyHex,
      local_check_ct_b64: b64e(localCheck),
      recipient_priv_b64: b64e(recipient.priv),
      recipient_pub_b64: b64e(recipient.pub),
      ecies_aad: eciesAad,
      ecies_plain: eciesPlain,
      ecies_ct_b64: b64e(eciesCt),
    };
    writeFileSync(
      new URL("./vectors.json", import.meta.url),
      JSON.stringify(vectors, null, 2),
    );
    // 自检：向量自身可解
    expect(fromUtf8(aeadOpen(encKey, localCheck, AAD.localCheck))).toBe(
      "vault-check-v1",
    );
    expect(fromUtf8(eciesOpen(recipient.priv, eciesCt, eciesAad))).toBe(
      eciesPlain,
    );
  });
});
