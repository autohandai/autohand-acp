#!/bin/bash
set -e

# Autohand ACP Release Script
# Usage: ./scripts/release.sh [major|minor|patch|x.y.z]
#
# Examples:
#   ./scripts/release.sh patch    # 0.1.1 -> 0.1.2
#   ./scripts/release.sh minor    # 0.1.1 -> 0.2.0
#   ./scripts/release.sh major    # 0.1.1 -> 1.0.0
#   ./scripts/release.sh 0.2.0    # Set specific version

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}==>${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; exit 1; }

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
log "Current version: $CURRENT_VERSION"

# Parse version bump type
BUMP_TYPE="${1:-patch}"

if [[ "$BUMP_TYPE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    NEW_VERSION="$BUMP_TYPE"
else
    # Parse current version
    IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

    case "$BUMP_TYPE" in
        major)
            NEW_VERSION="$((MAJOR + 1)).0.0"
            ;;
        minor)
            NEW_VERSION="${MAJOR}.$((MINOR + 1)).0"
            ;;
        patch)
            NEW_VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))"
            ;;
        *)
            error "Invalid bump type: $BUMP_TYPE (use major, minor, patch, or x.y.z)"
            ;;
    esac
fi

log "New version: $NEW_VERSION"
echo ""

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --staged --quiet; then
    warn "You have uncommitted changes. They will be included in the release commit."
    read -p "Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check we're on main branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
    warn "You're on branch '$CURRENT_BRANCH', not 'main'."
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if tag already exists
if git rev-parse "v$NEW_VERSION" >/dev/null 2>&1; then
    error "Tag v$NEW_VERSION already exists!"
fi

echo ""
log "This will:"
echo "  1. Update version in package.json to $NEW_VERSION"
echo "  2. Update version in extension.toml to $NEW_VERSION"
echo "  3. Run tests"
echo "  4. Commit changes"
echo "  5. Create tag v$NEW_VERSION"
echo "  6. Push to origin"
echo "  7. Wait for CI to build releases"
echo "  8. Guide you through Zed registry submission"
echo ""

read -p "Proceed with release v$NEW_VERSION? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

echo ""

# Step 1: Update package.json
log "Updating package.json..."
node -e "
const fs = require('fs');
const pkg = require('./package.json');
pkg.version = '$NEW_VERSION';
fs.writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
"
success "package.json updated"

# Step 2: Update extension.toml
log "Updating extension.toml..."
sed -i.bak "s/^version = \".*\"/version = \"$NEW_VERSION\"/" extension.toml
rm -f extension.toml.bak

# Also update the archive URLs in extension.toml
REPO=$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')
if [ -z "$REPO" ]; then
    REPO="autohandai/autohand-acp"
fi

cat > extension.toml << EOF
id = "autohand-acp"
name = "Autohand CLI"
version = "$NEW_VERSION"
schema_version = 1
authors = ["Autohand AI <team@autohand.ai>"]
description = "AI coding agent powered by Autohand CLI via Agent Client Protocol (ACP). Features include file editing, code search, terminal commands, and intelligent code assistance."
repository = "https://github.com/$REPO"

[agent_servers.autohand]
name = "Autohand CLI"
icon = "icons/autohand.svg"

[agent_servers.autohand.env]
AUTOHAND_PERMISSION_MODE = "external"

[agent_servers.autohand.targets.darwin-aarch64]
archive = "https://github.com/$REPO/releases/download/v$NEW_VERSION/autohand-acp-darwin-arm64.tar.gz"
cmd = "./autohand-acp"

[agent_servers.autohand.targets.darwin-x86_64]
archive = "https://github.com/$REPO/releases/download/v$NEW_VERSION/autohand-acp-darwin-x64.tar.gz"
cmd = "./autohand-acp"

[agent_servers.autohand.targets.linux-x86_64]
archive = "https://github.com/$REPO/releases/download/v$NEW_VERSION/autohand-acp-linux-x64.tar.gz"
cmd = "./autohand-acp"

[agent_servers.autohand.targets.windows-x86_64]
archive = "https://github.com/$REPO/releases/download/v$NEW_VERSION/autohand-acp-windows-x64.zip"
cmd = "./autohand-acp.exe"
EOF
success "extension.toml updated"

# Step 3: Run tests
log "Running tests..."
if npm test; then
    success "All tests passed"
else
    error "Tests failed! Aborting release."
fi

# Step 4: Commit
log "Committing changes..."
git add package.json extension.toml
git commit -m "release: v$NEW_VERSION"
success "Changes committed"

# Step 5: Create tag
log "Creating tag v$NEW_VERSION..."
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
success "Tag created"

# Step 6: Push
log "Pushing to origin..."
git push origin "$CURRENT_BRANCH"
git push origin "v$NEW_VERSION"
success "Pushed to origin"

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Release v$NEW_VERSION initiated!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "GitHub Actions is now building the release artifacts."
echo ""
echo "Monitor progress at:"
echo "  https://github.com/$REPO/actions"
echo ""
echo "Once CI completes, create the GitHub release at:"
echo "  https://github.com/$REPO/releases/new?tag=v$NEW_VERSION"
echo ""

# Wait for user to create release
read -p "Press Enter after you've created the GitHub release to continue with Zed submission..."

echo ""
log "Checking release artifacts..."

# Check if release artifacts are available
PLATFORMS=("darwin-arm64" "darwin-x64" "linux-x64" "windows-x64")
ALL_AVAILABLE=true

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == "windows"* ]]; then
        ext="zip"
    else
        ext="tar.gz"
    fi
    url="https://github.com/${REPO}/releases/download/v${NEW_VERSION}/autohand-acp-${platform}.${ext}"

    if curl --output /dev/null --silent --head --fail "$url"; then
        success "$platform archive available"
    else
        warn "$platform archive not yet available"
        ALL_AVAILABLE=false
    fi
done

if [ "$ALL_AVAILABLE" = false ]; then
    echo ""
    warn "Some artifacts are not yet available. Wait for CI to complete."
    echo "Check: https://github.com/$REPO/actions"
    echo ""
    read -p "Press Enter to continue anyway, or Ctrl+C to abort..."
fi

# Zed Registry Submission
echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Zed Extension Registry Submission${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "To submit to the Zed Extension Registry:"
echo ""
echo "1. Fork https://github.com/zed-industries/extensions (if not already)"
echo ""
echo "2. Clone and add submodule:"
echo "   git clone https://github.com/YOUR_USERNAME/extensions.git zed-extensions"
echo "   cd zed-extensions"
echo "   git submodule add https://github.com/${REPO}.git extensions/autohand-acp"
echo ""
echo "3. Add to extensions.toml:"
echo ""
echo "   [autohand-acp]"
echo "   submodule = \"extensions/autohand-acp\""
echo "   version = \"$NEW_VERSION\""
echo ""
echo "4. Sort and commit:"
echo "   pnpm sort-extensions"
echo "   git add ."
echo "   git commit -m \"Add autohand-acp extension v$NEW_VERSION\""
echo "   git push origin main"
echo ""
echo "5. Create PR: https://github.com/zed-industries/extensions/compare"
echo ""
echo "PR Title: Add autohand-acp extension v$NEW_VERSION"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Release v$NEW_VERSION complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
