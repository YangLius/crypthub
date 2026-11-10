#!/usr/bin/env bash
# 恢复（每月真实恢复演练用，设计 10.3）
# 用法: restore.sh <备份文件.enc> <目标数据库URL>
# 例:   restore.sh /var/backups/kb/kb_20260101_020000.sql.gz.enc postgresql://kb:kb@localhost:5432/kb_restore
set -euo pipefail

ENC="${1:?用法: restore.sh <备份文件.enc> <目标数据库URL>}"
TARGET_URL="${2:?用法: restore.sh <备份文件.enc> <目标数据库URL>}"
BACKUP_PASS_FILE="${BACKUP_PASS_FILE:-/etc/kb/backup.pass}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[restore] 解密 → 解压"
openssl enc -d -aes-256-cbc -pbkdf2 -in "$ENC" -out "$WORK/dump.sql.gz" -pass file:"$BACKUP_PASS_FILE"
gunzip -c "$WORK/dump.sql.gz" > "$WORK/dump.sql"

echo "[restore] 写入目标库（库需已存在且为空）"
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f "$WORK/dump.sql"

echo "[restore] 完成。验证要点：users/secrets/documents 行数；拿一条密文走离线恢复脚本解密核对。"
