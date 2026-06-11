#!/usr/bin/env bash
# CoreMem backup — laptop-friendly: meant to be invoked hourly (launchd
# StartInterval); actually backs up only when the last success is older than
# MIN_AGE_HOURS. So the backup lands once a day, in the first working window
# the machine is awake, regardless of when the lid is open.
#
# Backs up:
#   1. Postgres `knowledge` DB (pg_dump custom format) — the semantic layer
#      alone is hours of LLM extraction.
#   2. The vault (tar.gz) — the human canon; losing it loses everything.
#
# Config via env (or .env in the repo root):
#   BACKUP_DIR        default: ~/Backups/coremem
#   MIN_AGE_HOURS     default: 20
#   KEEP_COPIES       default: 14
#   BACKUP_REMOTE     rclone remote for offsite copies, e.g. "gdrive:coremem-backups"
#                     (one-time setup: brew install rclone && rclone config —
#                      create a remote named "gdrive" of type "drive" / Google Drive).
#                     If unset, defaults to gdrive:coremem-backups when an
#                     rclone remote called "gdrive" exists; otherwise skipped.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$REPO_DIR/.env" ] && set -a && source "$REPO_DIR/.env" && set +a

BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/coremem}"
MIN_AGE_HOURS="${MIN_AGE_HOURS:-20}"
KEEP_COPIES="${KEEP_COPIES:-14}"
MARKER="$BACKUP_DIR/.last-success"

mkdir -p "$BACKUP_DIR"

# Skip if the last successful backup is fresh enough.
if [ -f "$MARKER" ]; then
  last=$(cat "$MARKER")
  now=$(date +%s)
  age_hours=$(( (now - last) / 3600 ))
  if [ "$age_hours" -lt "$MIN_AGE_HOURS" ]; then
    exit 0
  fi
fi

STAMP=$(date +%Y-%m-%d_%H%M)
echo "[backup] starting ($STAMP)"

# 1. Postgres (custom format → pg_restore-able, compressed)
export PGPASSWORD="${POSTGRES_PASSWORD:-}"
pg_dump -h "${POSTGRES_HOST:-localhost}" -p "${POSTGRES_PORT:-5432}" \
        -U "${POSTGRES_USER:-$USER}" -Fc "${POSTGRES_DB:-knowledge}" \
        > "$BACKUP_DIR/knowledge-$STAMP.dump.tmp"
mv "$BACKUP_DIR/knowledge-$STAMP.dump.tmp" "$BACKUP_DIR/knowledge-$STAMP.dump"
echo "[backup] postgres: $(du -h "$BACKUP_DIR/knowledge-$STAMP.dump" | cut -f1)"

# 2. Vault (exclude Obsidian caches/trash)
VAULT="${OBSIDIAN_VAULT_PATH:?OBSIDIAN_VAULT_PATH not set}"
tar -czf "$BACKUP_DIR/vault-$STAMP.tar.gz.tmp" \
    --exclude='.obsidian/cache' --exclude='.obsidian/workspace*' --exclude='.trash' \
    -C "$(dirname "$VAULT")" "$(basename "$VAULT")"
mv "$BACKUP_DIR/vault-$STAMP.tar.gz.tmp" "$BACKUP_DIR/vault-$STAMP.tar.gz"
echo "[backup] vault: $(du -h "$BACKUP_DIR/vault-$STAMP.tar.gz" | cut -f1)"

# 3. Rotate: keep newest KEEP_COPIES of each kind
for pattern in 'knowledge-*.dump' 'vault-*.tar.gz'; do
  ls -t "$BACKUP_DIR"/$pattern 2>/dev/null | tail -n +$((KEEP_COPIES + 1)) | xargs -I{} rm -f {}
done

# 4. Offsite copy via rclone (Google Drive etc.) — optional, never fatal.
REMOTE="${BACKUP_REMOTE:-}"
if [ -z "$REMOTE" ] && command -v rclone >/dev/null 2>&1 \
   && rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
  REMOTE="gdrive:coremem-backups"
fi
if [ -n "$REMOTE" ] && command -v rclone >/dev/null 2>&1; then
  if rclone sync "$BACKUP_DIR" "$REMOTE" --exclude '.last-success' --exclude '.rclone-errors.log' \
       --transfers 2 --timeout 5m 2>>"$BACKUP_DIR/.rclone-errors.log"; then
    echo "[backup] offsite: synced to $REMOTE"
  else
    echo "[backup] offsite: FAILED (see $BACKUP_DIR/.rclone-errors.log) — local backup is intact"
  fi
else
  echo "[backup] offsite: skipped (no rclone remote configured — run: rclone config)"
fi

date +%s > "$MARKER"
echo "[backup] done → $BACKUP_DIR"
