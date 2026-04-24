// Sticky-footer terminal layout.
//
// When stdout is a TTY we carve the screen into a scroll region at the top
// and a fixed "input box" chrome at the bottom:
//
//     ┌───────────────────────┐  ← scroll region (rows 1..H-footerH)
//     │ replay content …      │     each writeln() scrolls normally here
//     │ …                     │
//     ├───────────────────────┤
//     │ ~/projects/replay     │  ← reserved footer (footerH rows)
//     │ ─────────────         │
//     │ > typed prompt…       │
//     │ ─────────────         │
//     │ 4x  controls    title │
//     └───────────────────────┘
//
// The input box is where `user.message` events are "typed" char-by-char.
// When the prompt finishes typing, it's committed: cleared from the box and
// emitted as a `>` blockquote into the scroll region above.

import process from "node:process";
import { ANSI_RESET, bg, bgOpen, fg, stripAnsi } from "./ansi.js";
import { STREAM, rawWrite, setLayoutRef } from "./io.js";
import { formatSpeed, wrapLines } from "./format.js";

// Non-input footer rows: cwd, top-rule, bottom-rule, status bar (=4).
// The input box itself occupies 1..MAX_INPUT_ROWS rows in between.
export const FOOTER_CHROME_H = 4;
export const MAX_INPUT_ROWS = 10;

// Paint a fragment with the input-box bg. We strip inner `\x1b[0m`
// resets from `body` so the bg persists across embedded fg color codes
// (each `fg.*` ends in a reset, which would otherwise cancel the outer
// bg mid-line). The single trailing reset at the end restores defaults.
function paintInputBg(body) {
    const open = bgOpen("gray");
    if (!open) return String(body);
    const stripped = String(body).replace(/\x1b\[0m/g, "");
    return `${open}${stripped}${ANSI_RESET}`;
}

class Layout {
    constructor() {
        this.active = false;
        this.rows = STREAM.rows || 24;
        this.cols = STREAM.columns || 100;
        this.cwd = "";
        this.title = "copilot-replay";
        this.speed = 1;
        this.paused = false;
        this.started = false;
        this.status = "";
        this.typed = "";
        this.inputRows = 1;
        this.cliMode = false;
        this.model = "";
        // Session agent mode ("interactive", "plan", "autopilot", …).
        // In --cli-mode we show this as a small label in the status bar
        // where the real CLI shows it, instead of emitting
        // "mode X → Y" change lines into the scroll region.
        this.mode = "";
        this.overlayDraw = null; // optional callback rendered atop scroll region
        this._onResize = () => {
            this.rows = STREAM.rows || this.rows;
            this.cols = STREAM.columns || this.cols;
            if (this.active) {
                this._setRegion();
                // On shrink, previous content may now be outside the scroll
                // region. Clear it so nothing bleeds through the footer.
                for (let r = 1; r <= this.scrollBottomRow; r++) {
                    rawWrite(`\x1b[${r};1H\x1b[2K`);
                }
                this.redrawFooter();
                if (this.overlayDraw) this.overlayDraw();
                rawWrite(`\x1b[${this.scrollBottomRow};1H`);
            }
        };
    }

    // Chrome rows around the input box.
    //   Replay mode: [cwd, top rule, <inputs>, bottom rule, status] = 4
    //   CLI mode:    [cwd, blank, <inputs>, blank, status] = 4
    //                 The blank rows are plain (not gray) and frame
    //                 the gray input panel — matches the real Copilot
    //                 CLI input box.
    get _chromeH() {
        return this.cliMode ? 4 : FOOTER_CHROME_H;
    }

    get footerH() {
        return this._chromeH + this.inputRows;
    }

    get scrollBottomRow() {
        return Math.max(1, this.rows - this.footerH);
    }

    get isTTY() {
        return !!STREAM.isTTY;
    }

    enable(cwd) {
        if (!this.isTTY || this.active) return;
        this.cwd = cwd || "";
        this.active = true;
        rawWrite("\x1b[?25l"); // hide cursor
        rawWrite("\x1b[2J\x1b[H"); // clear screen
        this._setRegion();
        this.redrawFooter();
        rawWrite(`\x1b[${this.scrollBottomRow};1H`);
        if (STREAM.on) STREAM.on("resize", this._onResize);
    }

    disable() {
        if (!this.active) return;
        rawWrite("\x1b[r"); // reset scroll region
        rawWrite(`\x1b[${this.rows};1H\n`);
        rawWrite("\x1b[?25h"); // restore cursor
        this.active = false;
        if (STREAM.off) STREAM.off("resize", this._onResize);
    }

    _setRegion() {
        rawWrite(`\x1b[1;${this.scrollBottomRow}r`);
    }

    footerWidth() {
        // Full terminal width, matching the real CLI. No artificial cap —
        // wide terminals should use all the horizontal space.
        return Math.max(20, this.cols);
    }

    // Word-wrap `typed` into lines that fit inside the input box, capped at
    // MAX_INPUT_ROWS. First line has room for "> " (2 chars); continuation
    // lines are indented 2 spaces for alignment.
    _wrapTyped() {
        const W = this.footerWidth();
        const maxFirst = Math.max(10, W - 3);
        const maxRest = Math.max(10, W - 3);
        const out = [];
        const paragraphs = this.typed.split("\n");
        let lineNo = 0;
        for (let p = 0; p < paragraphs.length; p++) {
            let remaining = paragraphs[p];
            if (remaining === "") {
                out.push("");
                lineNo++;
                if (lineNo >= MAX_INPUT_ROWS) break;
                continue;
            }
            while (remaining.length > 0) {
                const max = lineNo === 0 ? maxFirst : maxRest;
                if (remaining.length <= max) {
                    out.push(remaining);
                    remaining = "";
                } else {
                    let cut = remaining.lastIndexOf(" ", max);
                    if (cut < max * 0.5) cut = max;
                    out.push(remaining.slice(0, cut));
                    remaining = remaining.slice(cut).replace(/^ +/, "");
                }
                lineNo++;
                if (lineNo >= MAX_INPUT_ROWS) {
                    remaining = "";
                    break;
                }
            }
            if (lineNo >= MAX_INPUT_ROWS) break;
        }
        if (out.length === 0) out.push("");
        return out;
    }

    _ensureInputRows(n) {
        n = Math.max(1, Math.min(MAX_INPUT_ROWS, n));
        if (n === this.inputRows) return;
        const oldFooterH = this.footerH;
        const newFooterH = this._chromeH + n;
        const diff = newFooterH - oldFooterH;
        if (diff > 0) {
            // Growing the footer shrinks the scroll region from the bottom.
            // Push existing scroll-region content up by `diff` rows so it
            // doesn't get hidden behind the new, taller footer.
            rawWrite(`\x1b[${this.rows - oldFooterH};1H`);
            rawWrite("\n".repeat(diff));
        }
        this.inputRows = n;
        this._setRegion();
        if (diff < 0) {
            // Shrinking: rows that used to be footer are now part of the
            // scroll region and may contain stale text. Clear them.
            const fromRow = this.rows - oldFooterH + 1;
            const toRow = this.rows - newFooterH;
            for (let r = fromRow; r <= toRow; r++) {
                rawWrite(`\x1b[${r};1H\x1b[2K`);
            }
        }
        rawWrite(`\x1b[${this.scrollBottomRow};1H`);
    }

    // Resolve an accent fg wrapper for the current cli-mode mode name.
    // plan → cyan, autopilot → green; other modes (including empty /
    // "interactive") fall back to the primary text color so the chevron
    // and cursor stay readable without implying a mode.
    _modeAccent() {
        const m = (this.mode || "").trim().toLowerCase();
        if (m === "plan") return fg.cyan;
        if (m === "autopilot") return fg.green;
        return fg.white;
    }

    redrawFooter() {
        if (!this.active) return;
        const W = this.footerWidth();
        const rule = fg.gray("─".repeat(W));
        const lines = this._wrapTyped();
        this._ensureInputRows(lines.length);

        const start = this.rows - this.footerH + 1;
        const cliMode = this.cliMode;
        const accent = cliMode ? this._modeAccent() : fg.white;
        rawWrite("\x1b7");
        // Row: cwd
        rawWrite(`\x1b[${start};1H\x1b[2K`);
        rawWrite(`  ${fg.cyan(this.cwd || "")}`);
        let row = start + 1;
        // Replay mode has a ── rule between cwd and the input box; cli
        // mode frames the gray input panel with a plain blank row.
        if (!cliMode) {
            rawWrite(`\x1b[${row};1H\x1b[2K`);
            rawWrite(rule);
        } else {
            rawWrite(`\x1b[${row};1H\x1b[2K`);
        }
        row++;
        // Input rows (gray bg panel in cli mode; plain in replay).
        for (let i = 0; i < this.inputRows; i++) {
            rawWrite(`\x1b[${row};1H\x1b[2K`);
            const line = lines[i] ?? "";
            // First row: "› " (cli, accented) or "> " (replay).
            // Continuation rows indent 2 spaces.
            let body;
            if (i === 0) {
                const chev = cliMode ? accent("›") : fg.white(">");
                body = `${chev} ${fg.white(line)}`;
            } else {
                body = `  ${fg.white(line)}`;
            }
            // CLI mode: draw a block cursor after the text on the last
            // input row, in the mode's accent color. Using explicit
            // "bg=accent fg=accent space" instead of reverse-video so
            // the cursor keeps the mode's color on light *and* dark
            // themes, matching the real Copilot CLI.
            if (cliMode && i === this.inputRows - 1) {
                body += accent("\u2588");
            }
            const visibleLen = stripAnsi(body).length;
            const pad = Math.max(0, this.cols - visibleLen);
            if (cliMode) {
                rawWrite(paintInputBg(body + " ".repeat(pad)));
            } else {
                rawWrite(body);
            }
            row++;
        }
        // Closing chrome row: ── rule (replay) or plain blank (cli).
        if (!cliMode) {
            rawWrite(`\x1b[${row};1H\x1b[2K`);
            rawWrite(rule);
        } else {
            rawWrite(`\x1b[${row};1H\x1b[2K`);
        }
        row++;
        // Status bar.
        rawWrite(`\x1b[${row};1H\x1b[2K`);
        if (cliMode) {
            rawWrite(this._renderCliStatusBar(accent));
        } else {
            rawWrite(this._renderReplayStatusBar());
        }
        rawWrite("\x1b8");
    }

    _renderCliStatusBar(accent) {
        // Match the real Copilot CLI status line:
        //   standard:  / commands · ? help
        //   plan:      plan · / commands · ? help           (teal)
        //   autopilot: autopilot · / commands · ? help      (green)
        //   right:     Hidden Model (or actual model name)  (gray)
        const paint = accent || this._modeAccent();
        const modeLabel = (this.mode || "").trim().toLowerCase();
        const showMode =
            modeLabel && modeLabel !== "interactive" && modeLabel !== "standard";
        const sep = fg.gray("·");
        const segs = [];
        if (showMode) segs.push(paint(modeLabel));
        segs.push(`${paint("/")} ${fg.dim("commands")}`);
        segs.push(`${paint("?")} ${fg.dim("help")}`);
        const left = segs.join(`  ${sep}  `);
        const rawModel = (this.model || "").trim();
        const modelName =
            !rawModel || rawModel === "unknown" ? "Hidden Model" : rawModel;
        const right = fg.gray(modelName);
        const gap = Math.max(
            1,
            this.cols - stripAnsi(left).length - stripAnsi(right).length,
        );
        return `${left}${" ".repeat(gap)}${right}`;
    }

    _renderReplayStatusBar() {
        const speedStr = fg.bold(fg.white(formatSpeed(this.speed)));
        const ctlFull = this.paused
            ? this.started
                ? `${fg.yellow("⏸ paused")}  ${fg.gray(
                      "space resume   ← → step   q quit",
                  )}`
                : `${fg.yellow("⏸")}  ${fg.bold(fg.white("press space"))} ` +
                  `${fg.gray("to start replay   q quit")}`
            : `${fg.gray("space pause   ← → prev/next   +/− speed   q quit")}`;
        const ctlMedium = this.paused
            ? this.started
                ? `${fg.yellow("⏸")}  ${fg.gray("space ← → q")}`
                : `${fg.yellow("⏸")}  ${fg.bold(fg.white("space"))} ${fg.gray("to start")}`
            : `${fg.gray("space  ← →  +/−  q")}`;
        const ctlShort = this.paused ? `${fg.yellow("⏸")}` : "";

        const right = "copilot-replay";
        const rightLen = right.length;

        let bar = "";
        const tryFit = (ctl, showRight) => {
            const candidate = `${speedStr}  ${ctl}`;
            const cLen = stripAnsi(candidate).length;
            const rLen = showRight ? rightLen : 0;
            const gap = this.cols - cLen - rLen;
            if (gap >= 1) {
                bar = showRight
                    ? `${candidate}${" ".repeat(gap)}${fg.gray(right)}`
                    : `${candidate}${" ".repeat(Math.max(0, gap))}`;
                return true;
            }
            return false;
        };

        if (
            !tryFit(ctlFull, true) &&
            !tryFit(ctlFull, false) &&
            !tryFit(ctlMedium, false) &&
            !tryFit(ctlShort, false)
        ) {
            bar = speedStr;
        }
        return bar;
    }

    setCliMode(on, model) {
        const next = !!on;
        if (typeof model === "string") this.model = model;
        if (next === this.cliMode) {
            if (this.active) this.redrawFooter();
            return;
        }
        if (!this.active) {
            this.cliMode = next;
            return;
        }
        // Chrome height is changing; treat this like a footer resize.
        // Clear the current footer rows, flip the flag, reset the
        // scroll region, and repaint.
        const oldFooterH = this.footerH;
        const oldStart = this.rows - oldFooterH + 1;
        for (let r = oldStart; r <= this.rows; r++) {
            rawWrite(`\x1b[${r};1H\x1b[2K`);
        }
        this.cliMode = next;
        this._setRegion();
        this.redrawFooter();
        rawWrite(`\x1b[${this.scrollBottomRow};1H`);
    }

    setModel(model) {
        if (typeof model !== "string") return;
        this.model = model;
        if (this.active && this.cliMode) this.redrawFooter();
    }

    setMode(mode) {
        if (typeof mode !== "string") return;
        this.mode = mode;
        if (this.active && this.cliMode) this.redrawFooter();
    }

    setSpeed(n) {
        this.speed = n;
        if (this.active) this.redrawFooter();
    }

    setPaused(p) {
        this.paused = p;
        if (p === false) this.started = true;
        if (this.active) this.redrawFooter();
    }

    // Type a single character into the input box. To avoid per-keystroke
    // flashing we take a fast path: if the new character lands on the same
    // last row as before, we just position the cursor at the end of the
    // current text and write the new character — no `\x1b[2K` erase, no
    // line rewrite. We fall back to a full footer redraw whenever the
    // input box wraps to a new row, the row count changes, or the diff
    // isn't a clean append (defensive).
    appendChar(ch) {
        if (!this.active) {
            this.typed += ch;
            return;
        }
        const beforeLines = this._wrapTyped();
        this.typed += ch;
        const afterLines = this._wrapTyped();

        if (afterLines.length !== this.inputRows) {
            this._ensureInputRows(afterLines.length);
            this.redrawFooter();
            return;
        }
        const lastIdx = afterLines.length - 1;
        const beforeLast = beforeLines[lastIdx] ?? "";
        const afterLast = afterLines[lastIdx];
        if (
            afterLines.length !== beforeLines.length ||
            !afterLast.startsWith(beforeLast)
        ) {
            // Wrapping reflowed earlier rows (e.g. a word break moved
            // content from row N-1 to row N). Safest to do a full redraw.
            this.redrawFooter();
            return;
        }
        const suffix = afterLast.slice(beforeLast.length);
        if (suffix.length === 0) return;

        const start = this.rows - this.footerH + 1;
        // In replay mode the first input row sits below cwd + top rule
        // (offset 2); in cli mode there's no top rule (offset 1).
        // Both replay and cli mode have one chrome row above the
        // first input row (rule or blank), so input starts at +2.
        const inputRow0 = start + 2;
        const row = inputRow0 + lastIdx;
        // Both first row ("> ") and continuation rows ("  ") start
        // content at column 3.
        const col = 3 + beforeLast.length;
        rawWrite("\x1b7");
        rawWrite(`\x1b[${row};${col}H${paintInputBg(fg.white(suffix))}`);
        rawWrite("\x1b8");
    }

    setTyped(text) {
        this.typed = text;
        this.redrawFooter();
    }

    clearTyped() {
        this.setTyped("");
    }

    setStatus(s) {
        this.status = s;
        this.redrawFooter();
    }

    scrollWriteln(s = "") {
        if (this.active) {
            rawWrite(`\x1b[${this.scrollBottomRow};1H`);
            rawWrite(s + "\n");
        } else {
            STREAM.write(s + "\n");
        }
    }

    commitPrompt(content) {
        const W = this.footerWidth();
        const wrapped = wrapLines(content, 2);
        const out = (s) => this.scrollWriteln(s);
        out("");
        if (this.cliMode) {
            // Committed prompts look like a gray panel in the feed,
            // identical in shape to the live input box: just the text
            // rows painted with the input bg, framed by the surrounding
            // blank scroll-region rows. The accent-colored chevron
            // matches the mode that was active when the prompt was sent.
            const accent = this._modeAccent();
            for (let i = 0; i < wrapped.length; i++) {
                const body = i === 0
                    ? `${accent("›")} ${fg.white(wrapped[i])}`
                    : `  ${fg.white(wrapped[i])}`;
                const visibleLen = stripAnsi(body).length;
                const pad = Math.max(0, W - visibleLen);
                out(paintInputBg(body + " ".repeat(pad)));
            }
        } else {
            out(fg.gray("─".repeat(W)));
            for (let i = 0; i < wrapped.length; i++) {
                out(
                    i === 0
                        ? `${fg.gray(">")} ${fg.white(wrapped[i])}`
                        : `  ${fg.white(wrapped[i])}`,
                );
            }
            out(fg.gray("─".repeat(W)));
        }
        out("");
        this.typed = "";
        this._ensureInputRows(1);
        this.redrawFooter();
    }
}

// Singleton — there's only ever one stdout, so one Layout.
export const layout = new Layout();
setLayoutRef(layout);
