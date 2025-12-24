#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist-local"

echo "Building Autohand ACP for local installation..."

# Clean and create dist directory
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Build TypeScript
echo "Compiling TypeScript..."
cd "$ROOT_DIR"
npm run build

# Create the distribution package
echo "Creating distribution package..."
mkdir -p "$DIST_DIR/package"

# Copy necessary files
cp -r "$ROOT_DIR/dist" "$DIST_DIR/package/"
cp "$ROOT_DIR/package.json" "$DIST_DIR/package/"
cp -r "$ROOT_DIR/node_modules" "$DIST_DIR/package/"

# Create the launcher script
cat > "$DIST_DIR/package/autohand-acp" << 'LAUNCHER'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/dist/index.js" "$@"
LAUNCHER
chmod +x "$DIST_DIR/package/autohand-acp"

# Detect platform
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

if [ "$ARCH" = "arm64" ]; then
    ARCH_NAME="arm64"
elif [ "$ARCH" = "x86_64" ]; then
    ARCH_NAME="x64"
else
    ARCH_NAME="$ARCH"
fi

ARCHIVE_NAME="autohand-acp-${PLATFORM}-${ARCH_NAME}"

# Create archive
echo "Creating archive: ${ARCHIVE_NAME}.tar.gz"
cd "$DIST_DIR/package"
tar -czf "../${ARCHIVE_NAME}.tar.gz" .

# Calculate SHA256
SHA256=$(shasum -a 256 "$DIST_DIR/${ARCHIVE_NAME}.tar.gz" | cut -d' ' -f1)

echo ""
echo "✅ Build complete!"
echo ""
echo "Archive: $DIST_DIR/${ARCHIVE_NAME}.tar.gz"
echo "SHA256:  $SHA256"
echo ""
echo "To test locally:"
echo "1. Start local server: cd $DIST_DIR && python3 -m http.server 8765"
echo "2. Update extension.toml archive URL to: http://localhost:8765/${ARCHIVE_NAME}.tar.gz"
echo "3. In Zed: Command Palette > 'zed: install dev extension' > select $ROOT_DIR"
echo ""
echo "Or add to Zed settings.json for quick testing:"
echo ""
cat << EOF
{
  "agent_servers": {
    "Autohand CLI": {
      "command": "node",
      "args": ["$ROOT_DIR/dist/index.js"],
      "env": {
        "AUTOHAND_PERMISSION_MODE": "external"
      }
    }
  }
}
EOF
