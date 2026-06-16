#!/usr/bin/env bash
# TaskStation (Vikunjaフォーク) 日次バックアップ。
#
# 何を: Vikunja公式 `dump` で db + files + env(設定) + version を整合性のとれた単一zipに固める。
#        ライブSQLiteを安全にスナップショットするため `cp` ではなく公式dumpを使う。
# いつ: 毎日 00:00 に systemd user timer (taskstation-backup.timer) から起動。
#        00:00起動なので「前日1日分の最終状態」を前日の日付ラベルで保存する。
# どこへ: $BACKUP_DIR に vikunja-YYYYMMDD.zip（リポジトリ外。data主権）。
# 復元: `docker exec -i pm-vikunja /app/vikunja/vikunja restore <zip>`（HANDOFF §7参照、要停止調整）。
#
# 手動実行も可: bash taskstation-backup.sh
# SoT: capacity-dashboard/ops/ （README.md参照）。配備先 ~/.local/bin/。
set -euo pipefail

CONTAINER=pm-vikunja
BACKUP_DIR=/home/neo/backups/taskstation
RETENTION_DAYS=30

# 00:00起動 → 直前に終わった「前日」の日付でラベル付け
LABEL=$(date -d 'yesterday' +%Y%m%d)
DEST="$BACKUP_DIR/vikunja-${LABEL}.zip"

mkdir -p "$BACKUP_DIR"

# コンテナ稼働確認（落ちてたら明示的に失敗させてjournalに残す）
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "ERROR: container '$CONTAINER' is not running" >&2
  exit 1
fi

# コンテナ内 /tmp でdump（cwdに自動命名zipを吐く）→ host へ取り出し → コンテナ内cleanup
docker exec -w /tmp "$CONTAINER" sh -c 'rm -f /tmp/vikunja-dump_*.zip; /app/vikunja/vikunja dump >/tmp/_dump.log 2>&1'
INNER=$(docker exec "$CONTAINER" sh -c 'ls -1 /tmp/vikunja-dump_*.zip 2>/dev/null | head -1')
if [ -z "$INNER" ]; then
  echo "ERROR: dump file was not produced. dump log follows:" >&2
  docker exec "$CONTAINER" cat /tmp/_dump.log >&2 || true
  exit 1
fi
docker cp "$CONTAINER:$INNER" "$DEST"
docker exec "$CONTAINER" sh -c 'rm -f /tmp/vikunja-dump_*.zip /tmp/_dump.log'

# 整合性確認（zipが壊れていないか）。壊れていれば残骸を消して失敗。
if ! unzip -t "$DEST" >/dev/null 2>&1; then
  echo "ERROR: produced zip is corrupt: $DEST" >&2
  rm -f "$DEST"
  exit 1
fi

echo "OK: $DEST ($(du -h "$DEST" | cut -f1))"

# 保持期間を超えた古いバックアップを削除（mtime基準）
find "$BACKUP_DIR" -maxdepth 1 -name 'vikunja-*.zip' -mtime +"$RETENTION_DAYS" -delete
