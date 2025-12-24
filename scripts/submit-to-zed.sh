#!/bin/bash
set -e

# Submit Autohand ACP to Zed Extension Registry
# Usage: ./scripts/submit-to-zed.sh [version]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Get version from argument or extension.toml
if [ -n "$1" ]; then
    VERSION="$1"
else
    VERSION=$(grep '^version' "$ROOT_DIR/extension.toml" | head -1 | sed 's/.*= *"\([^"]*\)".*/\1/')
fi

echo "Submitting Autohand ACP v${VERSION} to Zed Extension Registry"
echo ""

# Check for required files
for file in extension.toml LICENSE icons/autohand.svg; do
    if [ ! -f "$ROOT_DIR/$file" ]; then
        echo "❌ Missing required file: $file"
        exit 1
    fi
done
echo "✅ Required files present"

# Verify GitHub releases exist
REPO="autohandai/autohand-acp"
PLATFORMS=("darwin-arm64" "darwin-x64" "linux-x64" "windows-x64")

echo ""
echo "Checking GitHub releases..."
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == "windows"* ]]; then
        ext="zip"
    else
        ext="tar.gz"
    fi
    url="https://github.com/${REPO}/releases/download/v${VERSION}/autohand-acp-${platform}.${ext}"

    if curl --output /dev/null --silent --head --fail "$url"; then
        echo "✅ $platform archive available"
    else
        echo "❌ Missing: $url"
        echo ""
        echo "Please create a GitHub release first:"
        echo "  git tag v${VERSION}"
        echo "  git push origin v${VERSION}"
        echo "  # Then create release on GitHub or wait for CI"
        exit 1
    fi
done

echo ""
echo "================================================"
echo "All checks passed! Next steps:"
echo "================================================"
echo ""
echo "1. Fork https://github.com/zed-industries/extensions"
echo ""
echo "2. Clone your fork and add the submodule:"
echo "   git clone https://github.com/YOUR_USERNAME/extensions.git"
echo "   cd extensions"
echo "   git submodule add https://github.com/${REPO}.git extensions/autohand-acp"
echo ""
echo "3. Add to extensions.toml:"
cat << EOF

[autohand-acp]
submodule = "extensions/autohand-acp"
version = "${VERSION}"

EOF
echo ""
echo "4. Sort extensions: pnpm sort-extensions"
echo ""
echo "5. Commit and push:"
echo "   git add ."
echo "   git commit -m 'Add autohand-acp extension v${VERSION}'"
echo "   git push origin main"
echo ""
echo "6. Create PR to https://github.com/zed-industries/extensions"
echo ""
echo "PR Title: Add autohand-acp extension v${VERSION}"
echo ""
echo "================================================"
