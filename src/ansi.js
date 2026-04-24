// ANSI color / terminal helpers.
//
// Colors are disabled when stdout is not a TTY or when NO_COLOR is set,
// following the widely-adopted https://no-color.org convention.

import process from "node:process";

export const isTTY = !!process.stdout.isTTY;
export const NO_COLOR = !!process.env.NO_COLOR || !isTTY;

export const ESC = "\x1b[";

// Two palettes of 256-color SGR codes, picked so each role has acceptable
// contrast (~4.5:1 minimum for body text) on its target background.
//
// The "white" slot is semantically "primary readable text" — on a dark
// background that's near-white, on a light background it collapses to
// near-black. Renaming it would touch a lot of call sites; the role is
// what matters, not the literal color name.
const PALETTES = {
    dark: {
        gray: "38;5;244",
        dim: "38;5;240",
        red: "38;5;203",
        green: "38;5;114",
        yellow: "38;5;215",
        orange: "38;5;209",
        blue: "38;5;75",
        cyan: "38;5;87",
        magenta: "38;5;176",
        white: "38;5;255",
    },
    light: {
        gray: "38;5;240",
        dim: "38;5;243",
        red: "38;5;124",
        green: "38;5;28",
        yellow: "38;5;130",
        orange: "38;5;166",
        blue: "38;5;26",
        cyan: "38;5;30",
        magenta: "38;5;90",
        white: "38;5;232",
    },
};

const BG_PALETTES = {
    // Subtle panels only — the input box bg should be visibly distinct
    // from the scroll region but not compete with the text. These are
    // two shades off the terminal bg on each theme: dark uses 235
    // (one step lighter than typical terminal black), light uses 254
    // (one step darker than typical #fbfbfa paper).
    dark: { gray: "48;5;235" },
    light: { gray: "48;5;254" },
};

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
        : (s) => `${ESC}${PALETTES[currentTheme][name]}m${s}${ESC}0m`;

const bgPaint = (name) =>
    NO_COLOR
        ? (s) => String(s)
        : (s) => `${ESC}${BG_PALETTES[currentTheme][name]}m${s}${ESC}0m`;

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
          `${ESC}${PALETTES[currentTheme].dim}m` +
          `${String(s).replace(ANSI_SGR_RE, "")}${ESC}0m`;

export const fg = {
    gray: fgPaint("gray"),
    dim: dimPaint,
    bold: boldPaint,
    red: fgPaint("red"),
    green: fgPaint("green"),
    yellow: fgPaint("yellow"),
    orange: fgPaint("orange"),
    blue: fgPaint("blue"),
    cyan: fgPaint("cyan"),
    magenta: fgPaint("magenta"),
    white: fgPaint("white"),
};

export const bg = {
    gray: bgPaint("gray"),
};

// Opening SGR code for a bg color, without the trailing reset. Lets
// callers paint a backgrounded region that embeds other fg colors
// without each inner reset cancelling the bg. The caller is
// responsible for emitting `\x1b[0m` at the end.
export function bgOpen(name) {
    if (NO_COLOR) return "";
    const code = BG_PALETTES[currentTheme][name];
    return code ? `${ESC}${code}m` : "";
}

export const ANSI_RESET = NO_COLOR ? "" : `${ESC}0m`;

export const BULLET = "●";

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
