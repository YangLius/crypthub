#!/usr/bin/env python
"""离线恢复脚本（设计 4.5「离线破窗机制」）。

在隔离环境（或直连只读副本）解出全部密钥条目明文。全程不出本机。

用法：
  python offline_recover.py --package org_recovery_package.json --code <离线恢复码> \
      [--database postgresql://user:pass@host:5432/kb] [--dump secrets.sql] [--out recovered.json]

三种输入方式（二选一或组合）：
  --database  直连在线库（建议只读账号）
  --dump      已恢复的 pg_dump 产生的 SQL？不解析 SQL——请先恢复到隔离库再用 --database
  --json      从备份系统导出的 JSON 行文件（backup.sh 附带 tools/export_secrets_json.py 时可选）

输出：recovered.json（条目明文数组；用完即删）。
"""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import mirror_crypto as mc  # noqa: E402


def load_package(path: str) -> dict:
    try:
        pkg = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SystemExit(f"恢复包读取/解析失败: {e}") from e
    for k in ("offline_salt_b64", "org_priv_offline_wrapped_b64"):
        if k not in pkg:
            raise SystemExit(f"恢复包缺少字段 {k}")
    if pkg.get("aad") != mc.AAD_ORG_OFFLINE:
        raise SystemExit("恢复包 AAD 不匹配，可能是其他版本的包")
    return pkg


def unwrap_org_priv(pkg: dict, code: str) -> bytes:
    salt_raw = pkg["offline_salt_b64"]
    # 兼容两种编码：hex（offline-package 端点导出）与 base64
    try:
        salt = bytes.fromhex(salt_raw) if all(c in "0123456789abcdefABCDEF" for c in salt_raw) \
            and len(salt_raw) == 32 else base64.b64decode(salt_raw)
    except (ValueError, binascii.Error):
        salt = base64.b64decode(salt_raw)
    kdf = pkg.get("kdf", {})
    expected = {"algo": "argon2id", "m_kb": mc.ARGON2_M // 1024, "t": mc.ARGON2_T, "p": mc.ARGON2_P}
    for k, v in expected.items():
        if kdf.get(k) != v:
            raise SystemExit(f"恢复包 KDF 参数不匹配: {k}={kdf.get(k)!r}，期望 {v!r}")
    key = mc.argon2id(code.encode(), salt)
    return mc.aead_open(key, base64.b64decode(pkg["org_priv_offline_wrapped_b64"]),
                        mc.AAD_ORG_OFFLINE)


def fetch_rows(db_url: str) -> list[dict]:
    try:
        import psycopg
    except ImportError as e:
        raise SystemExit("请先安装 psycopg: pip install \"psycopg[binary]\"") from e
    with psycopg.connect(db_url) as conn:
        cur = conn.execute(
            "SELECT id, name, project, env, version, content_ct, dek_wrapped_org FROM secrets"
            " ORDER BY project, name")
        cols = [d.name for d in cur.description or ()]
        return [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]
    return []


def main() -> None:
    ap = argparse.ArgumentParser(description="离线恢复：解开全部密钥条目（本地执行）")
    ap.add_argument("--package", required=True, help="离线恢复包 JSON（管理员后台导出）")
    ap.add_argument("--code", required=True, help="离线恢复码（纸上那张）")
    ap.add_argument("--database", default=None, help="postgresql:// 只读连接串")
    ap.add_argument("--out", default="recovered.json", help="输出文件（用完即删）")
    args = ap.parse_args()

    pkg = load_package(args.package)
    print("[1/3] 解开组织私钥…")
    org_priv = unwrap_org_priv(pkg, args.code)

    if not args.database:
        raise SystemExit("请提供 --database（建议只读账号；pg_dump 请先恢复到隔离库）")

    print("[2/3] 读取条目密文…")
    rows = fetch_rows(args.database)
    if not rows:
        raise SystemExit("库中没有条目")

    print(f"[3/3] 解密 {len(rows)} 条…")
    out = []
    for r in rows:
        try:
            dek = mc.open_org_wrapped_dek(org_priv, r["dek_wrapped_org"], str(r["id"]))
            plain = mc.decrypt_secret_content(dek, r["content_ct"], str(r["id"]))
            content = json.loads(plain.decode("utf-8"))
            out.append({"name": r["name"], "project": r["project"], "env": r["env"],
                        "version": r["version"], "content": content})
            print(f"  ✔ {r['name']}")
        except Exception as e:
            out.append({"name": r["name"], "error": f"{type(e).__name__}: {e}"})
            print(f"  ✘ {r['name']}: {e}")
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"完成 → {args.out}（查看后请立即安全删除）")


if __name__ == "__main__":
    main()
