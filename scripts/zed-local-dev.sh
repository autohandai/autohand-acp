#!/bin/bash
# Refresh local Autohand ACP build and point Zed at dist/index.js.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_ID="autohand-acp"
AGENT_NAME="${AUTOHAND_ZED_AGENT_NAME:-Autohand CLI (Local)}"
AUTOHAND_CMD_OVERRIDE="${AUTOHAND_ZED_CMD:-}"

if [ -z "$AUTOHAND_CMD_OVERRIDE" ]; then
  if command -v autohand >/dev/null 2>&1; then
    AUTOHAND_CMD_OVERRIDE="$(command -v autohand)"
  elif [ -f "$HOME/Documents/autohand/cli-3/dist/index.js" ]; then
    AUTOHAND_CMD_OVERRIDE="node $HOME/Documents/autohand/cli-3/dist/index.js"
  elif [ -f "$HOME/documents/autohand/cli-3/dist/index.js" ]; then
    AUTOHAND_CMD_OVERRIDE="node $HOME/documents/autohand/cli-3/dist/index.js"
  fi
fi

NO_BUILD=0
NO_SETTINGS=0
NO_CLEAN=0
REMOVE_INSTALLED=0

usage() {
  cat <<'USAGE'
Usage: scripts/zed-local-dev.sh [options]

Options:
  --no-build         Skip "npm run build"
  --no-settings      Do not update ~/.config/zed/settings.json
  --no-clean         Do not remove Zed caches for autohand-acp
  --remove-installed Remove Zed installed extension folder (autohand-acp)
  -h, --help         Show this help
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --no-settings) NO_SETTINGS=1 ;;
    --no-clean) NO_CLEAN=1 ;;
    --remove-installed) REMOVE_INSTALLED=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

if [ "$NO_BUILD" -eq 0 ]; then
  echo "🔧 Building..."
  cd "$ROOT_DIR"
  npm run build
fi

if [ "$NO_CLEAN" -eq 0 ]; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    ZED_DATA_DIR="$HOME/Library/Application Support/Zed"
  else
    ZED_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/zed"
  fi

  safe_rm() {
    local target="$1"
    if [[ -z "$target" || "$target" != *"$EXT_ID"* || "$target" != "$ZED_DATA_DIR"* ]]; then
      return
    fi
    rm -rf "$target" 2>/dev/null || true
  }

  echo "🧹 Cleaning Zed caches..."
  safe_rm "$ZED_DATA_DIR/external_agents/$EXT_ID"
  safe_rm "$ZED_DATA_DIR/extensions/build/$EXT_ID"
  safe_rm "$ZED_DATA_DIR/extensions/work/$EXT_ID"
  if [ "$REMOVE_INSTALLED" -eq 1 ]; then
    safe_rm "$ZED_DATA_DIR/extensions/installed/$EXT_ID"
  fi
fi

if [ "$NO_SETTINGS" -eq 0 ]; then
  ZED_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/zed"
  SETTINGS_PATH="${ZED_SETTINGS_PATH:-$ZED_CONFIG_DIR/settings.json}"
  mkdir -p "$(dirname "$SETTINGS_PATH")"

  echo "🧩 Ensuring Zed agent_servers entry..."
  AUTOHAND_ACP_PATH="$ROOT_DIR/dist/index.js" \
  AGENT_NAME="$AGENT_NAME" \
  AUTOHAND_CMD="$AUTOHAND_CMD_OVERRIDE" \
  node <<'NODE'
const fs = require("fs");
const path = require("path");

const settingsPath = process.env.ZED_SETTINGS_PATH || path.join(
  process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, ".config"),
  "zed",
  "settings.json"
);
const agentName = process.env.AGENT_NAME || "Autohand CLI (Local)";
const agentPath = process.env.AUTOHAND_ACP_PATH;
const autohandCmd = process.env.AUTOHAND_CMD;

function stripJsonComments(input) {
  let out = "";
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = i + 1 < input.length ? input[i + 1] : "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (char === "\\") {
        if (i + 1 < input.length) {
          out += input[i + 1];
          i += 1;
        }
        continue;
      }
      if (char === stringChar) {
        inString = false;
        stringChar = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      stringChar = char;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += char;
  }

  return out;
}

function stripTrailingCommas(input) {
  let out = "";
  let inString = false;
  let stringChar = "";

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      out += char;
      if (char === "\\") {
        if (i + 1 < input.length) {
          out += input[i + 1];
          i += 1;
        }
        continue;
      }
      if (char === stringChar) {
        inString = false;
        stringChar = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      stringChar = char;
      out += char;
      continue;
    }

    if (char === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) {
        j += 1;
      }
      const next = input[j];
      if (next === "}" || next === "]") {
        continue;
      }
    }

    out += char;
  }

  return out;
}

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const withoutComments = stripJsonComments(raw);
    const sanitized = stripTrailingCommas(withoutComments);
    if (sanitized !== raw) {
      const backupPath = `${settingsPath}.bak`;
      fs.copyFileSync(settingsPath, backupPath);
      console.log(`Backed up settings to ${backupPath}`);
    }
    settings = JSON.parse(sanitized);
  } catch (err) {
    console.error(`Failed to parse ${settingsPath}: ${err.message}`);
    process.exit(1);
  }
}

settings.agent_servers = settings.agent_servers || {};
const env = {
  AUTOHAND_PERMISSION_MODE: "external"
};
if (autohandCmd) {
  env.AUTOHAND_CMD = autohandCmd;
}
settings.agent_servers[agentName] = {
  command: "node",
  args: [agentPath],
  env
};

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
console.log(`Updated ${settingsPath}`);
NODE
fi

cat <<EOF

✅ Ready. Next steps:
1) Reload Zed extensions
2) Pick "${AGENT_NAME}" in the agent dropdown

Tip: if Zed still uses the old extension agent, run with --remove-installed once.
EOF
