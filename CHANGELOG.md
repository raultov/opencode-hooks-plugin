# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-08-06

### Changed

- Bump version to 0.1.1 to publish first release.
- CI: add GitHub Actions `ci` and `release` workflows (build, test, publish to npm, GitHub Release).
- CI: make `release` workflow tag/name GitHub Release from `package.json` version.

## [0.1.0] - 2026-08-06

### Added

- Initial release.
- Bridges Claude Code `SessionStart` hooks to opencode, which has no native hook system.
- Reads `hooks/hooks.json` or `.claude/settings.json` at runtime; the first match wins.
- Forwards `systemMessage` stdout directives to the system prompt via
  `experimental.chat.system.transform`.
- Honours `continue: false` by skipping remaining commands.
- Sequential command execution; failures are soft (logged, never break the session).
- Options: `root`, `hooksFile`, `matchers`, `skip`, `timeoutMs`, `injectSystemMessages`, `env`.
- Exposes `HooksPlugin` (named) and a default export.
