#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <bun-target> <archive-name>" >&2
  echo "Example: $0 bun-darwin-arm64 autohand-acp-darwin-arm64" >&2
  exit 1
fi

TARGET="$1"
ARCHIVE_NAME="$2"
BIN_NAME="autohand-acp"
OUT_DIR="dist/release/${TARGET}"
ARCHIVE_DIR="dist/release"
EXT=""

if [[ "$TARGET" == *"windows"* ]]; then
  EXT=".exe"
fi

mkdir -p "$OUT_DIR" "$ARCHIVE_DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to build a standalone binary." >&2
  exit 1
fi

bun build src/index.ts --compile --target "$TARGET" --outfile "${OUT_DIR}/${BIN_NAME}${EXT}"
chmod +x "${OUT_DIR}/${BIN_NAME}${EXT}"

if [[ "$TARGET" == *"windows"* ]]; then
  (cd "$OUT_DIR" && zip -q "../${ARCHIVE_NAME}.zip" "${BIN_NAME}${EXT}")
else
  tar -C "$OUT_DIR" -czf "${ARCHIVE_DIR}/${ARCHIVE_NAME}.tar.gz" "${BIN_NAME}${EXT}"
fi

echo "Created archive in ${ARCHIVE_DIR}" >&2
