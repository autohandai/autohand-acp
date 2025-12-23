# ACP adapter for Autohand CLI

Run the Autohand CLI as an Agent Client Protocol (ACP) agent for editors like Zed.

Autohand Code CLI: https://github.com/autohandai/code-cli

This adapter spawns `autohand --prompt` for each ACP prompt and streams the CLI output back to the client.

## Requirements

- Node.js >= 18.17
- `autohand` installed and configured (`~/.autohand/config.json`)

## Install

```bash
npm install -g @autohandai/autohand-acp
```

## Run

```bash
autohand-acp
```

Zed can launch it via the Agent Server extension in `extension.toml`.

## Configuration

Environment variables control how the adapter launches Autohand:

- `AUTOHAND_CMD`: Path or command name for Autohand (default: `autohand`)
- `AUTOHAND_CONFIG`: Path to Autohand config file (default: `~/.autohand/config.json`)
- `AUTOHAND_MODEL`: Override the model (`--model`)
- `AUTOHAND_TEMPERATURE`: Override the temperature (`--temperature`)
- `AUTOHAND_PERMISSION_MODE`: `auto` (default), `restricted`, `unrestricted`, or `ask`
  - `auto` maps to `--yes` (auto-confirm risky actions)
  - `restricted` maps to `--restricted`
  - `unrestricted` maps to `--unrestricted`
  - `ask` runs without a flag (may hang if prompts appear)
- `AUTOHAND_DRY_RUN`: Set to `1` or `true` to add `--dry-run`
- `AUTOHAND_AUTO_COMMIT`: Set to `1` or `true` to add `--auto-commit`
- `AUTOHAND_EXTRA_ARGS`: Extra CLI arguments (space-separated, supports simple quotes)
- `AUTOHAND_INCLUDE_HISTORY`: Set to `1` to include prior turns in the prompt
- `AUTOHAND_HISTORY_LIMIT`: Max turns to include (default: 6)
- `AUTOHAND_MAX_HISTORY_CHARS`: Max history chars to include (default: 8000)

## Limitations

- Autohand runs in non-interactive mode. If it needs interactive prompts (e.g., missing config), the run will stall.
- ACP tool-level permission prompts are not surfaced; use `AUTOHAND_PERMISSION_MODE` to control approvals.
- Each ACP prompt starts a fresh Autohand process. Enable `AUTOHAND_INCLUDE_HISTORY` for basic continuity.

## Development

```bash
npm run lint
npm run test
```

## Zed Agent Server extension

`extension.toml` is included and points at GitHub release assets. Update the URLs and version when publishing.

To build a release artifact, compile a binary per target platform and upload archives in your GitHub release.
`scripts/package-release.sh` uses `bun build --compile` to create a single-platform archive.

## License

Apache-2.0
