// ANSI color / terminal helpers.
//
// Colors are disabled when stdout is not a TTY or when NO_COLOR is set,
// following the widely-adopted https://no-color.org convention.

import process from "node:process";

export const isTTY = !!process.stdout.isTTY;
export const NO_COLOR = !!process.env.NO_COLOR || !isTTY;

export const ESC = "\x1b[";

const c = (n) => (NO_COLOR ? (s) => s : (s) => `${ESC}${n}m${s}${ESC}0m`);

export const fg = {
    gray: c("38;5;244"),
    dim: c("2"),
    bold: c("1"),
    red: c("38;5;203"),
    green: c("38;5;114"),
    yellow: c("38;5;215"),
    orange: c("38;5;209"),
    blue: c("38;5;75"),
    cyan: c("38;5;87"),
    magenta: c("38;5;176"),
    white: c("38;5;255"),
};

export const bg = {
    gray: c("48;5;236"),
};

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
