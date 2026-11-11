"""单测：Python 镜像加密（与前端 TS 实现同规范，docs/03-加密流程伪代码.md）。

若存在 frontend/tests/vectors.json（由前端 vitest 生成），则额外做 TS↔PY 互操作验证。
"""

import base64
import json
from pathlib import Path

import pytest
from cryptography.exceptions import InvalidTag

from app import mirror_crypto as mc

VECTORS_FILE = (
    Path(__file__).resolve().parent.parent.parent
    / "frontend"
    / "tests"
    / "vectors.json"
)


def test_kdf_deterministic():
    k1 = mc.derive_enc_key("正确的主密码", b"0123456789abcdef")
    k2 = mc.derive_enc_key("正确的主密码", b"0123456789abcdef")
    assert k1 == k2 and len(k1) == 32
    assert mc.derive_enc_key("错误的主密码", b"0123456789abcdef") != k1
    # auth / enc 域分离
    assert mc.derive_auth_key("同一个密码", b"s" * 16) != mc.derive_enc_key(
        "同一个密码", b"s" * 16
    )


def test_auth_proof_chain():
    """登录证明链：authKey 派生 authProofKey，服务端只见后者。"""
    auth_key = mc.derive_auth_key("mp-123", b"a" * 16)
    proof_key = mc.hkdf_sha256(auth_key, b"kb:ap", b"ap")
    assert proof_key != auth_key
    sig = mc.hmac_hex(proof_key, "challenge-nonce")
    assert sig == mc.hmac_hex(proof_key, "challenge-nonce")
    assert sig != mc.hmac_hex(proof_key, "challenge-nonce2")


def test_aead_roundtrip_and_tamper():
    key = mc.derive_enc_key("pw", b"0123456789abcdef")
    blob = mc.aead_seal(key, "机密内容".encode(), mc.AAD_LOCAL_CHECK)
    assert mc.aead_open(key, blob, mc.AAD_LOCAL_CHECK) == "机密内容".encode()
    # AAD 绑定：换域即失败
    with pytest.raises(InvalidTag):
        mc.aead_open(key, blob, mc.AAD_USER_PRIV + "uid")
    # 篡改密文即失败
    bad = bytearray(blob)
    bad[-1] ^= 1
    with pytest.raises(InvalidTag):
        mc.aead_open(key, bytes(bad), mc.AAD_LOCAL_CHECK)
    # 错误密钥失败
    other = mc.derive_enc_key("pw2", b"0123456789abcdef")
    with pytest.raises(InvalidTag):
        mc.aead_open(other, blob, mc.AAD_LOCAL_CHECK)


def test_ecies_roundtrip():
    priv, pub = mc.x25519_keygen()
    blob = mc.ecies_seal(
        pub, b"DEK-32-bytes-xxxxxxxxxxxxxxxx", mc.AAD_ORG_DELEGATE + "uid1"
    )
    assert (
        mc.ecies_open(priv, blob, mc.AAD_ORG_DELEGATE + "uid1")
        == b"DEK-32-bytes-xxxxxxxxxxxxxxxx"
    )
    # AAD 不匹配失败
    with pytest.raises(InvalidTag):
        mc.ecies_open(priv, blob, mc.AAD_ORG_DELEGATE + "uid2")


def test_full_zero_knowledge_chain():
    """端到端场景：建号 → 建条目 → 另一用户共享 → 双方解开 → 组织恢复路径。"""
    # 用户A 建号材料
    salt_a = b"1" * 16
    enc_a = mc.derive_enc_key("mpA", salt_a)
    priv_a, pub_a = mc.x25519_keygen()
    check = mc.aead_seal(enc_a, b"vault-check-v1", mc.AAD_LOCAL_CHECK)
    assert mc.aead_open(enc_a, check, mc.AAD_LOCAL_CHECK) == b"vault-check-v1"

    # 组织密钥
    org_priv, org_pub = mc.x25519_keygen()

    # 用户B
    priv_b, pub_b = mc.x25519_keygen()

    # A 建条目：DEK → 内容；包装给 A/B/组织
    dek = mc.b64d(mc.b64e(bytes(range(32))))  # 32B 随机
    sid = "s-0001"
    content_ct_b64 = mc.b64e(mc.aead_seal(dek, b'{"token":"p@ss"}', mc.AAD_ENTRY + sid))
    w_a = mc.ecies_seal(pub_a, dek, mc.AAD_DEK + sid + ":" + "uid-a")
    w_b = mc.ecies_seal(pub_b, dek, mc.AAD_DEK + sid + ":" + "uid-b")
    w_org = mc.ecies_seal(org_pub, dek, mc.AAD_ORG_DEK + sid)

    # A 解开
    dek_a = mc.ecies_open(priv_a, w_a, mc.AAD_DEK + sid + ":" + "uid-a")
    obj = json.loads(mc.decrypt_secret_content(dek_a, content_ct_b64, sid))
    assert obj["token"] == "p@ss"
    # B 解开
    dek_b = mc.ecies_open(priv_b, w_b, mc.AAD_DEK + sid + ":" + "uid-b")
    assert dek_b == dek
    # 组织恢复路径：管理员解出组织私钥 → 解 DEK
    dek_org = mc.ecies_open(org_priv, w_org, mc.AAD_ORG_DEK + sid)
    assert dek_org == dek

    # 离线恢复码路径
    offline_code = "OFFLINE-CODE-0123456789abcdef"
    offline_salt = b"3" * 16
    wrapped = mc.aead_seal(
        mc.argon2id(offline_code.encode(), offline_salt), org_priv, mc.AAD_ORG_OFFLINE
    )
    org_priv2 = mc.unwrap_org_priv_offline(offline_code, offline_salt, mc.b64e(wrapped))
    assert org_priv2 == org_priv

    # 个人恢复码路径：RK 解用户私钥
    rk = "RK-" + "9" * 32
    rk_salt = b"4" * 16
    rk_wrapped = mc.aead_seal(
        mc.argon2id(rk.encode(), rk_salt), priv_a, mc.AAD_USER_PRIV_RK
    )
    assert mc.unwrap_user_priv_with_rk(rk, rk_salt, mc.b64e(rk_wrapped)) == priv_a


def test_b64_roundtrip():
    raw = bytes(range(256))
    assert mc.b64d(mc.b64e(raw)) == raw


@pytest.mark.skipif(
    not VECTORS_FILE.exists(), reason="前端互操作向量未生成（frontend npm test 生成）"
)
def test_typescript_interop():
    """TS 侧生成的向量：Python 必须能解开（证明两端实现一致）。"""
    vectors = json.loads(VECTORS_FILE.read_text(encoding="utf-8"))
    # KDF 一致性
    assert (
        mc.hkdf_sha256(
            mc.argon2id(
                vectors["mp"].encode(), base64.b64decode(vectors["salt_auth_b64"])
            ),
            b"kb:auth",
            b"auth",
        )
        is not None
    )
    proof = mc.derive_auth_proof_key(
        vectors["mp"], base64.b64decode(vectors["salt_auth_b64"])
    )
    assert proof.hex() == vectors["auth_proof_key_hex"]
    enc = mc.derive_enc_key(vectors["mp"], base64.b64decode(vectors["salt_enc_b64"]))
    plain = mc.aead_open(
        enc, base64.b64decode(vectors["local_check_ct_b64"]), mc.AAD_LOCAL_CHECK
    )
    assert plain == b"vault-check-v1"
    # ECIES：TS 密封 → PY 解开（收件人私钥由 TS 侧固定在向量里）
    opened = mc.ecies_open(
        base64.b64decode(vectors["recipient_priv_b64"]),
        base64.b64decode(vectors["ecies_ct_b64"]),
        vectors["ecies_aad"],
    )
    assert opened == vectors["ecies_plain"].encode()
