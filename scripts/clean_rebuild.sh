#!/bin/bash
# Clean rebuild script for autohand-acp extension development
# Removes cached binaries and extension files so Zed will download fresh

set -e

echo "🧹 Cleaning autohand-acp extension cache..."

# Remove external agents cache (downloaded binaries)
rm -rf "$HOME/Library/Application Support/Zed/external_agents/autohand-acp" 2>/dev/null && \
  echo "✓ Removed external_agents cache" || \
  echo "- No external_agents cache found"

# Remove installed extension symlink/folder
rm -rf "$HOME/Library/Application Support/Zed/extensions/installed/autohand-acp" 2>/dev/null && \
  echo "✓ Removed installed extension" || \
  echo "- No installed extension found"

echo ""
echo "📦 Current extension version:"
grep 'version = ' extension.toml | head -1

echo ""
echo "🔗 Archive URLs point to:"
grep 'archive = ' extension.toml | head -1 | sed 's/.*download\/\(vv[^/]*\).*/\1/'

echo ""
echo "📋 Next steps:"
echo "   1. Quit Zed completely (Cmd+Q)"
echo "   2. Reopen Zed"
echo "   3. Extensions → Install Dev Extension"
echo "   4. Select: $(pwd)"
echo ""
echo "Done! 🎉"
