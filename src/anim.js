// Animation primitives used by the renderer.
//
//   - animateThinking   pulsating Thinking… spinner
//   - streamLines       write pre-rendered lines with a small per-line delay
//   - typeColoredLine   type an already-ANSI-colored line char-by-char,
//                       preserving escape sequences as atomic units
//   - typeUserPrompt    character-by-character typing into the input box
//   - renderStartOverlay / clearStartOverlay / waitForStart
//                       centered "Press SPACE to start replay" screen shown
//                       before the replay begins
//
// All helpers honor `player.fastForwarding` (instant) and
// `player.quitRequested` (bail early).

import { ICON, fg, isTTY, stripAnsi } from "./ansi.js";
import { rawWrite, writeln } from "./io.js";
import { layout, renderPromptPanel } from "./layout.js";
import { renderSplashLines } from "./banner.js";

// Shimmer: a brighter highlight sweeps across the label, like the CLI's
// streaming "Thinking…" row.
function shimmer(text, pos) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
        const d = Math.abs(i - pos);
        out += d <= 1 ? fg.white(text[i]) : fg.dim(text[i]);
    }
    return out;
}

export async function animateThinking(player, text) {
    if (!layout.active) return;
    if (player.fastForwarding) return;
    const words = String(text).split(/\s+/).filter(Boolean).length;
    // Base duration depends on reasoning length; clamp to something human.
    const baseMs = Math.min(1600, Math.max(400, words * 35));
    // Scale with playback speed but never collapse to zero — the indicator
    // is meant to be *seen* on every assistant turn.
    const durationMs = Math.max(
        300,
        (baseMs / Math.max(1, player.speed)) * 2,
    );
    const frameMs = 70;
    const label = "Thinking…";
    const endAt = Date.now() + durationMs;
    let i = 0;
    while (
        Date.now() < endAt &&
        !player.quitRequested &&
        !player.skipRequested
    ) {
        const row = layout.nextRow;
        rawWrite(
            `\x1b[${row};1H\x1b[2K ${fg.dim(ICON.chevron)} ` +
                fg.italic(shimmer(label, (i % (label.length + 6)) - 3)),
        );
        i++;
        await player.sleep(frameMs);
    }
    const row = layout.nextRow;
    rawWrite(`\x1b[${row};1H\x1b[2K`);
}

export async function streamLines(
    lines,
    player,
    { indent = "  ", perLineMs = 25 } = {},
) {
    const scaled = Math.max(6, (perLineMs / Math.max(1, player.speed)) * 2);
    let skipped = player.fastForwarding;
    for (const line of lines) {
        if (player.quitRequested) return;
        writeln(line === "" ? "" : `${indent}${line}`);
        if (!skipped && !player.fastForwarding) {
            await player.sleep(scaled);
            if (player.skipRequested) {
                skipped = true;
                player.skipRequested = false;
            }
        }
    }
}

// Type a pre-colored line into the bottom of the scroll region
// character-by-character, preserving ANSI CSI sequences as atomic units.
export async function typeColoredLine(
    player,
    colored,
    { perCharMs = 10 } = {},
) {
    if (!layout.active || player.fastForwarding) {
        writeln(colored);
        return;
    }
    const row = layout.nextRow;
    rawWrite(`\x1b[${row};1H\x1b[2K`);
    let skip = false;
    let i = 0;
    while (i < colored.length) {
        if (player.quitRequested) return;
        // Emit any ANSI CSI sequence starting here as a single unit.
        if (colored[i] === "\x1b" && colored[i + 1] === "[") {
            const end = colored.indexOf("m", i);
            if (end !== -1) {
                rawWrite(colored.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }
        rawWrite(colored[i]);
        i++;
        if (!skip) {
            await player.sleep(perCharMs);
            if (player.skipRequested) {
                skip = true;
                player.skipRequested = false;
            }
        }
    }
    rawWrite("\n");
    layout.recordLine(colored);
}

// User prompts type into the footer input box at a fixed, human-readable
// pace (not scaled by --speed) so the audience can read along.
export async function typeUserPrompt(content, player) {
    const PER_CHAR_MS = 28;
    const POST_ENTER_PAUSE_MS = 400;
    let skip = false;
    if (layout.active) {
        layout.clearTyped();
        for (const ch of content) {
            if (player.quitRequested) return;
            layout.appendChar(ch);
            if (!skip) {
                await player.sleep(PER_CHAR_MS);
                if (player.skipRequested) {
                    skip = true;
                    player.skipRequested = false;
                }
            }
        }
        await player.sleep(POST_ENTER_PAUSE_MS);
        layout.commitPrompt(content);
        return;
    }
    // Non-TTY: render the same panel the CLI leaves in its timeline.
    const W = Math.min(Math.max(40, process.stdout.columns || 100), 120);
    for (const ln of renderPromptPanel(content, W)) writeln(ln);
}

// Centered "Press SPACE to start replay" overlay, with the Copilot Replay
// ASCII splash banner pinned at the top (same spot the real Copilot CLI
// shows its banner on launch). Drawn only while paused before the first
// event — once play begins it's wiped and never shown again.
//
// To avoid flicker on the 600ms indicator pulse, this function draws the
// full overlay once (banner + prompt) and remembers where the ▶ glyph
// landed. Subsequent calls only rewrite that single character. Pass
// `full: true` to force a complete redraw (e.g. on terminal resize).
let _overlayState = null;

export function renderStartOverlay(tick = 0, { full = false } = {}) {
    if (!layout.active) return;
    const cols = layout.cols;
    const top = layout.scrollTopRow;
    const bottom = layout.scrollBottomRow;

    // Plain text of the title (no ANSI, no play glyph) — used for layout.
    const titleText = "▶   Press SPACE to start replay";
    const titleLen = titleText.length;
    const titlePad = Math.max(0, Math.floor((cols - titleLen) / 2));

    const needsFullRedraw =
        full ||
        !_overlayState ||
        _overlayState.cols !== cols ||
        _overlayState.bottom !== bottom;

    if (needsFullRedraw) {
        rawWrite("\x1b7");
        for (let r = top; r <= bottom; r++) {
            rawWrite(`\x1b[${r};1H\x1b[2K`);
        }

        const splash = renderSplashLines();
        const bannerFits = bottom - top + 1 >= splash.length + 4;
        let promptRow;
        if (bannerFits) {
            const bannerTop = top;
            for (let i = 0; i < splash.length; i++) {
                const line = splash[i];
                const visible = stripAnsi(line).length;
                const pad = Math.max(0, Math.floor((cols - visible) / 2));
                rawWrite(`\x1b[${bannerTop + i};1H`);
                rawWrite(" ".repeat(pad) + line);
            }
            const bannerBottom = bannerTop + splash.length - 1;
            promptRow = Math.min(
                bottom - 2,
                bannerBottom +
                    Math.max(2, Math.floor((bottom - bannerBottom) / 2)),
            );
        } else {
            promptRow = Math.max(top, Math.floor((top + bottom) / 2) - 1);
        }

        // Draw the title line. Leave the ▶ cell to the tick-update step
        // below so both code paths write it the same way.
        const rest =
            `   ${fg.bold(fg.white("Press"))} ` +
            `${fg.bold(fg.cyan("SPACE"))} ` +
            `${fg.bold(fg.white("to start replay"))}`;
        rawWrite(`\x1b[${promptRow};${titlePad + 2}H`);
        rawWrite(rest);

        // Sub-line: "q to quit".
        const sub = fg.gray("q to quit");
        const subLen = stripAnsi(sub).length;
        const subPad = Math.max(0, Math.floor((cols - subLen) / 2));
        rawWrite(`\x1b[${promptRow + 2};${subPad + 1}H`);
        rawWrite(sub);

        _overlayState = {
            cols,
            bottom,
            promptRow,
            playCol: titlePad + 1,
        };
        rawWrite("\x1b8");
    }

    // Update just the ▶ cell — the only thing that changes on tick.
    const on = tick % 2 === 0;
    const play = on ? fg.white("▶") : fg.gray("▶");
    rawWrite("\x1b7");
    rawWrite(`\x1b[${_overlayState.promptRow};${_overlayState.playCol}H`);
    rawWrite(play);
    rawWrite("\x1b8");
}

export function clearStartOverlay() {
    if (!layout.active) return;
    _overlayState = null;
    layout.clearScrollRegion();
}

export async function waitForStart(player) {
    if (!isTTY || !player.paused) return;
    let tick = 0;
    const draw = () => renderStartOverlay(tick);
    // Force a full redraw whenever the layout re-invokes us (e.g. on
    // terminal resize). During normal blink ticks the cached state makes
    // renderStartOverlay only rewrite the ▶ glyph, which is flicker-free.
    const fullDraw = () => {
        _overlayState = null;
        renderStartOverlay(tick);
    };
    draw();
    layout.overlayDraw = fullDraw;
    const iv = setInterval(() => {
        tick++;
        if (player.paused && !player.quitRequested) draw();
    }, 600);
    try {
        while (player.paused && !player.quitRequested) {
            await new Promise((r) => {
                player._wake = r;
            });
            player._wake = null;
        }
    } finally {
        clearInterval(iv);
        layout.overlayDraw = null;
        clearStartOverlay();
    }
}
