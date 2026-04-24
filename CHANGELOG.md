# Changelog

All notable changes to `copilot-replay` are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `--cli-mode` (alias `--realistic`) flag: replays a session as a
  convincing live Copilot CLI session. Hides all replay chrome;
  advance with `→`, pause/resume with `space`, speed locked at 1×.
- Light/dark theme support (`--theme light|dark|auto`, env
  `COPILOT_REPLAY_THEME`, OSC 11 auto-detection).
- Input prompt rendered in a gray bg panel matching the real CLI.
- MCP / plugin tool results suppressed (compact one-liner instead).
- Mode-accent coloring: `plan` → cyan, `autopilot` → green chevron,
  cursor, and status bar. Status bar shows `/ commands · ? help`.

### Fixed
- Skill-injected `user.message` events (with a `source` field) are
  no longer rendered in the prompt.
- Eliminated per-keystroke flash in the input box on Windows Terminal.
- `fg.dim` uses explicit mid-grey instead of SGR 2 faint attribute,
  which was invisible on light backgrounds.

## [0.1.0] - Initial release

### Added
- Standalone Node.js CLI that replays a Copilot CLI session from its
  `events.jsonl`, with no network access or Copilot service calls.
- Arrow-key session picker showing the 5 most recent sessions, with a full
  ASCII splash banner.
- Sticky-footer terminal layout mirroring the real Copilot CLI: cwd line,
  `>` input box that user prompts type into, status bar with speed and
  live controls.
- Animated session start line ("Starting replay of session … at … model …").
- Pulsating "Thinking…" spinner, streamed line-by-line assistant output,
  minimal inline + block markdown rendering.
- Centered "Press SPACE to start replay" overlay — the replay starts
  paused so a presenter can load it ahead of time and trigger playback
  exactly on cue.
- Playback controls: space (pause/resume), ← / → (prev / next user
  prompt while playing, step-by-step event walk while paused), + / -, 0
  (speed), n (skip wait), q / ESC / Ctrl+C (quit).
- Full-width footer and live resize handling.
- Modular source tree under `src/` for readability.

### Security
- Strip terminal control bytes (ESC / C0 / C1) from every string loaded
  from `events.jsonl` and `workspace.yaml` before rendering. Prevents a
  malicious session file from hijacking the clipboard (OSC 52), rewriting
  the terminal title, injecting hyperlinks (OSC 8), clearing the screen,
  or repositioning the cursor during replay or while listing sessions.
- Guarantee the terminal is restored (scroll region reset, cursor shown,
  raw mode disabled) on every fatal path — `uncaughtException`,
  `unhandledRejection`, `SIGINT`, `SIGTERM`, and normal exit — so the
  user's shell is never left in raw mode after a crash.
