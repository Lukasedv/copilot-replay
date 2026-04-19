// Interactive arrow-key session picker.
//
// Renders the splash banner, lists the five most recent sessions as
// selectable rows (title → relative time → cwd → id), and returns the
// picked session. Non-TTY stdin falls back to "pick most recent" with a
// printed list so piped usage still works.

import process from "node:process";
import { fg } from "./ansi.js";
import { formatRelTime, shortenPath, truncate } from "./format.js";
import { renderSplashLines } from "./banner.js";
import { listSessions } from "./sessions.js";

export function pickSessionInteractive({ die }) {
    const list = listSessions();
    if (list.length === 0) {
        die("No sessions found in ~/.copilot/session-state/");
    }
    const top = list.slice(0, 5);

    if (!process.stdin.isTTY) {
        for (const ln of renderSplashLines()) process.stdout.write(ln + "\n");
        process.stdout.write(`\n  ${fg.gray("Recent sessions:")}\n`);
        for (let i = 0; i < top.length; i++) {
            const s = top[i];
            const sum = s.summary || "(untitled)";
            const when = formatRelTime(s.mtime);
            const cwd = s.cwd ? shortenPath(s.cwd) : "";
            process.stdout.write(
                `    ${fg.white(truncate(sum, 44))}  ${fg.gray(when)}` +
                    `  ${fg.dim(cwd)}  ${fg.dim(fg.gray(s.id.slice(0, 8)))}\n`,
            );
        }
        process.stdout.write(
            `\n${fg.gray("No TTY on stdin; replaying most recent session.")}\n\n`,
        );
        return Promise.resolve(top[0]);
    }

    return new Promise((resolvePromise, rejectPromise) => {
        let sel = 0;
        const splash = renderSplashLines();

        const draw = () => {
            process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
            for (const ln of splash) process.stdout.write(ln + "\n");
            process.stdout.write(
                `\n  ${fg.bold("Pick a session to replay")}  ` +
                    `${fg.gray("— showing the 5 most recent")}\n\n`,
            );
            for (let i = 0; i < top.length; i++) {
                const s = top[i];
                const when = formatRelTime(s.mtime).padEnd(8);
                const idShort = s.id.slice(0, 8);
                const cwd = s.cwd ? truncate(shortenPath(s.cwd), 36) : "";
                const sum = (s.summary
                    ? truncate(s.summary, 44)
                    : fg.dim("(untitled session)")).padEnd(44);
                const cwdPadded = cwd.padEnd(36);
                const isSel = i === sel;
                const marker = isSel ? fg.cyan("❯") : " ";
                const row = isSel
                    ? `${fg.bold(fg.white(sum))}  ${fg.gray(when)}  ` +
                      `${fg.white(cwdPadded)}  ${fg.dim(fg.gray(idShort))}`
                    : `${fg.white(sum)}  ${fg.gray(when)}  ` +
                      `${fg.dim(cwdPadded)}  ${fg.dim(fg.gray(idShort))}`;
                process.stdout.write(`  ${marker}  ${row}\n`);
            }
            process.stdout.write(
                `\n  ${fg.gray("↑/↓")} ${fg.dim("select")}   ` +
                    `${fg.gray("↵")} ${fg.dim("replay")}   ` +
                    `${fg.gray("1-5")} ${fg.dim("jump")}   ` +
                    `${fg.gray("q / ESC")} ${fg.dim("quit")}\n` +
                    `  ${fg.dim(fg.gray("or: copilot-replay <session-id>   ·   copilot-replay --help"))}\n`,
            );
        };

        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        try {
            stdin.setRawMode(true);
        } catch {}
        stdin.resume();

        const cleanup = (clearScreen) => {
            stdin.removeListener("data", onData);
            try {
                stdin.setRawMode(wasRaw);
            } catch {}
            stdin.pause();
            if (clearScreen) process.stdout.write("\x1b[2J\x1b[H");
            process.stdout.write("\x1b[?25h");
        };

        const onData = (buf) => {
            try {
                const s = buf.toString("utf-8");
                if (s === "\x1b[A") {
                    sel = (sel - 1 + top.length) % top.length;
                    draw();
                    return;
                }
                if (s === "\x1b[B") {
                    sel = (sel + 1) % top.length;
                    draw();
                    return;
                }
                if (s.startsWith("\x1b[") || s.startsWith("\x1bO")) return;
                if (s === "\r" || s === "\n") {
                    cleanup(true);
                    resolvePromise(top[sel]);
                    return;
                }
                if (s === "\x03" || s === "\x1b" || s === "q" || s === "Q") {
                    cleanup(true);
                    process.exit(0);
                }
                const code = s.charCodeAt(0);
                if (code >= 0x31 && code <= 0x39) {
                    const n = code - 0x30;
                    if (n >= 1 && n <= top.length) {
                        sel = n - 1;
                        cleanup(true);
                        resolvePromise(top[sel]);
                    }
                }
            } catch (err) {
                cleanup(true);
                rejectPromise(err);
            }
        };
        stdin.on("data", onData);
        draw();
    });
}
