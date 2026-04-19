// Entry point: argument parsing, usage, and the main orchestration that
// wires picker → session → Player → keyboard.

import process from "node:process";
import { fg } from "./ansi.js";
import {
    SESSION_STATE_DIR,
    listSessions,
    loadEvents,
    resolveTarget,
} from "./sessions.js";
import { pickSessionInteractive } from "./picker.js";
import { Player } from "./player.js";
import { attachKeyHandlers } from "./keyboard.js";
import { layout } from "./layout.js";

export function die(msg) {
    process.stderr.write(`copilot-replay: ${msg}\n`);
    process.exit(2);
}

export function parseArgs(argv) {
    const args = {
        positional: [],
        speed: 4,
        cap: 3000,
        min: 30,
        list: false,
        help: false,
        showThinking: true,
        include: new Set([
            "user.message",
            "assistant.message",
            "tool.execution_start",
            "tool.execution_complete",
            "session.mode_changed",
            "session.model_change",
            "session.info",
            "session.start",
            "session.plan_changed",
        ]),
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case "--help":
            case "-h":
                args.help = true;
                break;
            case "--list":
            case "-l":
                args.list = true;
                break;
            case "--speed":
            case "-s":
                args.speed = Number(next());
                break;
            case "--cap":
                args.cap = Number(next());
                break;
            case "--min":
                args.min = Number(next());
                break;
            case "--no-thinking":
                args.showThinking = false;
                break;
            case "--include": {
                const v = next();
                if (v) for (const t of v.split(",")) args.include.add(t.trim());
                break;
            }
            case "--exclude": {
                const v = next();
                if (v)
                    for (const t of v.split(",")) args.include.delete(t.trim());
                break;
            }
            default:
                if (a.startsWith("-")) die(`Unknown option: ${a}`);
                args.positional.push(a);
        }
    }
    if (!Number.isFinite(args.speed) || args.speed <= 0) {
        die("--speed must be a positive number");
    }
    if (!Number.isFinite(args.cap) || args.cap < 0) {
        die("--cap must be a non-negative number");
    }
    if (!Number.isFinite(args.min) || args.min < 0) {
        die("--min must be a non-negative number");
    }
    return args;
}

export function printHelp() {
    process.stdout.write(
        `copilot-replay — replay a Copilot CLI session from its events.jsonl\n\n` +
            `Usage:\n` +
            `  copilot-replay                        Pick a recent session (interactive)\n` +
            `  copilot-replay --list                 List available sessions\n` +
            `  copilot-replay <session-id>           Replay a specific session\n` +
            `  copilot-replay <path/to/events.jsonl> Replay from a file path\n\n` +
            `Options:\n` +
            `  -s, --speed N          Playback speed multiplier (default 4)\n` +
            `      --cap MS           Max delay between events in ms (default 3000)\n` +
            `      --min MS           Min delay between events in ms (default 30)\n` +
            `      --no-thinking      Hide assistant reasoning blocks\n` +
            `      --include TYPES    Comma-separated extra event types to show\n` +
            `      --exclude TYPES    Comma-separated event types to hide\n` +
            `  -h, --help             Show this help\n\n` +
            `Interactive keys (playing):\n` +
            `  space  pause / resume        + / -  change speed        q  quit\n` +
            `  →      next user prompt      ←      previous user prompt   0  reset speed\n` +
            `Interactive keys (paused):\n` +
            `  →      step forward one event         ←      step back one event\n\n` +
            `Sessions are discovered under ${SESSION_STATE_DIR}\n`,
    );
}

export async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }

    if (args.list) {
        const list = listSessions();
        if (list.length === 0) {
            process.stdout.write("No sessions found.\n");
            return;
        }
        for (const s of list) {
            const when = new Date(s.mtime)
                .toISOString()
                .replace("T", " ")
                .slice(0, 19);
            process.stdout.write(
                `${fg.bold(s.id)}  ${fg.gray(when)}  ` +
                    `${fg.dim(s.cwd || "")}  ${s.summary || ""}\n`,
            );
        }
        return;
    }

    let target = resolveTarget(args.positional, { die });
    if (!target) target = await pickSessionInteractive({ die });

    const events = loadEvents(target.eventsPath);
    if (events.length === 0) die(`No events in ${target.eventsPath}`);

    const player = new Player(events, { ...args, sessionId: target.id });
    const detach = attachKeyHandlers(player);

    // Idempotent terminal restore. process.exit() skips `finally` blocks,
    // so every fatal path (uncaughtException, unhandledRejection, SIGINT,
    // normal exit) must call this explicitly. We keep it defensive — any
    // throw here would itself leak raw mode.
    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        try {
            detach();
        } catch {}
        try {
            layout.disable();
        } catch {}
        // Belt-and-suspenders: even if detach() didn't run, make sure the
        // shell we return to isn't stuck in raw mode.
        try {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
        } catch {}
        try {
            process.stdin.pause();
        } catch {}
    };
    process.on("uncaughtException", (err) => {
        restore();
        process.stderr.write(
            `copilot-replay: ${err?.stack || err?.message || err}\n`,
        );
        process.exit(1);
    });
    process.on("unhandledRejection", (err) => {
        restore();
        process.stderr.write(
            `copilot-replay: ${err?.stack || err?.message || err}\n`,
        );
        process.exit(1);
    });
    process.on("SIGINT", () => {
        restore();
        process.exit(130);
    });
    process.on("SIGTERM", () => {
        restore();
        process.exit(143);
    });
    process.on("exit", restore);

    try {
        await player.run();
    } finally {
        restore();
    }
}
