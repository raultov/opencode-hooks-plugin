# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-10-15

### Added

- **`PostToolUse` is bridged.** After each `write`, `edit`, `bash` or `apply_patch` call, the matching
  `PostToolUse` commands run with a Claude-Code-shaped payload on stdin. `apply_patch` runs them once per
  file it touches, as an `Edit`. On V1 through `tool.execute.after`; on V2 through `tool.hook("execute.after")`,
  for completed calls only.

### Changed

- `SessionStart` commands now get the event payload on stdin (`hook_event_name`, `source`, `cwd`) instead of
  `/dev/null`, as in Claude Code. stdin still ends, so a hook that reads it never hangs.

## [0.3.0] - 2026-10-09

### Added

- **opencode V2 support.** The package now serves both generations from one entrypoint: V2
  reads the default export as a plugin definition and calls `setup`; V1 (1.18.29 and newer)
  reads it as a `PluginModule` and calls `server`. Both share one bridging engine, so the
  bridged behaviour cannot drift between generations.
- On V2, `systemMessage` directives are injected through the stable session request hooks,
  offered to every request kind that carries a system prompt (`context`, `compaction`,
  `generate`, `title`) — the V1 equivalent of `experimental.chat.system.transform` firing on
  every model call.
- Package exports `./v1` and `./v2` exposing each generation's entrypoint in isolation.

### Changed

- The default export is now the dual entrypoint object. Wrappers that imported the default and
  called it as a function should import the named `HooksPlugin` export instead (unchanged).
- opencode V1 older than 1.18.29 cannot load object entrypoints: pin `0.2.0` there.

## [0.2.0] - 2026-09-22

### Added

- Option `commandTimeoutMs` (default `120000`): bounds how long a single command is waited
  for. Distinct from `timeoutMs`, which bounds how long the first model call waits for all
  of them.
- Option `reportFailures` (default `true`): a command that exits non-zero, times out, or
  throws now appends a one-line notice to the system prompt, so the model knows its context
  is incomplete. Notices never carry stderr.

### Fixed

- A command that never returned blocked the sequential loop forever, so every later hook
  silently never ran. Each command is now bounded by `commandTimeoutMs` and the loop
  continues past a timeout. Bun's `$` exposes no kill API, so an overrunning command is
  abandoned rather than killed.
- Commands run with stdin from `/dev/null`, so a hook that reads stdin by accident no
  longer hangs the chain.
- A blank or whitespace-only entry in `skip` dropped every command, because
  `"anything".includes("")` is true. Blank entries are now ignored and warned about.
- The injected block is no longer duplicated when `output.system` is reused across model
  calls, which previously depended on an undocumented opencode behaviour.
- A `hooksFile` set explicitly (option or `$OPENCODE_HOOKS_FILE`) that does not exist is
  logged at `warn` instead of `debug`. Probed defaults stay at `debug`.
- Log labels keep a quoted path containing spaces whole instead of cutting it at the first
  space.

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
