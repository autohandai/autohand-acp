#!/bin/bash
# NUCLEAR option - completely remove all traces of autohand extension from Zed
# Run this when cached/stale versions refuse to update

set -e

echo "☢️  NUKING autohand extension from Zed..."
echo ""

# Kill Zed if running
echo "Killing Zed..."
pkill -9 Zed 2>/dev/null || echo "Zed not running"
sleep 1

# Zed directories
ZED_SUPPORT="$HOME/Library/Application Support/Zed"
ZED_CACHES="$HOME/Library/Caches/Zed"

# Remove ALL possible extension locations
echo "Removing extension files..."

# Installed extensions (both autohand and autohand-acp patterns)
rm -rf "$ZED_SUPPORT/extensions/installed/autohand"* 2>/dev/null && echo "✓ Removed installed autohand extensions"
rm -rf "$ZED_SUPPORT/extensions/installed/autohand-acp"* 2>/dev/null && echo "✓ Removed installed autohand-acp extensions"
rm -rf "$ZED_SUPPORT/extensions/work/autohand"* 2>/dev/null && echo "✓ Removed work extensions"

# External agents (downloaded binaries)
rm -rf "$ZED_SUPPORT/external_agents/autohand"* 2>/dev/null && echo "✓ Removed external agents"

# Extension registry/index - force rebuild
rm -f "$ZED_SUPPORT/extensions/index.json" 2>/dev/null && echo "✓ Removed extension index"

# Dev extensions symlinks
rm -rf "$ZED_SUPPORT/extensions/dev/autohand"* 2>/dev/null && echo "✓ Removed dev extensions"

# Zed caches
rm -rf "$ZED_CACHES"/*autohand* 2>/dev/null && echo "✓ Removed Zed caches"

# Clear SQLite database entries (agent panel cache)
echo ""
echo "Clearing database cache..."
if [ -f "$ZED_SUPPORT/db/0-stable/db.sqlite" ]; then
  sqlite3 "$ZED_SUPPORT/db/0-stable/db.sqlite" "
    DELETE FROM kv_store WHERE key LIKE '%agent%';
    DELETE FROM kv_store WHERE value LIKE '%autohand%';
    DELETE FROM kv_store WHERE value LIKE '%Autohand%';
  " 2>/dev/null && echo "✓ Cleared agent panel cache"

  # Commit WAL changes
  sqlite3 "$ZED_SUPPORT/db/0-stable/db.sqlite" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null

  # Remove WAL files to ensure clean state
  rm -f "$ZED_SUPPORT/db/0-stable/db.sqlite-wal" 2>/dev/null
  rm -f "$ZED_SUPPORT/db/0-stable/db.sqlite-shm" 2>/dev/null
fi

# Clear threads database
if [ -f "$ZED_SUPPORT/threads/threads.db" ]; then
  sqlite3 "$ZED_SUPPORT/threads/threads.db" "DELETE FROM threads WHERE summary LIKE '%autohand%' OR summary LIKE '%Autohand%';" 2>/dev/null && echo "✓ Cleared autohand threads"
fi

# Remove saved application state
rm -rf "$HOME/Library/Saved Application State/dev.zed.Zed.savedState" 2>/dev/null && echo "✓ Removed saved application state"

# Clean local dist
echo ""
echo "Rebuilding extension..."
cd "$(dirname "$0")/.."
rm -rf dist
bun run build

echo ""
echo "✅ DONE! Now:"
echo "   1. Open Zed"
echo "   2. Extensions → Install Dev Extension"
echo "   3. Select: $(pwd)"
echo ""
