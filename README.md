# Autohand CLI for Zed

Use [Autohand CLI](https://github.com/autohandai/code-cli) from [Zed](https://zed.dev) and other [ACP-compatible](https://agentclientprotocol.com) editors!

## Features

- **File Operations**: Read, write, search, and modify files
- **Terminal Commands**: Execute shell commands with output streaming
- **Session Management**: Resume previous sessions, fork conversations
- **Permission Controls**: External (Zed UI), auto-approve, or restricted modes
- **Dynamic Titles**: Auto-generated session names from your first message
- **Image Support**: Paste screenshots for visual context
- **Slash Commands**: `/help`, `/new`, `/model`, `/mode`, `/resume`, `/threads`, `/status`, and more
- **TODO/Planning**: Visual task tracking in Zed's UI
- **MCP Integration**: Connect to HTTP/SSE MCP servers

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## Installation

### Option 1: Zed Extension (Recommended)

Once published to the Zed Extension Registry:

1. Open Zed
2. Go to **Extensions** (`Cmd+Shift+X`)
3. Search for "Autohand CLI"
4. Click **Install**
5. Open Agent Panel and select "Autohand CLI" from the `+` menu

### Option 2: Manual Settings

Add to your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "agent_servers": {
    "Autohand CLI": {
      "command": "npx",
      "args": ["@autohandai/autohand-acp"],
      "env": {
        "AUTOHAND_PERMISSION_MODE": "external"
      }
    }
  }
}
```

### Option 3: npm Global Install

```bash
npm install -g @autohandai/autohand-acp
```

Then add to Zed settings:

```json
{
  "agent_servers": {
    "Autohand CLI": {
      "command": "autohand-acp",
      "env": {
        "AUTOHAND_PERMISSION_MODE": "external"
      }
    }
  }
}
```

### Other ACP Clients

This adapter works with any ACP-compatible client. [Submit a PR](https://github.com/autohandai/autohand-acp/pulls) to add documentation for your editor!

## Requirements

- Node.js >= 18.17
- `autohand` CLI installed and configured (`~/.autohand/config.json`)

## Configuration

Environment variables control how the adapter launches Autohand:

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTOHAND_CMD` | Path or command name for Autohand | `autohand` |
| `AUTOHAND_CONFIG` | Path to config file | `~/.autohand/config.json` |
| `AUTOHAND_MODEL` | Override the model | - |
| `AUTOHAND_PERMISSION_MODE` | `auto`, `external`, `restricted`, `unrestricted`, `ask` | `auto` |
| `AUTOHAND_DRY_RUN` | Set to `1` for dry-run mode | - |
| `AUTOHAND_AUTO_COMMIT` | Set to `1` to auto-commit changes | - |
| `AUTOHAND_AVAILABLE_MODELS` | Comma-separated model IDs | - |
| `AUTOHAND_INCLUDE_HISTORY` | Set to `1` to include prior turns | - |

### Permission Modes

- **auto**: Auto-confirm risky actions (`--yes`)
- **external**: Forward permission requests to Zed via ACP (recommended for interactive use)
- **restricted**: Deny all dangerous operations automatically
- **unrestricted**: Run without any approval prompts (use with caution)
- **ask**: Run without flags (may hang if prompts appear)

## File Mentions

File mentions work automatically in Zed. When you reference a file using `@filename`:

1. The adapter reads the file content
2. Embeds it in the prompt sent to Autohand CLI
3. Autohand can then analyze or modify the file

This enables context-aware assistance without manually copying file contents.

## External Permission Mode

When `AUTOHAND_PERMISSION_MODE=external`, the adapter starts a local HTTP server that Autohand CLI calls to request permissions:

1. Adapter starts permission server on localhost
2. Passes `AUTOHAND_PERMISSION_CALLBACK_URL` to Autohand CLI
3. Autohand CLI calls the URL when it needs permission
4. Adapter forwards to Zed via ACP `requestPermission`
5. User sees Allow/Reject buttons in Zed
6. Decision is returned to Autohand CLI

This requires Autohand CLI v0.6+ with external callback support.

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/new` | Start a new conversation |
| `/model [name]` | Select or change model |
| `/mode [name]` | Select mode (default/ask/code) |
| `/resume [id]` | Resume a previous session |
| `/threads` | List and switch between sessions |
| `/sessions` | List recent sessions |
| `/session` | Show current session info |
| `/status` | Show Autohand status |
| `/init` | Create AGENTS.md file |
| `/undo` | Undo last file change |

## Development

```bash
npm install
npm run build
npm run test
npm run lint
```

### Local Testing

```bash
# Build local distribution
./scripts/build-local.sh

# Start local server (in separate terminal)
cd dist-local && python3 -m http.server 8765

# Copy dev config and install in Zed
cp extension.dev.toml extension.toml
# Then in Zed: "zed: install dev extension" -> select this folder
```

## Publishing

### One-Command Release

```bash
./scripts/release.sh patch   # 0.1.1 -> 0.1.2
./scripts/release.sh minor   # 0.1.1 -> 0.2.0
./scripts/release.sh major   # 0.1.1 -> 1.0.0
./scripts/release.sh 0.2.5   # Set specific version
```

This script will:
1. ✅ Bump version in `package.json` and `extension.toml`
2. ✅ Run tests
3. ✅ Commit and tag
4. ✅ Push to GitHub (triggers CI build)
5. ✅ Guide you through Zed registry submission

## License

Apache-2.0
