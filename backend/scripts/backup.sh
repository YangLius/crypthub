#!/usr/bin/env bash
# 每日备份（设计 10.3）：pg_dump → gzip → AES 加密 → 备份目录（可再同步到对象存储）
# 用法: backup.sh            （读环境变量 DATABASE_URL / BACKUP_DIR / BACKUP_PASS_FILE）
# crontab 示例: 0 2 * * * /opt/kb/backend/scripts/backup.sh >> /var/log/kb-backup.log 2>&1
set -euo pipefail

: "${DATABASE_URL:?请设置 DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/kb}"
BACKUP_PASS_FILE="${BACKUP_PASS_FILE:-/etc/kb/backup.pass}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
RAW="$BACKUP_DIR/kb_${STAMP}.sql.gz"
ENC="$RAW.enc"

echo "[backup] pg_dump → gzip"
pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip -6 > "$RAW"

echo "[backup] AES-256 加密（PBKDF2）"
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$RAW" -out "$ENC" -pass file:"$BACKUP_PASS_FILE"
rm -f "$RAW"

# 异地同步（可选：配置后自动上传；示例为 rclone，未配置则跳过）
if command -v rclone >/dev/null 2>&1 && [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "[backup] rclone → $BACKUP_REMOTE"
  rclone copy "$ENC" "$BACKUP_REMOTE"
fi

echo "[backup] 清理 $RETENTION_DAYS 天前的旧备份"
find "$BACKUP_DIR" -name "kb_*.sql.gz.enc" -mtime +"$RETENTION_DAYS" -delete

echo "[backup] 完成: $ENC ($(du -h "$ENC" | cut -f1))"
