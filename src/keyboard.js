// Interactive key handling while a replay is running.
//
// Binds process.stdin to raw mode (TTY only) and translates keystrokes
// into state flags on the Player. The returned function detaches the
// listener and restores cooked mode.

import process from "node:process";
import { layout } from "./layout.js";

export function attachKeyHandlers(player) {
    process.on("SIGINT", () => {
        player.quitRequested = true;
        player.wake();
    });

    if (!process.stdin.isTTY) return () => {};

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (data) => {
        // Multi-byte CSI escape sequences (arrows, function keys).
        if (data.startsWith("\x1b[") || data.startsWith("\x1bO")) {
            if (data === "\x1b[C") {
                // When paused, arrows step event-by-event so the presenter
                // can narrate each thing that happens. When playing, they
                // jump to the previous/next *user prompt* — the usual
                // "chapter skip" shortcut.
                if (player.paused) player.stepNext = true;
                else player.seekNext = true;
                player.skipRequested = true;
                player.wake();
            } else if (data === "\x1b[D") {
                if (player.paused) player.stepPrev = true;
                else player.seekPrev = true;
                player.skipRequested = true;
                player.wake();
            }
            return;
        }
        // Bare ESC (single 0x1b) → quit, like the real CLI.
        if (data === "\x1b") {
            player.quitRequested = true;
            player.wake();
            return;
        }
        for (const ch of data) {
            switch (ch) {
                case "\x03": // Ctrl-C
                case "q":
                case "Q":
                    player.quitRequested = true;
                    player.wake();
                    break;
                case " ":
                    player.paused = !player.paused;
                    layout.setPaused(player.paused);
                    player.wake();
                    break;
                case "+":
                case "=":
                    player.speed = Math.min(64, player.speed * 1.5);
                    layout.setSpeed(player.speed);
                    player.wake();
                    break;
                case "-":
                case "_":
                    player.speed = Math.max(0.1, player.speed / 1.5);
                    layout.setSpeed(player.speed);
                    player.wake();
                    break;
                case "0":
                    player.speed = player.defaultSpeed;
                    layout.setSpeed(player.speed);
                    player.wake();
                    break;
                case "n":
                case "N":
                    player.skipRequested = true;
                    player.wake();
                    break;
            }
        }
    };
    process.stdin.on("data", onData);

    return () => {
        process.stdin.off("data", onData);
        try {
            process.stdin.setRawMode(false);
        } catch {}
        process.stdin.pause();
    };
}
