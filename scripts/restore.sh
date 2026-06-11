#!/usr/bin/env bash
# CoreMem restore — interactive recovery from backups made by scripts/backup.sh.
#
# Restores either or both:
#   - Postgres `knowledge` DB (pg_restore from knowledge-*.dump)  [DESTRUCTIVE]
#   - the vault (from vault-*.tar.gz; current vault is moved aside, not deleted)
#
# Sources backups from BACKUP_DIR (default ~/Backups/coremem); if an rclone
# 'gdrive' remote exists, offers to pull the offsite copies down first.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
[ -f "$REPO_DIR/.env" ] && set -a && source "$REPO_DIR/.env" && set +a

BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/coremem}"
PG_HOST="${POSTGRES_HOST:-localhost}"; PG_PORT="${POSTGRES_PORT:-5432}"
PG_USER="${POSTGRES_USER:-$USER}";    PG_DB="${POSTGRES_DB:-knowledge}"
export PGPASSWORD="${POSTGRES_PASSWORD:-}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
confirm() { read -r -p "$1 [y/N]: " R || true; [[ "${R:-n}" =~ ^[Yy] ]]; }

bold "CoreMem restore"

# ── 0. Optionally pull offsite copies ────────────────────────────
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
  if confirm "Sync offsite backups from Google Drive into $BACKUP_DIR first?"; then
    rclone copy "gdrive:coremem-backups" "$BACKUP_DIR" --transfers 2
    echo "  pulled."
  fi
fi

# ── 1. Pick a backup timestamp ───────────────────────────────────
mapfile -t DUMPS < <(ls -t "$BACKUP_DIR"/knowledge-*.dump 2>/dev/null || true)
[ ${#DUMPS[@]} -gt 0 ] || { echo "No backups found in $BACKUP_DIR"; exit 1; }

echo; bold "Available backups (newest first):"
for i in "${!DUMPS[@]}"; do
  stamp=$(basename "${DUMPS[$i]}" | sed -E 's/^knowledge-(.+)\.dump$/\1/')
  vault_file="$BACKUP_DIR/vault-$stamp.tar.gz"
  printf "  %2d) %s  (db %s%s)\n" "$((i+1))" "$stamp" \
    "$(du -h "${DUMPS[$i]}" | cut -f1)" \
    "$([ -f "$vault_file" ] && echo ", vault $(du -h "$vault_file" | cut -f1)" || echo ", vault MISSING")"
done
read -r -p "Pick a backup [1]: " PICK || true
PICK="${PICK:-1}"
DUMP="${DUMPS[$((PICK-1))]}"
STAMP=$(basename "$DUMP" | sed -E 's/^knowledge-(.+)\.dump$/\1/')
VAULT_TAR="$BACKUP_DIR/vault-$STAMP.tar.gz"
bold "Selected: $STAMP"

# ── 2. What to restore ───────────────────────────────────────────
RESTORE_DB=0; RESTORE_VAULT=0
confirm "Restore the Postgres database '$PG_DB'? (DESTRUCTIVE — replaces current data)" && RESTORE_DB=1
if [ -f "$VAULT_TAR" ]; then
  confirm "Restore the vault from this backup? (current vault is moved aside, not deleted)" && RESTORE_VAULT=1
fi
[ "$RESTORE_DB" = 1 ] || [ "$RESTORE_VAULT" = 1 ] || { echo "Nothing selected."; exit 0; }

# ── 3. Stop services that hold DB connections / write the vault ──
STOPPED=()
if [ "$(uname)" = "Darwin" ]; then
  for svc in api watcher extract; do
    if launchctl list 2>/dev/null | grep -q "com.knowledge-mesh.$svc"; then
      launchctl bootout "gui/$(id -u)/com.knowledge-mesh.$svc" 2>/dev/null || true
      STOPPED+=("$svc")
    fi
  done
  [ ${#STOPPED[@]} -gt 0 ] && echo "  stopped services: ${STOPPED[*]}"
fi

restart_services() {
  for svc in "${STOPPED[@]}"; do
    launchctl bootstrap "gui/$(id -u)/" "$HOME/Library/LaunchAgents/com.knowledge-mesh.$svc.plist" 2>/dev/null || true
  done
  [ ${#STOPPED[@]} -gt 0 ] && echo "  restarted services: ${STOPPED[*]}"
}
trap restart_services EXIT

# ── 4. Restore DB ────────────────────────────────────────────────
if [ "$RESTORE_DB" = 1 ]; then
  bold "Restoring database from $(basename "$DUMP")…"
  # Verify the dump first against a scratch DB? pg_restore --list is cheap validation:
  pg_restore --list "$DUMP" >/dev/null
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -qc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$PG_DB' AND pid <> pg_backend_pid()" >/dev/null
  pg_restore -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" \
    --clean --if-exists --no-owner -d "$PG_DB" "$DUMP"
  echo "  database restored."
fi

# ── 5. Restore vault ─────────────────────────────────────────────
if [ "$RESTORE_VAULT" = 1 ]; then
  VAULT="${OBSIDIAN_VAULT_PATH:?OBSIDIAN_VAULT_PATH not set}"
  VAULT="${VAULT%/}"
  ASIDE="${VAULT}.pre-restore-$(date +%Y%m%d_%H%M%S)"
  bold "Restoring vault from $(basename "$VAULT_TAR")…"
  [ -d "$VAULT" ] && mv "$VAULT" "$ASIDE" && echo "  current vault moved to: $ASIDE"
  mkdir -p "$(dirname "$VAULT")"
  tar -xzf "$VAULT_TAR" -C "$(dirname "$VAULT")"
  echo "  vault restored to $VAULT"
fi

# ── 6. Reconcile ─────────────────────────────────────────────────
restart_services; trap - EXIT; STOPPED=()
echo
bold "Reconciling index and graph (pnpm index)…"
echo "  (waiting for the API to come back up)"
for _ in $(seq 1 30); do
  curl -s -m 2 "http://localhost:${API_PORT:-3333}/health" >/dev/null 2>&1 && break; sleep 1
done
pnpm --dir "$REPO_DIR" index
echo
bold "Done. Run 'pnpm run doctor' to verify."
