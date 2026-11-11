"""端到端联调冒烟：用 mirror_crypto 模拟浏览器，对运行中的 API 走完整用户旅程。

前置：uvicorn(8000) + worker + dev_redis 已启动，.env 已配置（远程 DB + 智谱）。
运行：python scripts/smoke_e2e.py
覆盖：引导→建号→登录→上传→服务端兜底扫描→索引(真实embedding)→检索→
      AI问答(真实LLM)→解锁→建条目→reveal解密→共享→跨用户403→审计。
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
import uuid

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app import mirror_crypto as mc  # noqa: E402

BASE = os.getenv("SMOKE_BASE", "http://127.0.0.1:8000")
MP_ADMIN = "主密码-管理员-#Sm0ke-42"
MP_BOB = "主密码-bob-#Sm0ke-77"

STEPS: list[tuple[str, bool, str]] = []


def step(name: str, ok: bool, note: str = "") -> None:
    STEPS.append((name, ok, note))
    print(f"{'PASS' if ok else 'FAIL'} | {name}" + (f" | {note}" if note else ""))


def build_material(mp: str, uid: str, *, org: dict | None) -> dict:
    salt_auth = os.urandom(16)
    salt_enc = os.urandom(16)
    proof_hex = mc.derive_auth_proof_key(mp, salt_auth).hex()
    enc = mc.derive_enc_key(mp, salt_enc)
    priv, pub = mc.x25519_keygen()
    rk = base64.b32encode(os.urandom(20)).decode()
    rk_salt = os.urandom(16)
    rk_key = mc.argon2id(rk.encode(), rk_salt)
    m = {
        "salt_auth": mc.b64e(salt_auth),
        "salt_enc": mc.b64e(salt_enc),
        "auth_verifier": proof_hex,
        "local_check_ct": mc.b64e(
            mc.aead_seal(enc, b"vault-check-v1", mc.AAD_LOCAL_CHECK)
        ),
        "public_key": mc.b64e(pub),
        "priv_wrapped": mc.b64e(mc.aead_seal(enc, priv, mc.AAD_USER_PRIV + uid)),
        "rk_salt": mc.b64e(rk_salt),
        "priv_rk_wrapped": mc.b64e(mc.aead_seal(rk_key, priv, mc.AAD_USER_PRIV_RK)),
    }
    if org is not None:
        oc = org["code"]
        offline_salt = os.urandom(16)
        org_priv, org_pub = mc.x25519_keygen()
        m.update(
            {
                "org_public_key": mc.b64e(org_pub),
                "org_offline_salt": mc.b64e(offline_salt),
                "org_priv_offline_wrapped": mc.b64e(
                    mc.aead_seal(
                        mc.argon2id(oc.encode(), offline_salt),
                        org_priv,
                        mc.AAD_ORG_OFFLINE,
                    )
                ),
                "org_delegate_sealed": mc.b64e(
                    mc.ecies_seal(pub, org_priv, mc.AAD_ORG_DELEGATE + uid)
                ),
            }
        )
        org["priv"], org["pub"] = org_priv, org_pub
    return m


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=120)

    # ---------- 0. 引导 ----------
    r = c.get("/auth/bootstrap-status").json()
    step("bootstrap-status", r.get("needs_bootstrap") is True, str(r))

    r = c.post(
        "/auth/bootstrap-init", json={"username": "admin", "display_name": "管理员"}
    )
    token = r.json().get("setup_token", "")
    step("bootstrap-init", bool(token))

    r = c.get("/auth/setup-info", params={"token": token}).json()
    uid_a = r.get("user_id", "")
    needs_org = r.get("needs_org")
    step("setup-info", bool(uid_a) and needs_org is True, f"uid={uid_a[:8]}…")

    org: dict = {"code": base64.b32encode(os.urandom(20)).decode()}
    m = build_material(MP_ADMIN, uid_a, org=org)
    r = c.post("/auth/setup", json={"token": token, "display_name": "管理员", **m})
    step(
        "setup(admin+org)", r.status_code == 200, f"http={r.status_code} {r.text[:120]}"
    )

    # ---------- 1. 登录（挑战-应答） ----------
    ch = c.post("/auth/challenge", json={"username": "admin"}).json()
    proof = mc.hmac_hex(bytes.fromhex(m["auth_verifier"]), ch["challenge"])
    r = c.post("/auth/login", json={"challenge_id": ch["challenge_id"], "proof": proof})
    ok = r.status_code == 200
    step("challenge/login", ok, f"http={r.status_code} {r.text[:120]}")

    me = c.get("/auth/me").json()
    ok = me.get("username") == "admin" and me.get("has_org") is True
    step(
        "auth/me",
        ok,
        json.dumps(
            {k: me.get(k) for k in ("username", "role", "has_org", "unlocked")},
            ensure_ascii=False,
        ),
    )

    # 错误密码应登录失败
    ch2 = c.post("/auth/challenge", json={"username": "admin"}).json()
    bad_proof_key = mc.derive_auth_proof_key("错误密码", mc.b64d(ch2["salt_auth"]))
    bad = mc.hmac_hex(bad_proof_key, ch2["challenge"])
    r = c.post("/auth/login", json={"challenge_id": ch2["challenge_id"], "proof": bad})
    step("login(错误密码拒绝)", r.status_code in (401, 404), f"http={r.status_code}")

    # ---------- 2. 上传文档（含凭据 → 服务端兜底扫描） ----------
    doc_text = (
        "# 服务部署手册\n\n"
        "本文档描述内部系统的部署方式。\n\n"
        "## 数据库连接\n"
        "DATABASE_URL=postgres://admin:S3cretDbPass42@db.internal:5432/app\n\n"
        "## 凭据\n"
        "password: hunter2secret9\n"
        "github_token: ghp_Abcd1234567890abcdefEfgh567890ab\n\n"
        "## 架构说明\n"
        "系统由 api、worker、postgres、redis 四个服务组成，通过 docker compose 编排。\n"
        "检索采用混合方案：向量检索与关键词检索经 RRF 融合排序。\n"
        "问答服务引用文档上下文并输出引用锚点。\n"
    )
    r = c.post(
        "/documents",
        files={"file": ("deploy.md", doc_text.encode(), "text/markdown")},
        data={"title": "联调部署手册", "project": "smoke", "tags": "demo,联调"},
    )
    doc = r.json()
    doc_id = doc.get("id", "")
    step(
        "documents/upload",
        r.status_code == 200 and bool(doc_id),
        f"http={r.status_code} {str(r.json())[:120]}",
    )

    # 重复上传应 409
    r2 = c.post(
        "/documents",
        files={"file": ("deploy2.md", doc_text.encode(), "text/markdown")},
        data={"title": "重复"},
    )
    step("documents/upload(去重409)", r2.status_code == 409, f"http={r2.status_code}")

    # ---------- 3. 等待索引（worker：解析→兜底扫描→分块→真实embedding→入库） ----------
    deadline = time.time() + 120
    status = ""
    d: dict = {}
    while time.time() < deadline:
        d = c.get(f"/documents/{doc_id}").json()
        status = d.get("status", "")
        if status in ("ready", "failed"):
            break
        time.sleep(3)
    err = d.get("error") or ""
    step(
        "worker 索引完成",
        status == "ready",
        f"status={status} chunks={d.get('chunk_count')} err={err[:100]}",
    )

    pend = c.get("/documents/pending").json()
    n_pending = len(pend.get("pending", pend if isinstance(pend, list) else []))
    step("服务端兜底扫描→待认领", n_pending >= 2, f"pending={n_pending}")

    # ---------- 4. 检索 ----------
    r = c.post("/search", json={"q": "数据库连接方式"})
    hits = r.json().get("results", [])
    ok = r.status_code == 200 and len(hits) >= 1 and hits[0]["document_id"] == doc_id
    step(
        "search(向量+关键词RRF)",
        ok,
        f"hits={len(hits)} top={hits[0]['title'] if hits else '-'}",
    )

    r = c.post("/search", json={"q": "RRF 融合排序"})
    hits2 = r.json().get("results", [])
    step("search(关键词命中)", len(hits2) >= 1, f"hits={len(hits2)}")

    # ---------- 5. AI 问答（真实 LLM） ----------
    r = c.post("/chat", json={"question": "系统的数据库连接配置在哪里？"})
    cj = r.json()
    ok = r.status_code == 200 and bool(cj.get("answer")) and not cj.get("blocked")
    step(
        "chat(真实LLM)",
        ok,
        f"answer={str(cj.get('answer'))[:80]}… cites={len(cj.get('citations', []))}",
    )

    # ---------- 6. 解锁 + 建密钥条目 + reveal ----------
    r = c.post("/secrets/unlock", json={"ok": True})
    step("secrets/unlock", r.status_code == 200 and r.json().get("unlocked") is True)

    sid = str(uuid.uuid4())
    dek = os.urandom(32)
    secret_plain = json.dumps(
        {"username": "deploy", "password": "p@ss-联调-99"}, ensure_ascii=False
    )
    content_ct = mc.b64e(mc.aead_seal(dek, secret_plain.encode(), mc.AAD_ENTRY + sid))
    # 解出管理员私钥并恢复公钥（模拟浏览器解锁后拿到的密钥材料）
    enc_admin = mc.derive_enc_key(MP_ADMIN, mc.b64d(m["salt_enc"]))
    priv_a = mc.aead_open(
        enc_admin, mc.b64d(m["priv_wrapped"]), mc.AAD_USER_PRIV + uid_a
    )
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    pub_a = (
        X25519PrivateKey.from_private_bytes(priv_a)
        .public_key()
        .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    )
    body = {
        "id": sid,
        "name": "生产数据库",
        "project": "smoke",
        "env": "prod",
        "tags": ["db"],
        "content_ct": content_ct,
        "dek_wrapped_org": mc.b64e(
            mc.ecies_seal(org["pub"], dek, mc.AAD_ORG_DEK + sid)
        ),
        "grants": [
            {
                "user_id": uid_a,
                "wrapped_dek": mc.b64e(
                    mc.ecies_seal(pub_a, dek, mc.AAD_DEK + sid + ":" + uid_a)
                ),
            }
        ],
    }

    r = c.post("/secrets", json=body)
    ok = r.status_code == 200 and r.json().get("id") == sid
    step("secrets/create(AAD绑定)", ok, f"http={r.status_code} {r.text[:120]}")

    rv = c.get(f"/secrets/{sid}/reveal").json()
    try:
        dek2 = mc.ecies_open(
            priv_a, mc.b64d(rv["wrapped_dek"]), mc.AAD_DEK + sid + ":" + uid_a
        )
        plain = mc.aead_open(
            dek2, mc.b64d(rv["content_ct"]), mc.AAD_ENTRY + sid
        ).decode()
        ok = plain == secret_plain
        note = "解密一致"
    except Exception as e:
        ok, note = False, f"{type(e).__name__}: {e}"
    step("reveal+本地解密闭环", ok, note)

    # 未解锁/未授权用户访问
    # （先锁回自己，确认锁定后 reveal 被拒）
    c.post("/secrets/lock")
    r = c.get(f"/secrets/{sid}/reveal")
    step(
        "lock 后 reveal 拒绝(423/403)",
        r.status_code in (403, 423),
        f"http={r.status_code}",
    )
    c.post("/secrets/unlock", json={"ok": True})

    # ---------- 7. 第二用户（跨用户 403 验收） ----------
    r = c.post(
        "/admin/users",
        json={"username": "bob", "display_name": "测试用户", "role": "member"},
    )
    bob_token = r.json().get("setup_token", "")
    step("admin/users(开号 bob)", r.status_code == 200 and bool(bob_token))

    r = c.get("/auth/setup-info", params={"token": bob_token}).json()
    uid_b = r.get("user_id", "")
    mb = build_material(MP_BOB, uid_b, org=None)
    r = c.post(
        "/auth/setup", json={"token": bob_token, "display_name": "测试用户", **mb}
    )
    step(
        "setup(bob, 无需org)",
        r.status_code == 200,
        f"http={r.status_code} needs_org={r.get('needs_org') if isinstance(r, dict) else ''}",
    )

    chb = c.post("/auth/challenge", json={"username": "bob"}).json()
    proofb = mc.hmac_hex(bytes.fromhex(mb["auth_verifier"]), chb["challenge"])
    r = c.post(
        "/auth/login", json={"challenge_id": chb["challenge_id"], "proof": proofb}
    )
    step("login(bob)", r.status_code == 200)

    r = c.get(f"/secrets/{sid}/reveal")
    step(
        "跨用户 reveal 403", r.status_code == 403, f"http={r.status_code} {r.text[:80]}"
    )
    r = c.get("/secrets")
    names = [s["name"] for s in r.json().get("items", r.json().get("secrets", []))]
    step("跨用户列表不可见", all(n != "生产数据库" for n in names), f"bob可见={names}")

    # bob 的搜索应该正常（文档全员可见）
    r = c.post("/search", json={"q": "部署方式"})
    step(
        "bob search 正常",
        r.status_code == 200 and len(r.json().get("results", [])) >= 1,
    )

    # ---------- 7.5 多级目录（切回 admin 会话：建号/归档都是 admin 视角） ----------
    cha0 = c.post("/auth/challenge", json={"username": "admin"}).json()
    proofa0 = mc.hmac_hex(bytes.fromhex(m["auth_verifier"]), cha0["challenge"])
    c.post("/auth/login", json={"challenge_id": cha0["challenge_id"], "proof": proofa0})

    r = c.post("/folders", json={"kind": "doc", "name": "运维手册"})
    doc_folder = (r.json().get("folder") or {}).get("id", "")
    step("folders: 建根目录", r.status_code == 200 and bool(doc_folder))

    r = c.post(
        "/folders", json={"kind": "doc", "name": "网络", "parent_id": doc_folder}
    )
    sub_folder = (r.json().get("folder") or {}).get("id", "")
    step("folders: 建子目录", r.status_code == 200 and bool(sub_folder))

    r = c.patch(f"/folders/{doc_folder}", json={"name": "运维文档", "parent_id": None})
    step("folders: 重命名", r.status_code == 200)

    r = c.post(
        "/folders", json={"kind": "doc", "name": "网络", "parent_id": doc_folder}
    )
    step("folders: 同级同名拒绝 400", r.status_code == 400)

    # 环拒绝：把父目录移到自己子目录下
    r = c.patch(
        f"/folders/{doc_folder}",
        json={"name": "运维文档", "parent_id": sub_folder},
    )
    step("folders: 移入自己子树拒绝 400", r.status_code == 400)

    # 文档归档到子目录并回读
    r = c.patch(f"/documents/{doc_id}", json={"folder_id": sub_folder})
    step("folders: 文档归档", r.status_code == 200)
    r = c.get(f"/documents/{doc_id}")
    step(
        "folders: 文档目录回读一致",
        r.status_code == 200 and r.json().get("folder_id") == sub_folder,
        f"folder_id={r.json().get('folder_id')}",
    )

    # 密钥目录（admin 私有树）+ 归档回读
    r = c.post("/folders", json={"kind": "secret", "name": "生产凭据"})
    sec_folder = (r.json().get("folder") or {}).get("id", "")
    step("folders: 建密钥目录", r.status_code == 200 and bool(sec_folder))
    r = c.patch(f"/secrets/{sid}/folder", json={"folder_id": sec_folder})
    step("folders: 密钥归档", r.status_code == 200)
    mine = c.get("/secrets").json().get("secrets", [])
    filed = [s for s in mine if s["id"] == sid]
    step(
        "folders: 密钥目录回读一致",
        bool(filed) and filed[0].get("folder_id") == sec_folder,
    )

    # bob 不能在 admin 的私有目录树下操作（父目录不可见 → 404）
    chb0 = c.post("/auth/challenge", json={"username": "bob"}).json()
    proofb0 = mc.hmac_hex(bytes.fromhex(mb["auth_verifier"]), chb0["challenge"])
    c.post("/auth/login", json={"challenge_id": chb0["challenge_id"], "proof": proofb0})
    r = c.post(
        "/folders",
        json={"kind": "secret", "name": "越权", "parent_id": sec_folder},
    )
    step("folders: 他人私有目录 404", r.status_code == 404)

    # 切回 admin（后续删除/审计都以 admin 身份）
    cha1 = c.post("/auth/challenge", json={"username": "admin"}).json()
    proofa1 = mc.hmac_hex(bytes.fromhex(m["auth_verifier"]), cha1["challenge"])
    c.post("/auth/login", json={"challenge_id": cha1["challenge_id"], "proof": proofa1})

    # 删除子目录 → 文档回到未归档
    r = c.delete(f"/folders/{sub_folder}")
    step("folders: 删除目录", r.status_code == 200)
    r = c.get(f"/documents/{doc_id}")
    step("folders: 删除后文档回根", r.json().get("folder_id") is None)

    # ---------- 8. 审计（切回 admin 会话，避免被 bob 的 cookie 覆盖） ----------
    cha = c.post("/auth/challenge", json={"username": "admin"}).json()
    proofa = mc.hmac_hex(bytes.fromhex(m["auth_verifier"]), cha["challenge"])
    c.post("/auth/login", json={"challenge_id": cha["challenge_id"], "proof": proofa})
    logs = c.get("/audit", params={"limit": "200"}).json().get("logs", [])
    actions = {row["action"] for row in logs}
    need = {
        "doc_uploaded",
        "secret_created",
        "secret_revealed",
        "unlock",
        "login_failed",
    }
    ok = need.issubset(actions)
    step("审计覆盖关键动作", ok, f"缺失={need - actions}")

    # ---------- 汇总 ----------
    fails = [s for s in STEPS if not s[1]]
    print(f"\n{'=' * 60}\n结果: {len(STEPS) - len(fails)}/{len(STEPS)} 通过")
    if fails:
        for name, _, note in fails:
            print(f"  FAIL: {name} | {note}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
