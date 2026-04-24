// Theme detection.
//
// Resolves which color palette (light / dark) to use, in this order:
//
//   1. Explicit override argument (CLI --theme light|dark|auto).
//      "light"/"dark" force; "auto" runs autodetect and ignores env.
//   2. COPILOT_REPLAY_THEME=light|dark env var.
//   3. COLORFGBG env var (set by some terminals as "fg;bg" with a 0-15
//      ANSI color index).
//   4. OSC 11 background color query, with a tight timeout and stdin
//      byte preservation so any keystrokes the user typed during startup
//      are not lost.
//   5. Fallback to "dark" (the historical default).
//
// The OSC 11 query path is the only one that touches the terminal, and
// it bails out unless BOTH stdin and stdout are TTYs.
import process from "node:process";
import { setTheme } from "./ansi.js";

const OSC11_QUERY = "\x1b]11;?\x1b\\";

// Match: ESC ] 11 ; rgb:RRRR/GGGG/BBBB (BEL or ESC \). Hex groups vary
// in width (1-4 nibbles); we only use the high bytes.
const OSC11_REPLY =
    /\x1b\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)(?:\x07|\x1b\\)/;

function themeFromEnvVar(value) {
    if (value === "light" || value === "dark") return value;
    return null;
}

function themeFromColorFgBg(value) {
    if (!value || typeof value !== "string") return null;
    const parts = value.split(";");
    if (parts.length < 2) return null;
    const bg = parseInt(parts[1], 10);
    if (!Number.isFinite(bg)) return null;
    // ANSI 0-7 are normal colors, 8-15 are bright. White-ish backgrounds
    // are 7 ("white") and 15 ("bright white"). 8 is "bright black" (grey),
    // which most users running it pair with a dark theme.
    if (bg === 7 || bg === 15) return "light";
    return "dark";
}

function luminanceFromHex(hex) {
    // Take the high byte of each channel regardless of width (e.g. "ffff"
    // → 0xff, "f0" → 0xf0, "f" → 0xf shifted up).
    const norm = (h) => {
        if (h.length === 1) return parseInt(h + h, 16) / 255;
        return parseInt(h.slice(0, 2), 16) / 255;
    };
    return 0.2126 * norm(hex[0]) + 0.7152 * norm(hex[1]) + 0.0722 * norm(hex[2]);
}

// OSC 11 query. Resolves to "light", "dark", or null on timeout / error.
// Critically: any non-OSC11 bytes that arrive in the listening window are
// unshifted back onto stdin so the picker / player can consume them.
function queryOSC11(timeoutMs) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        if (!stdin.isTTY || !process.stdout.isTTY) {
            resolve(null);
            return;
        }

        const wasRaw = !!stdin.isRaw;
        const wasPaused = stdin.isPaused();
        let buf = Buffer.alloc(0);
        let done = false;
        let timer = null;

        const finish = (theme) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            stdin.removeListener("data", onData);

            // Strip the OSC 11 reply (if any) and unshift the rest so we
            // don't lose user keystrokes typed during the detection window.
            const text = buf.toString("binary");
            const stripped = text.replace(OSC11_REPLY, "");
            if (stripped.length > 0) {
                try {
                    stdin.unshift(Buffer.from(stripped, "binary"));
                } catch {}
            }

            try {
                if (!wasRaw) stdin.setRawMode(false);
            } catch {}
            try {
                if (wasPaused) stdin.pause();
            } catch {}
            resolve(theme);
        };

        const onData = (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            // Bound the buffer so a noisy stdin can't grow it without
            // limit while we wait for the (possibly never-coming) reply.
            if (buf.length > 4096) buf = buf.subarray(buf.length - 4096);
            const m = buf.toString("binary").match(OSC11_REPLY);
            if (m) {
                const l = luminanceFromHex([m[1], m[2], m[3]]);
                finish(l > 0.5 ? "light" : "dark");
            }
        };

        try {
            stdin.setRawMode(true);
        } catch {
            resolve(null);
            return;
        }
        stdin.resume();
        stdin.on("data", onData);

        try {
            process.stdout.write(OSC11_QUERY);
        } catch {
            finish(null);
            return;
        }

        timer = setTimeout(() => finish(null), timeoutMs);
    });
}

export async function detectAndApplyTheme(override) {
    // 1. Explicit CLI flag.
    if (override === "light" || override === "dark") {
        setTheme(override);
        return override;
    }
    const isAuto = override === "auto";

    // 2. Env var (skipped when --theme auto explicitly requested).
    if (!isAuto) {
        const envTheme = themeFromEnvVar(process.env.COPILOT_REPLAY_THEME);
        if (envTheme) {
            setTheme(envTheme);
            return envTheme;
        }
    }

    // Anything below requires a TTY — non-TTY output is colorless anyway.
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
        return "dark";
    }

    // 3. COLORFGBG (also skipped under --theme auto so "auto" really
    //    means "ask the terminal directly").
    if (!isAuto) {
        const cfb = themeFromColorFgBg(process.env.COLORFGBG);
        if (cfb) {
            setTheme(cfb);
            return cfb;
        }
    }

    // 4. OSC 11 query.
    const detected = await queryOSC11(120);
    if (detected) {
        setTheme(detected);
        return detected;
    }

    // 5. Fallback.
    return "dark";
}
