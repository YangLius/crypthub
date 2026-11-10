"""前端加密的 Python 镜像实现（与 docs/03-加密流程伪代码.md 完全一致）。

用途：offline_recover.py 离线解密、互操作测试。
编码约定：字节 ↔ base64(标准)；文本 UTF-8；AAD 为 UTF-8 字节。
"""
from __future__ import annotations

import base64
import hashlib
import hmac as _hmac
import os

from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

# ---------- 常量（锁定，勿改） ----------
ARGON2_M = 64 * 1024  # 64 MiB（单位 KB）
ARGON2_T = 3
ARGON2_P = 1
KEY_LEN = 32
NONCE_LEN = 12

# AAD / info 注册表（前端 core.ts 必须一致）
AAD_LOCAL_CHECK = "kb:local-check"
AAD_USER_PRIV = "kb:user-priv:"            # + userId
AAD_USER_PRIV_RK = "kb:user-priv-rk"
AAD_ENTRY = "kb:secret:"                  # + secretId
AAD_DEK = "kb:dek:"                        # + secretId + ":" + userId
AAD_ORG_DEK = "kb:org-dek:"                # + secretId
AAD_ORG_DELEGATE = "kb:org-delegate:"      # + userId
AAD_ORG_OFFLINE = "kb:org-offline"
INFO_SEAL = "kb:seal:"                     # + aad


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode()


def b64d(s: str) -> bytes:
    return base64.b64decode(s)


# ---------- KDF ----------

def argon2id(password: bytes, salt: bytes) -> bytes:
    return hash_secret_raw(secret=password, salt=salt, time_cost=ARGON2_T,
                           memory_cost=ARGON2_M, parallelism=ARGON2_P,
                           hash_len=KEY_LEN, type=Type.ID)


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = KEY_LEN) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info).derive(ikm)


def derive_auth_key(mp: str, salt_auth: bytes) -> bytes:
    return hkdf_sha256(argon2id(mp.encode(), salt_auth), b"kb:auth", b"auth")


def derive_auth_proof_key(mp: str, salt_auth: bytes) -> bytes:
    """登录证明密钥 = 服务端持有的 auth_verifier（hex 存储）。"""
    return hkdf_sha256(derive_auth_key(mp, salt_auth), b"kb:ap", b"ap")


def derive_enc_key(mp: str, salt_enc: bytes) -> bytes:
    return hkdf_sha256(argon2id(mp.encode(), salt_enc), b"kb:enc", b"enc")


# ---------- AEAD ----------

def aead_seal(key: bytes, plaintext: bytes, aad: str) -> bytes:
    nonce = os.urandom(NONCE_LEN)
    return nonce + AESGCM(key).encrypt(nonce, plaintext, aad.encode())


def aead_open(key: bytes, blob: bytes, aad: str) -> bytes:
    if len(blob) < NONCE_LEN + 16:
        raise ValueError("密文过短")
    return AESGCM(key).decrypt(blob[:NONCE_LEN], blob[NONCE_LEN:], aad.encode())


# ---------- ECIES（X25519 + HKDF + AES-GCM） ----------

def x25519_keygen() -> tuple[bytes, bytes]:
    priv = X25519PrivateKey.generate()
    return priv.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                              serialization.NoEncryption()), \
        priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def x25519_shared(my_priv: bytes, peer_pub: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(my_priv).exchange(
        X25519PublicKey.from_public_bytes(peer_pub))


def ecies_seal(recip_pub: bytes, plaintext: bytes, aad: str) -> bytes:
    eph_priv, eph_pub = x25519_keygen()
    ss = x25519_shared(eph_priv, recip_pub)
    key = hkdf_sha256(ss, eph_pub + recip_pub, (INFO_SEAL + aad).encode())
    return eph_pub + aead_seal(key, plaintext, aad)


def ecies_open(my_priv: bytes, blob: bytes, aad: str) -> bytes:
    if len(blob) < 32 + NONCE_LEN + 16:
        raise ValueError("信封过短")
    eph_pub, rest = blob[:32], blob[32:]
    my_key = X25519PrivateKey.from_private_bytes(my_priv)
    my_pub = my_key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    ss = my_key.exchange(X25519PublicKey.from_public_bytes(eph_pub))
    key = hkdf_sha256(ss, eph_pub + my_pub, (INFO_SEAL + aad).encode())
    return aead_open(key, rest, aad)


# ---------- 便捷封装（与前端 flows.ts 对齐） ----------

def unwrap_user_priv_with_enc(enc_key: bytes, priv_wrapped_b64: str, user_id: str) -> bytes:
    return aead_open(enc_key, b64d(priv_wrapped_b64), AAD_USER_PRIV + user_id)


def unwrap_user_priv_with_rk(rk: str, rk_salt: bytes, priv_rk_wrapped_b64: str) -> bytes:
    return aead_open(argon2id(rk.encode(), rk_salt), b64d(priv_rk_wrapped_b64), AAD_USER_PRIV_RK)


def unwrap_org_priv_offline(offline_code: str, offline_salt: bytes, wrapped_b64: str) -> bytes:
    return aead_open(argon2id(offline_code.encode(), offline_salt), b64d(wrapped_b64),
                     AAD_ORG_OFFLINE)


def unwrap_org_delegate(admin_priv: bytes, sealed_b64: str, admin_user_id: str) -> bytes:
    return ecies_open(admin_priv, b64d(sealed_b64), AAD_ORG_DELEGATE + admin_user_id)


def open_org_wrapped_dek(org_priv: bytes, sealed_b64: str, secret_id: str) -> bytes:
    return ecies_open(org_priv, b64d(sealed_b64), AAD_ORG_DEK + secret_id)


def open_user_wrapped_dek(user_priv: bytes, sealed_b64: str, secret_id: str, user_id: str) -> bytes:
    return ecies_open(user_priv, b64d(sealed_b64), AAD_DEK + secret_id + ":" + user_id)


def decrypt_secret_content(dek: bytes, content_ct_b64: str, secret_id: str) -> bytes:
    return aead_open(dek, b64d(content_ct_b64), AAD_ENTRY + secret_id)


def hmac_hex(key: bytes, msg: str) -> str:
    return _hmac.new(key, msg.encode(), hashlib.sha256).hexdigest()
