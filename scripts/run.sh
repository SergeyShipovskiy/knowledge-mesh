#!/bin/bash
# Runs `pnpm --dir <repo> <args>` on the Node version pinned in .nvmrc. Every launchd service
# and the MCP server start through this file, so upgrading Node means changing .nvmrc only,
# never the plists or ~/.claude.json.
#
# .nvmrc pins an exact version on purpose. On macOS the vault usually lives under ~/Documents,
# and the TCC grant that lets headless launchd jobs read it is tied to the node binary's path.
# A path that changes on its own (say, after `nvm install 22` brings a new patch) leaves the
# watcher blocked on a consent prompt nobody sees. Upgrade deliberately: bump .nvmrc, then
# `launchctl kickstart` the services and approve the one-time Documents prompt.
#
# nvm's versions dir is read directly instead of sourcing nvm.sh: sourcing is slow and can
# print to stdout, which corrupts the MCP stdio stream. Diagnostics go to stderr only.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WANT="$(tr -d ' v\n' < "$REPO_DIR/.nvmrc")"
MAJOR="${WANT%%.*}"
NVM_VERSIONS="${NVM_DIR:-$HOME/.nvm}/versions/node"

die() { echo "knowledge-mesh run.sh: $*" >&2; exit 1; }

NODE_DIR=""
if [ -d "$NVM_VERSIONS/v$WANT" ]; then
  NODE_DIR="$NVM_VERSIONS/v$WANT"
else
  NODE_DIR="$(ls -d "$NVM_VERSIONS/v$MAJOR".* 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$NODE_DIR" ] && echo "knowledge-mesh run.sh: v$WANT not installed, using $(basename "$NODE_DIR")" >&2
fi

if [ -n "$NODE_DIR" ]; then
  export PATH="$NODE_DIR/bin:$PATH"
elif command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" = "$MAJOR" ]; then
  : # No nvm install of that major, but the node already on PATH matches it.
else
  die "Node $WANT not found (looked in $NVM_VERSIONS and on PATH). Install it: nvm install $WANT"
fi

command -v pnpm >/dev/null 2>&1 ||
  die "pnpm is not installed for node $(node --version). Install it: PATH=$(dirname "$(command -v node)"):\$PATH npm install -g pnpm"

# Claude Code starts the MCP server from whatever project is open. corepack's pnpm shim checks
# the packageManager field of the cwd's package.json, not --dir, and refuses to run inside a
# yarn project, so the cwd must be this repo.
cd "$REPO_DIR"
exec pnpm --dir "$REPO_DIR" "$@"
