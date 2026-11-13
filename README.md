```
 ██████╗ ██████╗ ██████╗ ██╗██╗      ██████╗ ████████╗
██╔════╝██╔═══██╗██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝
██║     ██║   ██║██████╔╝██║██║     ██║   ██║   ██║
██║     ██║   ██║██╔═══╝ ██║██║     ██║   ██║   ██║
╚██████╗╚██████╔╝██║     ██║███████╗╚██████╔╝   ██║
 ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝    ╚═╝
██████╗ ███████╗██████╗ ██╗      █████╗ ██╗   ██╗
██╔══██╗██╔════╝██╔══██╗██║     ██╔══██╗╚██╗ ██╔╝
██████╔╝█████╗  ██████╔╝██║     ███████║ ╚████╔╝
██╔══██╗██╔══╝  ██╔═══╝ ██║     ██╔══██║  ╚██╔╝
██║  ██║███████╗██║     ███████╗██║  ██║   ██║
╚═╝  ╚═╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝   ╚═╝
```

# copilot-replay

> Pre-record a Copilot CLI session by actually doing the work, then replay it later on stage.

A standalone terminal app that replays a [GitHub Copilot CLI][cli] session
from its `events.jsonl` — user prompts, thinking, assistant replies, tool
calls and results — with a look close to the real CLI, at the speed you want.

[cli]: https://github.com/github/copilot-cli

**Reads only. Never contacts the Copilot service.** Nothing is re-executed;
no tokens are spent; no model is called. You are watching the timeline of a
session that already happened, re-rendered into your terminal.

## Why

If you demo the Copilot CLI live, you know the "demo effect": the network
chokes, the model takes the scenic route, a tool call stalls, or you fat-
finger a prompt right when the room is watching. You end up either
pre-recording a screencast (stiff, and you can't answer "what happens if
you change X?") or flying blind and hoping.

`copilot-replay` is a middle path for anyone demonstrating the Copilot CLI:

- **Do the work once**, for real, in a real Copilot CLI session. Prompt by
  prompt, tool call by tool call, until you're happy.
- **Replay it on stage** at `4x` (or whatever speed you pick) straight from
  your terminal — same look as the real CLI, but deterministic.
- No screen recorder, no video editor, no OBS. Just code ahead of time, and
  present later.

You still type the commands live, you still answer questions, but the
stressful, time-consuming part — watching the model think and tools run —
is a recording that you control.

## Install

Requires [Node.js](https://nodejs.org) 18 or newer. Zero runtime
dependencies — installing just drops a script on your `PATH`.

### From GitHub

```bash
git clone https://github.com/lukasedv/copilot-replay.git
cd copilot-replay
npm install -g .
```

`copilot-replay` is now on your `PATH`. If you'd rather keep it editable
while you hack on it, use `npm link` instead of `npm install -g .`.

### From a tarball / local clone

```bash
# inside the repo
npm install -g .
# or, for local testing only:
node bin/copilot-replay.mjs --help
```

To uninstall: `npm uninstall -g copilot-replay`.


## Usage

```
copilot-replay                        # interactive picker (5 most recent)
copilot-replay --list                 # list all sessions, newest first
copilot-replay <session-id>           # replay a specific session (id or prefix)
copilot-replay path/to/events.jsonl   # replay a specific events file
```

Running `copilot-replay` with no arguments shows a big banner and an
arrow-key picker of your five most recent Copilot CLI sessions. Hit
`↑` / `↓` to move, `↵` to start, `q` / ESC to bail.

The replay **starts paused** so you can load it into your terminal in
advance and then press `space` to begin exactly when you want.

## Live keys (in a TTY)

| Key | While playing | While paused |
|-----|---------------|--------------|
| `space` | pause | resume |
| `→` | jump to the next user prompt | **step** forward one event |
| `←` | jump back to the previous user prompt | **step** back one event |
| `+` / `=` | speed up ×1.5 | — |
| `-` | slow down ×1.5 | — |
| `0` | reset to default speed | — |
| `n` | skip the current inter-event wait | — |
| `q` / `Ctrl+C` / `ESC` | quit | quit |

Pause the replay and tap `→` to walk through the session one beat at a
time — thinking, tool call, tool result, assistant line, next user
prompt — narrating each step. Resume with `space` to keep flowing.

The current speed multiplier (`1x`, `4x`, `0.5x`, …) is always visible in
the bottom status bar, along with the available controls.

User prompts are always re-typed character-by-character at a fixed, human
reading speed — regardless of `--speed`. Everything else (thinking,
replies, tool output) is scaled by the playback speed.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-s, --speed N` | `4` | Playback speed multiplier. |
| `--cap MS` | `3000` | Max delay between events (after scaling). Prevents dead air. |
| `--min MS` | `30` | Min delay between events. |
| `--no-thinking` | off | Hide assistant reasoning entirely. |
| `--collapse-thinking` | on in `--cli-mode` | Show reasoning as a single `❯ Thought for Ns` row, like the real CLI. |
| `--expand-thinking` | on otherwise | Also show the reasoning text under a `⌄ Thought for Ns` row. |
| `--theme MODE` | `auto` | Color palette: `light`, `dark`, or `auto`. Auto-detect uses `COLORFGBG` then OSC 11 query, falls back to `dark`. Override with `COPILOT_REPLAY_THEME=light\|dark`. |
| `--cli-mode` / `--realistic` | off | Present the replay as a live Copilot CLI session: home tabs, mascot header, the CLI's `Mode · Permission · / commands … Model` status line, `Session: N AIC used`, and the exit summary at the end. No replay chrome. Press `→` to play one user-prompt segment; `space` still pauses. Speed is locked at 1×. |
| `--include TYPES` | — | Comma-separated extra event types to show. |
| `--exclude TYPES` | — | Comma-separated event types to hide. |
| `-h, --help` | — | Show usage. |

Colors follow the CLI's default GitHub theme. They're emitted as 24-bit
color when the terminal supports it (Windows Terminal, VS Code, iTerm2,
WezTerm, Ghostty, kitty, or `COLORTERM=truecolor`) and as the nearest
xterm-256 color otherwise. Force either with
`COPILOT_REPLAY_COLOR=truecolor|256`.

By default the player shows: user messages, assistant thinking + replies,
tool calls + results, model/mode changes, and session info, warnings and
errors. Hooks, turn markers, streaming deltas, subagent-internal turns,
skill/system-injected messages, etc. are hidden so the replay reads like
the CLI timeline instead of a log dump.

## Layout

While a replay is running, the terminal is carved into regions that
mirror today's Copilot CLI:

- A **timeline** that grows from the top, where session events are
  re-rendered as they "happen".
- A **sticky footer**: the cwd and git branch line, the half-block
  **prompt frame** where user prompts get typed (its left bar takes the
  mode color — blue for plan, purple for autopilot), and a status line
  (replay controls by default, the CLI's own status line in
  `--cli-mode`).

User prompts are typed into the prompt frame one character at a time,
then committed into the timeline as a shaded `❯` panel, exactly like
the real CLI does when you press Enter.

`ask_user` questions and plan approvals replay as the CLI's
bottom-anchored dialogs: the question and choices appear in place of the
prompt frame, the cursor moves to the option the user picked (free-text
answers are typed out), and the dialog collapses into its timeline row.

## How it works

Every Copilot CLI session writes its full timeline to

```
~/.copilot/session-state/<session-id>/events.jsonl
```

Each line is a JSON event — `user.message`, `assistant.message` (with its
`reasoningText`), `tool.execution_start`, `tool.execution_complete`,
`human_response.recorded`, `session.mode_changed`, and so on.
`copilot-replay` reads those events, filters to the interesting ones,
and re-renders each one with a delay derived from the real time gap
between events, scaled by `1 / speed` and clamped to `[min, cap]`
milliseconds. Recordings from older CLI versions (0.0.x onward) still
replay; newer fields are used when present.

Tool calls render in the CLI's compact timeline format — one row per
call, with the CLI's icons and file-type badges:

```
 ● Read notes.txt 3 lines read
 $ Shell List files in the current folder 6 lines…
   Get-ChildItem -File
 ● Asked user Which item should I add to notes.txt?            40s
   └ Shopping item: bread
 JS Edit app.js +6 -1
 ● Todo added 2 items
   │ Adding multiply function
   └ Exporting multiply function
 ❯ Thought for 2s
```

Assistant replies stream out line-by-line with light markdown rendering
(bold, inline-code chips, lists, headings, code fences).

### Fidelity

Close to the real CLI, not pixel-perfect. The real CLI renders through an
internal React/Ink UI that's not reachable from outside the process, so
this replayer re-implements the look by reading the raw event log.
Collapsed rows can't be expanded (there's no `ctrl+o`), diffs and tool
output stay collapsed as in the CLI's default view, and timings are
derived from event timestamps.

## Project layout

```
bin/copilot-replay.mjs    shebang wrapper
src/
  ansi.js                 colors, stripAnsi, BULLET
  io.js                   stdout helpers (rawWrite / writeln / width)
  format.js               time / path / number / wrap helpers
  markdown.js             minimal markdown → ANSI renderer
  banner.js               version + ASCII splash
  sessions.js             session discovery and target resolution
  picker.js               arrow-key session picker
  layout.js               sticky-footer Layout class
  anim.js                 typing / streaming / thinking / start-overlay
  render.js               per-event rendering + describeEvent dispatch
  player.js               playback engine (sleep, seek, fast-forward)
  keyboard.js             raw-mode keystroke handling
  cli.js                  entry point: argv parsing + main()
```

Zero runtime dependencies. Everything is plain ES modules.

## Contributing

Bug reports and PRs are welcome. For any non-trivial change, please open
an issue first so we can align on scope.

Local checks:

```bash
npm run check          # node --check every source file (works on Windows too)
node bin/copilot-replay.mjs --help
```

## License

MIT © Lukas Lundin. See [LICENSE](LICENSE).

## Credits

Made by [Lukas Lundin](https://github.com/lukasedv), Software Solution
Engineer at Microsoft.

