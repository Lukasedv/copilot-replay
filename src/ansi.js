// ANSI color / terminal helpers.
//
// Colors are disabled when stdout is not a TTY or when NO_COLOR is set,
// following the widely-adopted https://no-color.org convention.

import process from "node:process";

export const isTTY = !!process.stdout.isTTY;
export const NO_COLOR = !!process.env.NO_COLOR || !isTTY;

export const ESC = "\x1b[";

// Two palettes taken from the Copilot CLI's built-in "GitHub" theme (the
// default since CLI 1.0.64), expressed as hex and converted to SGR at
// paint time: 24-bit when the terminal advertises truecolor, otherwise
// the nearest xterm-256 color.
//
// The "white" slot is semantically "primary readable text" — on a dark
// background that's near-white, on a light background it collapses to
// near-black. "gray" is the CLI's textSecondary and "dim" its
// textTertiary. The remaining roles mirror the CLI theme tokens.
const PALETTES = {
    dark: {
        white: "#F0F6FC",
        gray: "#9198A1",
        dim: "#6E7681",
        red: "#F85149",
        green: "#3FB950",
        yellow: "#D29922",
        orange: "#DB6D28",
        blue: "#4493F8",
        cyan: "#39C5CF",
        magenta: "#A475F9",
        brand: "#4493F8",
        link: "#39C5CF",
        border: "#3D444D",
        panel: "#141B22",
        modeInteractive: "#818B98",
        modePlan: "#2F81F7",
        modeAutopilot: "#A475F9",
        modeShell: "#D29922",
        mascotHead: "#8534F3",
        mascotEyes: "#5FED83",
        mascotGoggles: "#3094FF",
        branchBadge: "#58A6FF",
    },
    light: {
        white: "#1F2328",
        gray: "#59636E",
        dim: "#6E7781",
        red: "#CF222E",
        green: "#1A7F37",
        yellow: "#9A6700",
        orange: "#BC4C00",
        blue: "#0969DA",
        cyan: "#1B7C83",
        magenta: "#8250DF",
        brand: "#0969DA",
        link: "#0969DA",
        border: "#D1D9E0",
        panel: "#E8E9EB",
        modeInteractive: "#59636E",
        modePlan: "#0969DA",
        modeAutopilot: "#8250DF",
        modeShell: "#9A6700",
        mascotHead: "#8534F3",
        mascotEyes: "#1A7F37",
        mascotGoggles: "#3094FF",
        branchBadge: "#0969DA",
    },
};

const BG_PALETTES = {
    // "gray"/"panel" is the CLI's backgroundSecondary (prompt frame and
    // committed-prompt panel); "code" is the inline-code chip.
    dark: { gray: "#141B22", panel: "#141B22", code: "#262C36" },
    light: { gray: "#E8E9EB", panel: "#E8E9EB", code: "#E8E9EB" },
};

// 24-bit color is used when the terminal says it supports it. Windows
// Terminal, VS Code, iTerm2, WezTerm, Ghostty and kitty all do; plain
// conhost / older terminals get the xterm-256 approximation.
// COPILOT_REPLAY_COLOR=256|truecolor forces either mode.
function detectTruecolor() {
    const force = String(process.env.COPILOT_REPLAY_COLOR || "").toLowerCase();
    if (force === "256") return false;
    if (force === "truecolor" || force === "24bit") return true;
    const ct = String(process.env.COLORTERM || "").toLowerCase();
    if (ct === "truecolor" || ct === "24bit") return true;
    if (process.env.WT_SESSION) return true;
    const tp = String(process.env.TERM_PROGRAM || "");
    if (/^(vscode|iTerm\.app|WezTerm|ghostty|Hyper|Tabby)$/i.test(tp)) return true;
    const term = String(process.env.TERM || "");
    if (/direct|truecolor|kitty|ghostty/i.test(term)) return true;
    return false;
}

export const TRUECOLOR = detectTruecolor();

function hexToRgb(hex) {
    const h = hex.replace("#", "");
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}

// Nearest xterm-256 index for an RGB triple (6×6×6 cube or gray ramp).
function rgbTo256([r, g, b]) {
    const steps = [0, 95, 135, 175, 215, 255];
    const idx = (v) => {
        let best = 0;
        for (let i = 1; i < steps.length; i++) {
            if (Math.abs(steps[i] - v) < Math.abs(steps[best] - v)) best = i;
        }
        return best;
    };
    const ri = idx(r);
    const gi = idx(g);
    const bi = idx(b);
    const cube = [steps[ri], steps[gi], steps[bi]];
    const cubeDist =
        (cube[0] - r) ** 2 + (cube[1] - g) ** 2 + (cube[2] - b) ** 2;
    const avg = Math.round((r + g + b) / 3);
    const grayIdx = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
    const gv = 8 + grayIdx * 10;
    const grayDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
    return grayDist < cubeDist
        ? 232 + grayIdx
        : 16 + 36 * ri + 6 * gi + bi;
}

const _sgrCache = new Map();
function sgrFor(hex, layer) {
    const key = `${layer}${hex}`;
    let v = _sgrCache.get(key);
    if (v) return v;
    const rgb = hexToRgb(hex);
    const base = layer === "bg" ? 48 : 38;
    v = TRUECOLOR
        ? `${base};2;${rgb[0]};${rgb[1]};${rgb[2]}`
        : `${base};5;${rgbTo256(rgb)}`;
    _sgrCache.set(key, v);
    return v;
}

let currentTheme = "dark";

export function setTheme(name) {
    if (PALETTES[name]) currentTheme = name;
}

export function getTheme() {
    return currentTheme;
}

const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

// Resolve the SGR code at call time so theme switches between modules
// without re-importing. NO_COLOR short-circuits to identity.
const fgPaint = (name) =>
    NO_COLOR
        ? (s) => String(s)
        : (s) =>
              `${ESC}${sgrFor(PALETTES[currentTheme][name], "fg")}m${s}${ESC}0m`;

const bgPaint = (name) =>
    NO_COLOR
        ? (s) => String(s)
        : (s) =>
              `${ESC}${sgrFor(BG_PALETTES[currentTheme][name], "bg")}m${s}${ESC}0m`;

// Opening SGR for a palette fg role without the trailing reset.
export function fgOpen(name) {
    if (NO_COLOR) return "";
    const hex = PALETTES[currentTheme][name];
    return hex ? `${ESC}${sgrFor(hex, "fg")}m` : "";
}

const boldPaint = NO_COLOR
    ? (s) => String(s)
    : (s) => `${ESC}1m${s}${ESC}0m`;

// "dim" used to be SGR 2 ("faint"), which most terminals render by blending
// the foreground toward the background. On light themes that makes the text
// essentially invisible. We use an explicit mid-grey instead, theme-aware,
// and strip any inner SGR sequences so callers like fg.dim(fg.gray(x))
// actually render in the dim color rather than having the inner reset
// cancel the outer color.
const dimPaint = NO_COLOR
    ? (s) => String(s)
    : (s) =>
          `${ESC}${sgrFor(PALETTES[currentTheme].dim, "fg")}m` +
          `${String(s).replace(ANSI_SGR_RE, "")}${ESC}0m`;

const italicPaint = NO_COLOR
    ? (s) => String(s)
    : (s) => `${ESC}3m${s}${ESC}23m`;

export const fg = {
    gray: fgPaint("gray"),
    dim: dimPaint,
    bold: boldPaint,
    italic: italicPaint,
    red: fgPaint("red"),
    green: fgPaint("green"),
    yellow: fgPaint("yellow"),
    orange: fgPaint("orange"),
    blue: fgPaint("blue"),
    cyan: fgPaint("cyan"),
    magenta: fgPaint("magenta"),
    white: fgPaint("white"),
    brand: fgPaint("brand"),
    link: fgPaint("link"),
    border: fgPaint("border"),
    panel: fgPaint("panel"),
    modeInteractive: fgPaint("modeInteractive"),
    modePlan: fgPaint("modePlan"),
    modeAutopilot: fgPaint("modeAutopilot"),
    modeShell: fgPaint("modeShell"),
    mascotHead: fgPaint("mascotHead"),
    mascotEyes: fgPaint("mascotEyes"),
    mascotGoggles: fgPaint("mascotGoggles"),
    branchBadge: fgPaint("branchBadge"),
};

export const bg = {
    gray: bgPaint("gray"),
    panel: bgPaint("panel"),
    code: bgPaint("code"),
};

// Opening SGR code for a bg color, without the trailing reset. Lets
// callers paint a backgrounded region that embeds other fg colors
// without each inner reset cancelling the bg. The caller is
// responsible for emitting `\x1b[0m` at the end.
export function bgOpen(name) {
    if (NO_COLOR) return "";
    const hex = BG_PALETTES[currentTheme][name];
    return hex ? `${ESC}${sgrFor(hex, "bg")}m` : "";
}

export const ANSI_RESET = NO_COLOR ? "" : `${ESC}0m`;

export const BULLET = "●";

// Timeline glyphs used by the current Copilot CLI (CLI icon set).
export const ICON = {
    filled: "●",
    empty: "○",
    dot: "◎",
    cross: "✗",
    check: "✓",
    task: "✔",
    warning: "!",
    chevron: "❯",
    chevronDown: "⌄",
    shell: "$",
    search: "/",
    childLast: "└",
    childMid: "│",
    branch: "⎇",
};

// Strip ANSI SGR sequences so we can measure visible width.
export function stripAnsi(s) {
    return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

// Sanitize an untrusted string before writing it to the terminal.
//
// events.jsonl and workspace.yaml are attacker-controlled in the threat
// model of "replay a session file someone sent me". A crafted string can
// contain OSC/CSI/DCS/APC escapes that manipulate the clipboard (OSC 52),
// change the terminal title (OSC 0), inject hyperlinks (OSC 8), clear the
// screen (CSI 2J), or reposition the cursor. We neutralize the problem at
// ingest time by stripping every ESC (0x1B), all C1 controls (0x80-0x9F),
// and the C0 controls that have no place in replayed text content — keeping
// only \t (0x09) and \n (0x0A). Our own rendering code re-adds SGR color
// sequences after this sanitization pass, so user-facing formatting is
// unaffected.
export function sanitizeString(s) {
    if (typeof s !== "string") return s;
    return s.replace(
        // eslint-disable-next-line no-control-regex
        /[\x00-\x08\x0B-\x1F\x7F\x80-\x9F]/g,
        "",
    );
}

// Recursively sanitize every string leaf in a JSON-like value. Returns a
// new value; does not mutate the input.
export function sanitizeDeep(value) {
    if (typeof value === "string") return sanitizeString(value);
    if (Array.isArray(value)) return value.map(sanitizeDeep);
    if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value)) out[k] = sanitizeDeep(value[k]);
        return out;
    }
    return value;
}
