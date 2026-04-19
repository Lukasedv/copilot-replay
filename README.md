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
| `--no-thinking` | off | Hide assistant reasoning blocks. |
| `--include TYPES` | — | Comma-separated extra event types to show. |
| `--exclude TYPES` | — | Comma-separated event types to hide. |
| `-h, --help` | — | Show usage. |

By default the player shows: user messages, assistant thinking + replies,
tool calls + results, model/mode changes, and session info. Hooks, turn
markers, streaming deltas, etc. are hidden so the replay reads like a
conversation instead of a log dump.

## Layout

While a replay is running, the terminal is carved into two regions:

- A **scroll region** on top, where session events are re-rendered as they
  "happen".
- A **sticky footer** at the bottom that mirrors the real CLI's chrome:
  cwd line, the input box where user prompts get typed, and a status bar
  with the current speed and the live key bindings.

User prompts are typed into the footer input box one character at a time,
then committed up into the scroll history exactly like the real CLI does
when you press Enter.

## How it works

Every Copilot CLI session writes its full timeline to

```
~/.copilot/session-state/<session-id>/events.jsonl
```

Each line is a JSON event — `user.message`, `assistant.message` (with its
`reasoningText`), `tool.execution_start`, `tool.execution_complete`,
`session.mode_changed`, and so on. `copilot-replay` reads those events,
filters to the interesting ones, and re-renders each one with a delay
derived from the real time gap between events, scaled by `1 / speed` and
clamped to `[min, cap]` milliseconds.

Assistant reasoning gets a pulsating `Thinking…` spinner before it
appears; both reasoning and final replies stream out line-by-line with
light markdown rendering (bold, inline code, bullets, headings, code
fences). Tool calls render with the same bullet-and-branch style the real
CLI uses.

### Fidelity

Close to the real CLI, not pixel-perfect. The real CLI renders through an
internal React/Ink UI that's not reachable from outside the process, so
this replayer re-implements the look by reading the raw event log.

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
npm run check          # node --check every source file
node bin/copilot-replay.mjs --help
```

## License

MIT © Lukas Lundin. See [LICENSE](LICENSE).

## Credits

Made by [Lukas Lundin](https://github.com/lukasedv), Software Solution
Engineer at Microsoft.

