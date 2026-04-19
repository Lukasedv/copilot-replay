# Changelog

All notable changes to `copilot-replay` are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
