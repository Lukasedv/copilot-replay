// Sticky-header / sticky-footer terminal layout.
//
// When stdout is a TTY we carve the screen into an optional header, a
// scroll region, and a fixed footer that mirrors today's Copilot CLI
// chrome (1.0.100+):
//
//     ┌───────────────────────────────────────┐
//     │  Current   Sessions   Issues   …       │  ← header (cli mode only)
//     │                                        │
//     │ replay content …                       │  ← scroll region
//     │ …                                      │
//     │ ~\repo [⎇ main]       Session: 3 AIC   │  ← context line
//     │╻▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄│  ← prompt frame (half blocks
//     │┃ typed prompt…█                        │     in the panel color, left
//     │╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀│     bar in the mode color)
//     │ Interactive · Manual Approval …  Model │  ← status line
//     └────────────────────────────────────────┘
//
// The input box is where `user.message` events are "typed" char-by-char.
// When the prompt finishes typing, it's committed: cleared from the box and
// emitted as a panel into the scroll region above. A modal "dialog"
// (ask_user / plan approval) can temporarily replace the whole footer,
// just like the CLI's bottom-anchored dialogs.

import { ANSI_RESET, ICON, bgOpen, fg, stripAnsi } from "./ansi.js";
import { STREAM, rawWrite, setLayoutRef } from "./io.js";
import { ellipsize, formatSpeed, prettyModelName, wrapLines } from "./format.js";

// Non-input footer rows: context line, frame top, frame bottom, status (=4).
// The input box itself occupies 1..MAX_INPUT_ROWS rows in between.
export const FOOTER_CHROME_H = 4;
export const MAX_INPUT_ROWS = 10;

// Paint a fragment with a bg color. Inner `\x1b[0m` resets are re-opened
// with the bg so it persists across embedded fg color codes (each `fg.*`
// ends in a reset, which would otherwise cancel the bg mid-line).
export function paintBg(body, name = "panel") {
    const open = bgOpen(name);
    if (!open) return String(body);
    const s = String(body).replace(/\x1b\[0m/g, `\x1b[0m${open}`);
    return `${open}${s}${ANSI_RESET}`;
}

// Text shown on the CLI's execution-mode badge / status line.
export function modeLabel(mode) {
    switch ((mode || "").trim().toLowerCase()) {
        case "plan":
            return "Plan";
        case "autopilot":
            return "Autopilot";
        case "shell":
            return "Shell";
        default:
            return "Interactive";
    }
}

export function modeAccent(mode) {
    switch ((mode || "").trim().toLowerCase()) {
        case "plan":
            return fg.modePlan;
        case "autopilot":
            return fg.modeAutopilot;
        case "shell":
            return fg.modeShell;
        default:
            return fg.modeInteractive;
    }
}

class Layout {
    constructor() {
        this.active = false;
        this.rows = STREAM.rows || 24;
        this.cols = STREAM.columns || 100;
        this.cwd = "";
        this.branch = "";
        this.title = "copilot-replay";
        this.speed = 1;
        this.paused = false;
        this.started = false;
        this.status = "";
        this.typed = "";
        this.inputRows = 1;
        this.cliMode = false;
        this.model = "";
        this.mode = "";
        this.allowAll = false;
        this.aic = null;
        this.busy = false;
        this.dialog = null; // array of pre-rendered rows replacing the footer
        // Recent scroll-region rows, bottom-anchored. Lets us repaint the
        // region when the footer shrinks or the terminal resizes instead
        // of leaving blank gaps where the footer used to be.
        this.history = [];
        this._footerH = FOOTER_CHROME_H + 1;
        this.overlayDraw = null; // optional callback rendered atop scroll region
        this._onResize = () => {
            this.rows = STREAM.rows || this.rows;
            this.cols = STREAM.columns || this.cols;
            if (this.active) {
                this._footerH = this._buildFooter().length;
                this._setRegion();
                this.repaintScrollRegion();
                this._drawHeader();
                this.redrawFooter();
                if (this.overlayDraw) this.overlayDraw();
                rawWrite(`\x1b[${this.scrollBottomRow};1H`);
            }
        };
    }

    recordLine(s) {
        this.history.push(String(s));
        if (this.history.length > 1000) this.history.splice(0, this.history.length - 1000);
    }

    // Row the next timeline line goes on. Content grows down from the
    // top of the region (like the CLI's fullscreen timeline) until it
    // fills up, then scrolls from the bottom row.
    get nextRow() {
        const height = this.scrollBottomRow - this.scrollTopRow;
        return this.history.length < height
            ? this.scrollTopRow + this.history.length
            : this.scrollBottomRow;
    }

    // Redraw the scroll region from `history` (latest rows, top-anchored).
    repaintScrollRegion() {
        if (!this.active) return;
        const top = this.scrollTopRow;
        const bottom = this.scrollBottomRow;
        // The last row of the region is the "cursor row" new lines are
        // written onto, so content occupies the rows above it.
        const height = bottom - top;
        const visible = this.history.slice(Math.max(0, this.history.length - height));
        for (let r = top; r <= bottom; r++) {
            const line = visible[r - top] ?? "";
            rawWrite(`\x1b[${r};1H\x1b[2K${line}`);
        }
        rawWrite(`\x1b[${this.nextRow};1H`);
    }

    // Header rows above the scroll region: the CLI's home tabs plus a
    // blank spacer (cli mode only).
    get headerH() {
        return this.cliMode ? 2 : 0;
    }

    get footerH() {
        return this._footerH;
    }

    get scrollTopRow() {
        return this.headerH + 1;
    }

    get scrollBottomRow() {
        return Math.max(this.scrollTopRow, this.rows - this.footerH);
    }

    get isTTY() {
        return !!STREAM.isTTY;
    }

    enable(cwd) {
        if (!this.isTTY || this.active) return;
        this.cwd = cwd || this.cwd || "";
        this.active = true;
        rawWrite("\x1b[?25l"); // hide cursor
        rawWrite("\x1b[2J\x1b[H"); // clear screen
        this._footerH = this._buildFooter().length;
        this._setRegion();
        this._drawHeader();
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
        rawWrite(`\x1b[${this.scrollTopRow};${this.scrollBottomRow}r`);
    }

    // Clear every row of the scroll region and park the cursor at its
    // bottom. Used by overlays and rewinds.
    clearScrollRegion() {
        this.history = [];
        if (!this.active) return;
        for (let r = this.scrollTopRow; r <= this.scrollBottomRow; r++) {
            rawWrite(`\x1b[${r};1H\x1b[2K`);
        }
        rawWrite(`\x1b[${this.scrollBottomRow};1H`);
    }

    footerWidth() {
        return Math.max(20, this.cols);
    }

    // Word-wrap `typed` into lines that fit inside the input box, capped at
    // MAX_INPUT_ROWS. Content starts after "┃ " (2 columns) and leaves
    // one column for the cursor.
    _wrapTyped() {
        const W = this.footerWidth();
        const max = Math.max(10, W - 4);
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

    // Change the footer height, keeping scroll-region content visible.
    _resizeFooter(newH) {
        const oldH = this._footerH;
        if (newH === oldH) return;
        this._footerH = newH;
        this._setRegion();
        // Rows that changed hands between footer and scroll region get
        // repainted from history so content stays anchored right above
        // the footer.
        if (newH < oldH) {
            for (let r = this.rows - oldH + 1; r <= this.rows - newH; r++) {
                rawWrite(`\x1b[${r};1H\x1b[2K`);
            }
        }
        this.repaintScrollRegion();
    }

    _accent() {
        return modeAccent(this.mode);
    }

    _drawHeader() {
        if (!this.active || this.headerH === 0) return;
        const tabs = ["Current", "Sessions", "Issues", "Pull requests", "Gists"];
        const line =
            "  " +
            tabs
                .map((t, i) => (i === 0 ? fg.bold(fg.white(t)) : fg.gray(t)))
                .join("   ");
        rawWrite("\x1b7");
        rawWrite(`\x1b[1;1H\x1b[2K${line}`);
        rawWrite(`\x1b[2;1H\x1b[2K`);
        rawWrite("\x1b8");
    }

    _contextLine() {
        const W = this.footerWidth();
        const right =
            this.cliMode && this.aic != null
                ? `Session: ${this.aic.toFixed(2)} AIC used`
                : "";
        const branch = this.branch ? ` [${ICON.branch} ${this.branch}]` : "";
        const room = Math.max(8, W - 2 - right.length - branch.length - 2);
        const cwd = ellipsize(this.cwd || "", room);
        const leftPlain = ` ${cwd}${branch}`;
        const left =
            ` ${fg.gray(cwd)}` +
            (this.branch ? ` ${fg.branchBadge(`[${ICON.branch} ${this.branch}]`)}` : "");
        if (!right) return left;
        const gap = Math.max(1, W - leftPlain.length - right.length - 1);
        return `${left}${" ".repeat(gap)}${fg.gray(right)}`;
    }

    _buildFooter() {
        if (this.dialog) return this.dialog.slice();
        const W = this.footerWidth();
        const accent = this._accent();
        const lines = this._wrapTyped().slice(0, MAX_INPUT_ROWS);
        this.inputRows = lines.length;
        const out = [];
        out.push(this._contextLine());
        out.push(`${accent("╻")}${fg.panel("▄".repeat(W - 1))}`);
        for (let i = 0; i < lines.length; i++) {
            let body = ` ${fg.white(lines[i])}`;
            if (i === lines.length - 1) body += accent("█");
            const pad = Math.max(0, W - 1 - stripAnsi(body).length);
            out.push(`${accent("┃")}${paintBg(body + " ".repeat(pad))}`);
        }
        out.push(`${accent("╹")}${fg.panel("▀".repeat(W - 1))}`);
        out.push(this.cliMode ? this._renderCliStatusBar() : this._renderReplayStatusBar());
        return out;
    }

    redrawFooter() {
        if (!this.active) return;
        const lines = this._buildFooter();
        this._resizeFooter(lines.length);
        const start = this.rows - this.footerH + 1;
        rawWrite("\x1b7");
        for (let i = 0; i < lines.length; i++) {
            rawWrite(`\x1b[${start + i};1H\x1b[2K${lines[i]}`);
        }
        rawWrite("\x1b8");
    }

    _renderCliStatusBar() {
        // Match the real Copilot CLI status line:
        //   idle:  Interactive · Manual Approval · / commands     Model
        //   busy:  ◎ Working · Plan · ctrl+c interrupt          Model
        const accent = this._accent();
        const sep = fg.gray(" · ");
        const perm = this.allowAll ? "Allow All" : "Manual Approval";
        let left;
        if (this.busy) {
            const segs = [`${accent(ICON.dot)} ${fg.gray("Working")}`];
            if ((this.mode || "interactive") !== "interactive") {
                segs.push(accent(modeLabel(this.mode)));
            }
            segs.push(fg.gray("ctrl+c interrupt"));
            left = " " + segs.join(sep);
        } else {
            left =
                " " +
                [accent(modeLabel(this.mode)), fg.gray(perm), fg.gray("/ commands")]
                    .join(sep);
        }
        const rawModel = (this.model || "").trim();
        const modelName =
            !rawModel || rawModel === "unknown" ? "" : prettyModelName(rawModel);
        const right = fg.gray(modelName);
        const gap = Math.max(
            1,
            this.cols - stripAnsi(left).length - stripAnsi(right).length - 1,
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

        const accent = this._accent();
        const mode = this.mode ? `${accent(modeLabel(this.mode))}  ` : "";
        const right = "copilot-replay";
        const rightLen = right.length + 1;

        let bar = "";
        const tryFit = (ctl, showRight, showMode = true) => {
            const candidate = ` ${showMode ? mode : ""}${speedStr}  ${ctl}`;
            const cLen = stripAnsi(candidate).length;
            const rLen = showRight ? rightLen : 0;
            const gap = this.cols - cLen - rLen;
            if (gap >= 1) {
                bar = showRight
                    ? `${candidate}${" ".repeat(gap)}${fg.gray(right)}`
                    : candidate;
                return true;
            }
            return false;
        };

        if (
            !tryFit(ctlFull, true) &&
            !tryFit(ctlFull, false) &&
            !tryFit(ctlMedium, false) &&
            !tryFit(ctlMedium, false, false) &&
            !tryFit(ctlShort, false, false)
        ) {
            bar = ` ${speedStr}`;
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
        rawWrite("\x1b[2J");
        this.cliMode = next;
        this._footerH = this._buildFooter().length;
        this._setRegion();
        this._drawHeader();
        this.redrawFooter();
        rawWrite(`\x1b[${this.scrollBottomRow};1H`);
    }

    _setState(key, value) {
        if (this[key] === value) return;
        this[key] = value;
        if (this.active) this.redrawFooter();
    }

    setModel(model) {
        if (typeof model === "string") this._setState("model", model);
    }

    setMode(mode) {
        if (typeof mode === "string") this._setState("mode", mode);
    }

    setBranch(branch) {
        if (typeof branch === "string") this._setState("branch", branch);
    }

    setAllowAll(on) {
        this._setState("allowAll", !!on);
    }

    setAic(n) {
        if (Number.isFinite(n)) this._setState("aic", n);
    }

    setBusy(on) {
        this._setState("busy", !!on);
    }

    // Replace the footer with a modal dialog (array of rendered rows), or
    // pass null to restore the prompt frame.
    setDialog(lines) {
        this.dialog = lines && lines.length ? lines : null;
        if (this.active) this.redrawFooter();
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
    // current text and write the new character (plus the cursor block)
    // without erasing the line. We fall back to a full footer redraw
    // whenever the input box wraps, the row count changes, or the diff
    // isn't a clean append (defensive).
    appendChar(ch) {
        if (!this.active || this.dialog) {
            this.typed += ch;
            if (this.active) this.redrawFooter();
            return;
        }
        const beforeLines = this._wrapTyped();
        this.typed += ch;
        const afterLines = this._wrapTyped();

        if (afterLines.length !== beforeLines.length) {
            this.redrawFooter();
            return;
        }
        const lastIdx = afterLines.length - 1;
        const beforeLast = beforeLines[lastIdx] ?? "";
        const afterLast = afterLines[lastIdx];
        if (!afterLast.startsWith(beforeLast)) {
            this.redrawFooter();
            return;
        }
        const suffix = afterLast.slice(beforeLast.length);
        if (suffix.length === 0) return;

        const start = this.rows - this.footerH + 1;
        // Input rows start below the context line and the frame top.
        const row = start + 2 + lastIdx;
        // "┃ " occupies columns 1-2, so text starts at column 3.
        const col = 3 + beforeLast.length;
        rawWrite("\x1b7");
        rawWrite(
            `\x1b[${row};${col}H` +
                paintBg(fg.white(suffix) + this._accent()("█")),
        );
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
            rawWrite(`\x1b[${this.nextRow};1H\x1b[2K${s}\n`);
            this.recordLine(s);
        } else {
            STREAM.write(s + "\n");
        }
    }

    commitPrompt(content) {
        const out = (s) => this.scrollWriteln(s);
        for (const ln of renderPromptPanel(content, this.footerWidth(), this._accent())) {
            out(ln);
        }
        this.typed = "";
        this.redrawFooter();
    }
}

// A submitted prompt as it appears in the CLI timeline: a panel in the
// backgroundSecondary color framed by half-block rows, with a mode-tinted
// "❯" and continuation lines indented under the text.
export function renderPromptPanel(content, width, accent = fg.modeInteractive) {
    const W = Math.max(20, width);
    const inner = W - 2; // one column margin left, one right
    const wrapped = wrapLines(content, 6);
    const lines = [];
    lines.push(` ${fg.panel("▄".repeat(inner))}`);
    for (let i = 0; i < wrapped.length; i++) {
        const body =
            i === 0
                ? ` ${accent(ICON.chevron)} ${fg.white(wrapped[i])}`
                : `   ${fg.white(wrapped[i])}`;
        const pad = Math.max(0, inner - stripAnsi(body).length);
        lines.push(` ${paintBg(body + " ".repeat(pad))}`);
    }
    lines.push(` ${fg.panel("▀".repeat(inner))}`);
    return lines;
}

// Singleton — there's only ever one stdout, so one Layout.
export const layout = new Layout();
setLayoutRef(layout);
