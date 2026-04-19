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
import { fg, stripAnsi } from "./ansi.js";
import { STREAM, rawWrite, setLayoutRef } from "./io.js";
import { formatSpeed, wrapLines } from "./format.js";

// Non-input footer rows: cwd, top-rule, bottom-rule, status bar (=4).
// The input box itself occupies 1..MAX_INPUT_ROWS rows in between.
export const FOOTER_CHROME_H = 4;
export const MAX_INPUT_ROWS = 10;

export class Layout {
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

    get footerH() {
        return FOOTER_CHROME_H + this.inputRows;
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
        const newFooterH = FOOTER_CHROME_H + n;
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

    redrawFooter() {
        if (!this.active) return;
        const W = this.footerWidth();
        const rule = fg.gray("─".repeat(W));
        const lines = this._wrapTyped();
        this._ensureInputRows(lines.length);

        const start = this.rows - this.footerH + 1;
        rawWrite("\x1b7");
        // Row 1: cwd
        rawWrite(`\x1b[${start};1H\x1b[2K`);
        rawWrite(`  ${fg.cyan(this.cwd || "")}`);
        // Row 2: top rule
        rawWrite(`\x1b[${start + 1};1H\x1b[2K`);
        rawWrite(rule);
        // Rows 3..(3+inputRows-1): input text
        for (let i = 0; i < this.inputRows; i++) {
            rawWrite(`\x1b[${start + 2 + i};1H\x1b[2K`);
            const line = lines[i] ?? "";
            if (i === 0) {
                rawWrite(`${fg.gray(">")} ${fg.white(line)}`);
            } else {
                rawWrite(`  ${fg.white(line)}`);
            }
        }
        // Bottom rule
        rawWrite(`\x1b[${start + 2 + this.inputRows};1H\x1b[2K`);
        rawWrite(rule);
        // Status bar — dynamically hide elements when the terminal is narrow.
        rawWrite(`\x1b[${start + 3 + this.inputRows};1H\x1b[2K`);
        const speedStr = fg.bold(fg.white(formatSpeed(this.speed)));

        // Build controls string at various detail levels.
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
        const ctlShort = this.paused
            ? `${fg.yellow("⏸")}`
            : "";

        const right = "copilot-replay";
        const rightLen = right.length;

        // Try full → medium → short → no-right progressively.
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
        rawWrite(bar);
        rawWrite("\x1b8");
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

    // Type a single character into the input box and update only the
    // affected rows. Falls back to a full footer redraw whenever the input
    // box height needs to grow or shrink.
    appendChar(ch) {
        if (!this.active) {
            this.typed += ch;
            return;
        }
        const before = this.inputRows;
        this.typed += ch;
        const lines = this._wrapTyped();
        const needRows = lines.length;
        if (needRows !== before) {
            this._ensureInputRows(needRows);
            this.redrawFooter();
            return;
        }
        const start = this.rows - this.footerH + 1;
        rawWrite("\x1b7");
        for (let i = 0; i < this.inputRows; i++) {
            rawWrite(`\x1b[${start + 2 + i};1H\x1b[2K`);
            const line = lines[i] ?? "";
            if (i === 0) {
                rawWrite(`${fg.gray(">")} ${fg.white(line)}`);
            } else {
                rawWrite(`  ${fg.white(line)}`);
            }
        }
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
        out(fg.gray("─".repeat(W)));
        for (let i = 0; i < wrapped.length; i++) {
            out(
                i === 0
                    ? `${fg.gray(">")} ${fg.white(wrapped[i])}`
                    : `  ${fg.white(wrapped[i])}`,
            );
        }
        out(fg.gray("─".repeat(W)));
        out("");
        this.typed = "";
        this._ensureInputRows(1);
        this.redrawFooter();
    }
}

// Singleton — there's only ever one stdout, so one Layout.
export const layout = new Layout();
setLayoutRef(layout);
