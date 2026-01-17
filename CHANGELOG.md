# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-01-17

### Added

#### Authentication & CLI Detection
- CLI installation detection with helpful error messages and install instructions
- Improved authentication flow with Zed terminal-auth support
- Login persistence check on session start

#### Session Modes
- Added **Auto-mode** to mode selector for autonomous agent loop
- Added **Unrestricted mode** for skipping approval prompts
- Auto-mode automatically switches to unrestricted when enabled

#### Configuration & Settings
- **Persistent settings** saved to `~/.autohand/config.json`
- New config options with UI dropdowns:
  - Thinking Level (None/Normal/Extended)
  - Auto-commit toggle
  - Include History toggle
  - Auto-Mode with limits (iterations, runtime, cost)
  - Temperature control (0.0-1.0)
  - Stream Output toggle
- Settings persist across sessions and Zed restarts

#### Model Support
- Load default model from CLI config (`~/.autohand/config.json`)
- Reads active provider's model (e.g., openrouter.model)
- Model selection persists correctly

#### Output Improvements
- Fixed hook events showing as "Thinking" in UI
- Fixed raw JSON output being displayed to users
- Cleaner stdout filtering for CLI internal markers

#### New Icon
- Updated extension icon to official Autohand logo (single eye design)
- Icon uses `currentColor` for light/dark theme compatibility

### Fixed
- Login not persisting between sessions
- `--plan` flag causing "unknown option" error (removed)
- `--auto-mode` flag now correctly passes instruction as argument
- Duplicate responses in chat output
- Hook events (`[Hook: session-start]`) no longer visible in UI

### Changed
- Removed hardcoded local CLI path from `findAutohandBinary()`
- Improved error messages for missing CLI with install instructions
- Config options now read from file with environment variable fallback

## [0.1.3] - 2025-01-12

- Authentication improvements and session management enhancements
- Feedback system integration
- Completion stats display (time & tokens)

## [0.1.1] - 2025-12-24

- Ensure release artifacts contain an executable autohand-acp binary at the archive root.
- Add archive content verification to the release workflow.

## [0.1.0] - 2025-12-24

- Initial ACP adapter for Autohand CLI with Zed agent server support.
- Streams Autohand command-mode output over ACP with cancellation support.
- Includes GitHub Actions workflows for CI and release artifacts.

### Versioning

- This project follows semantic versioning starting at v0.1.0.
