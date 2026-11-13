# Changelog

All notable changes to `copilot-replay` are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — match today's Copilot CLI (1.0.10x)
- Colors now follow the CLI's default GitHub theme (dark + light),
  emitted as 24-bit color where supported with an xterm-256 fallback
  (`COPILOT_REPLAY_COLOR=truecolor|256` to force). Mode accents are the
  CLI's: plan → blue, autopilot → purple, shell → yellow.
- New mascot app header (`Copilot vX uses AI. Check for mistakes.`)
  using the recorded CLI version, replacing the old boxed banner.
- Footer rebuilt as the CLI's prompt frame: cwd + `[⎇ branch]` line,
  half-block frame with a mode-colored left bar, and (in `--cli-mode`)
  the `Interactive · Manual Approval · / commands … Model` status line,
  `◎ Working · ctrl+c interrupt` while busy, `Session: N AIC used`, and
  the home tabs row on top.
- Submitted prompts render as the CLI's shaded `❯` panel.
- Timeline now grows from the top like the CLI's fullscreen view, and
  the scroll region is repainted from history when the footer changes
  size (no more blank gaps after dialogs or long prompts).
- Tool calls use the compact one-row format: `● Read x N lines read`,
  `$ Shell <description> N lines…` with the command underneath,
  `/ Search`, `Edit`/`Create` with `+N -M`, two-letter file-type badges
  (`JS`, `TS`, `MD`, `{}` …), right-aligned durations, `│`/`└` child
  rows, `✗` failures with the error text and exit code.
- `ask_user` and `exit_plan_mode` replay as the CLI's bottom dialogs
  (`Copilot needs information.` / `Plan Ready for Review`) with the
  selection animated at human pace, then collapse to `● Asked user …`
  / `● Plan ready for review …` rows plus the execution-mode notice.
- Reasoning shows as `❯ Thought for Ns` (collapsed, default in
  `--cli-mode`) or `⌄ Thought for Ns` with the text under a `│` rule
  (default otherwise). New `--collapse-thinking` / `--expand-thinking`.
- Markdown: inline code renders as chips, links as link-colored text,
  list bullets as `-`.
- `--cli-mode` ends with the CLI's exit summary (Changes, AI Credits,
  Tokens, Resume) from the recorded `session.shutdown`.

### Added
- Parsing for newer `events.jsonl` content: `apply_patch` (per-file
  rows), SQL todo inserts/updates (`Todo added` / `✔ Todo completed`),
  `skill`, subagent `task` rows (agent name, tool-call count,
  duration), MCP tools via `mcpServerName`/`mcpToolName`,
  `human_response.recorded`, `session.permissions_changed`,
  `session.usage_checkpoint`, `session.warning`, `session.error`, and
  `workspace.yaml` `name:` titles in the picker.

### Fixed
- Prompts sent through slash commands or forwarded by another agent are
  shown; autopilot continuations, memory/skill injections and
  `<system_notification>` payloads stay hidden.
- Subagent-internal tool calls and messages (`parentToolCallId`) no
  longer flood the main timeline.
- Model announcements aren't duplicated when the CLI already logged a
  `Model changed from …` info line; the initial model resolution is
  silent.
- Arrow keys work when the terminal delivers several keys in one chunk.
- `npm run check` works on Windows.

### Earlier unreleased changes
- `--cli-mode` (alias `--realistic`) flag: replays a session as a
  convincing live Copilot CLI session. Hides all replay chrome;
  advance with `→`, pause/resume with `space`, speed locked at 1×.
- Light/dark theme support (`--theme light|dark|auto`, env
  `COPILOT_REPLAY_THEME`, OSC 11 auto-detection).
- MCP / plugin tool results suppressed (compact one-liner instead).
- Skill-injected `user.message` events are no longer rendered in the
  prompt.
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
