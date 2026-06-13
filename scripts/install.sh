#!/usr/bin/env bash
# Knowledge Mesh (Knowledge Mesh) — interactive installer.
# Safe to re-run: it detects existing databases/services and asks before touching anything.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

ask() { # ask "prompt" "default" -> REPLY
  local prompt="$1" default="${2-}"
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " REPLY || true
    REPLY="${REPLY:-$default}"
  else
    read -r -p "$prompt: " REPLY || true
  fi
}

confirm() { # confirm "prompt" (default yes) -> 0/1
  local prompt="$1" default="${2:-y}"
  read -r -p "$prompt [$([ "$default" = y ] && echo Y/n || echo y/N)]: " REPLY || true
  REPLY="${REPLY:-$default}"
  [[ "$REPLY" =~ ^[Yy] ]]
}

bold "Knowledge Mesh (Knowledge Mesh) installer"
echo "One shared memory for humans and AI agents."
echo "Your notes stay plain markdown — get Obsidian (free) to edit them: https://obsidian.md"
echo

# ── 1. Prerequisites ─────────────────────────────────────────────
bold "1/6 Checking prerequisites"
MISSING=0
need() {
  if command -v "$1" >/dev/null 2>&1; then ok "$1 $($1 --version 2>/dev/null | head -1 | cut -c1-40)"; else fail "$1 — $2"; MISSING=1; fi
}
need node "install Node.js >= 20 (https://nodejs.org or nvm)"
need pnpm "corepack enable && corepack prepare pnpm@latest --activate"
need psql "PostgreSQL >= 14: brew install postgresql@16 && brew services start postgresql@16"
if command -v claude >/dev/null 2>&1; then
  ok "claude CLI (extractor engine)"
else
  warn "claude CLI not found — semantic extraction won't work until you install Claude Code (https://claude.com/claude-code). Search/index work without it."
fi
if [ "$MISSING" = 1 ]; then
  fail "Install the missing prerequisites above and re-run."
  exit 1
fi

NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || { fail "Node >= 20 required (found $(node --version))"; exit 1; }

# ── 2. PostgreSQL ────────────────────────────────────────────────
bold "2/6 PostgreSQL"
ask "Postgres host" "localhost";      PG_HOST="$REPLY"
ask "Postgres port" "5432";           PG_PORT="$REPLY"
ask "Postgres user" "${USER}";        PG_USER="$REPLY"
ask "Postgres password (empty if none)" ""; PG_PASS="$REPLY"
ask "Database name for Knowledge Mesh" "knowledge"; PG_DB="$REPLY"

export PGPASSWORD="$PG_PASS"
if ! pg_isready -h "$PG_HOST" -p "$PG_PORT" >/dev/null 2>&1; then
  fail "Postgres is not reachable at $PG_HOST:$PG_PORT — start it and re-run."
  exit 1
fi
ok "Postgres is up"

if psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc \
     "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" 2>/dev/null | grep -q 1; then
  warn "Database '$PG_DB' already exists."
  TABLES=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "?")
  echo "    It contains $TABLES table(s). The schema migration is additive (IF NOT EXISTS) and won't drop data."
  if ! confirm "  Use this existing database?"; then
    ask "  Enter a different database name" "knowledge_mesh"; PG_DB="$REPLY"
    psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -c "CREATE DATABASE \"$PG_DB\"" >/dev/null
    ok "created database '$PG_DB'"
  fi
else
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -c "CREATE DATABASE \"$PG_DB\"" >/dev/null
  ok "created database '$PG_DB'"
fi

if ! psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" -tAc \
     "SELECT 1 FROM pg_available_extensions WHERE name='vector'" | grep -q 1; then
  fail "pgvector extension is not available in this Postgres. Install it (brew: included in postgresql@16; apt: postgresql-16-pgvector) and re-run."
  exit 1
fi
ok "pgvector available"

# ── 3. Neo4j ─────────────────────────────────────────────────────
bold "3/6 Neo4j"
ask "Neo4j bolt URI" "bolt://localhost:7687"; NEO4J_URI="$REPLY"
ask "Neo4j user" "neo4j";                     NEO4J_USER="$REPLY"

NEO4J_HTTP="http://$(echo "$NEO4J_URI" | sed -E 's|^bolt://||; s|:[0-9]+$||'):7474"
if curl -s -m 3 -o /dev/null "$NEO4J_HTTP"; then
  ok "Neo4j is already running at $NEO4J_HTTP — will use it"
  ask "Neo4j password (existing)" ""; NEO4J_PASS="$REPLY"
else
  warn "Neo4j is not running at $NEO4J_HTTP."
  if confirm "  Install & start Neo4j via Homebrew now?"; then
    brew list neo4j >/dev/null 2>&1 || brew install neo4j
    ask "  Set a NEW Neo4j password" "knowledge-mesh-$(date +%s | tail -c 5)"; NEO4J_PASS="$REPLY"
    /opt/homebrew/opt/neo4j/bin/neo4j-admin dbms set-initial-password "$NEO4J_PASS" || \
      warn "could not set initial password (maybe already initialized) — make sure the password you entered is correct"
    brew services start neo4j
    echo -n "  waiting for Neo4j to come up"
    for _ in $(seq 1 45); do
      curl -s -m 2 -o /dev/null "$NEO4J_HTTP" && break; echo -n "."; sleep 2
    done; echo
    ok "Neo4j started"
  else
    ask "  Neo4j password (I'll trust the URI works later)" ""; NEO4J_PASS="$REPLY"
  fi
fi

# ── 4. Vault & .env ──────────────────────────────────────────────
bold "4/6 Vault and configuration"
echo "  The vault is a folder of markdown notes — your knowledge."
echo "  Tip: open it in Obsidian (https://obsidian.md) as your editor."
DEFAULT_VAULT="$HOME/Documents/KnowledgeMeshVault"
ask "Path to your vault (existing or new)" "$DEFAULT_VAULT"; VAULT_PATH="$REPLY"
VAULT_PATH="${VAULT_PATH/#\~/$HOME}"
if [ ! -d "$VAULT_PATH" ]; then
  if confirm "  '$VAULT_PATH' does not exist. Create it with a starter structure?"; then
    mkdir -p "$VAULT_PATH"/{projects,ideas,decisions,people,technologies,meetings,daily,agents,archive}
    cat > "$VAULT_PATH/ideas/welcome-to-knowledge-mesh.md" <<'NOTE'
---
tags: [knowledge-mesh]
---

# Welcome to Knowledge Mesh

This vault is your shared memory with AI agents. Write notes in plain
markdown — they become searchable in seconds and part of a knowledge graph
within minutes. Edit with Obsidian: https://obsidian.md
NOTE
    ok "vault created with starter structure"
  else
    fail "Vault path is required."; exit 1
  fi
else
  NOTE_COUNT=$(find "$VAULT_PATH" -name '*.md' -not -path '*/.obsidian/*' 2>/dev/null | wc -l | tr -d ' ')
  ok "vault found ($NOTE_COUNT markdown notes)"
fi

ask "Knowledge API port" "3333"; API_PORT="$REPLY"

if [ -f .env ]; then
  warn ".env already exists."
  confirm "  Overwrite it with the new configuration?" n && WRITE_ENV=1 || WRITE_ENV=0
else
  WRITE_ENV=1
fi
if [ "$WRITE_ENV" = 1 ]; then
  cat > .env <<ENV
OBSIDIAN_VAULT_PATH=$VAULT_PATH

POSTGRES_HOST=$PG_HOST
POSTGRES_PORT=$PG_PORT
POSTGRES_DB=$PG_DB
POSTGRES_USER=$PG_USER
POSTGRES_PASSWORD=$PG_PASS

NEO4J_URI=$NEO4J_URI
NEO4J_USER=$NEO4J_USER
NEO4J_PASSWORD="$NEO4J_PASS"

API_PORT=$API_PORT

EMBEDDING_MODEL=onnx-community/Qwen3-Embedding-0.6B-ONNX
EMBEDDING_DIM=1024
EMBEDDING_DTYPE=q8
EMBEDDING_REMOTE_URL=http://localhost:$API_PORT
ENV
  ok ".env written"
else
  warn "keeping existing .env — make sure it matches what you entered"
fi

# ── 5. Install & migrate ─────────────────────────────────────────
bold "5/6 Dependencies and schema"
pnpm install
pnpm migrate
ok "schema applied"

# ── 6. Services, MCP, first index ────────────────────────────────
bold "6/6 Services and first run"

if [ "$(uname)" = "Darwin" ] && confirm "Install background services (launchd: API + vault watcher, start at login)?"; then
  PNPM_BIN="$(command -v pnpm)"
  NODE_BIN_DIR="$(dirname "$(command -v node)")"
  CLAUDE_BIN_DIR="$(dirname "$(command -v claude 2>/dev/null || echo /usr/local/bin/claude)")"
  SVC_PATH="$CLAUDE_BIN_DIR:$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  for svc in api watcher extract; do
    case $svc in
      api)     ARGS="api";        EXTRA="<key>KeepAlive</key><true/>";;
      watcher) ARGS="index:watch"; EXTRA="<key>KeepAlive</key><true/>";;
      extract) ARGS="extract";    EXTRA="<key>StartInterval</key><integer>1800</integer>";;
    esac
    PLIST="$HOME/Library/LaunchAgents/com.knowledge-mesh.$svc.plist"
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.knowledge-mesh.$svc</string>
  <key>ProgramArguments</key><array>
    <string>$PNPM_BIN</string><string>--dir</string><string>$REPO_DIR</string><string>$ARGS</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$SVC_PATH</string></dict>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>RunAtLoad</key><$([ "$svc" = extract ] && echo "false/" || echo "true/")>
  $EXTRA
  <key>StandardOutPath</key><string>$HOME/Library/Logs/knowledge-mesh-$svc.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-mesh-$svc.log</string>
</dict></plist>
PLIST_EOF
    launchctl bootout "gui/$(id -u)/com.knowledge-mesh.$svc" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)/" "$PLIST"
  done
  ok "services installed: API, watcher, scheduled extraction (logs in ~/Library/Logs/knowledge-mesh-*.log)"
  echo -n "  waiting for the API"
  for _ in $(seq 1 30); do curl -s -m 2 "http://localhost:$API_PORT/health" >/dev/null 2>&1 && break; echo -n "."; sleep 1; done; echo
else
  warn "skipped services — run 'pnpm api' and 'pnpm index:watch' manually"
fi

if command -v claude >/dev/null 2>&1 && confirm "Register the MCP server in Claude Code (user-wide)?"; then
  claude mcp remove -s user knowledge-mesh 2>/dev/null || true
  claude mcp add -s user knowledge-mesh -- pnpm --dir "$REPO_DIR" mcp
  ok "MCP server 'knowledge-mesh' registered (9 knowledge_* tools in every session)"
fi

if confirm "Run the first full index now (embedding model ~650 MB downloads on first run)?"; then
  pnpm index --force
  ok "vault indexed"
  if command -v claude >/dev/null 2>&1 && confirm "Run semantic extraction too (LLM reads every note — ~25s per note on your Claude subscription)?" n; then
    pnpm extract
  else
    warn "skipped — extraction runs automatically in the background (or: pnpm extract)"
  fi
fi

echo
bold "Done!"
echo "  • Edit notes in your vault with Obsidian: https://obsidian.md (open '$VAULT_PATH' as a vault)"
echo "  • Search:  curl 'http://localhost:$API_PORT/search?q=hello'"
echo "  • Graph:   open Neo4j Browser at ${NEO4J_HTTP:-http://localhost:7474}"
echo "  • Agents:  ask Claude Code anything — it now has knowledge_* tools"
echo "  • Health:  pnpm golden   • Docs: docs/apps/README.md"
