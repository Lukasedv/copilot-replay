// Small string / number / date formatters.

import { homedir } from "node:os";
import { width } from "./io.js";

export function formatRelTime(ms) {
    const d = Math.max(0, Date.now() - ms);
    const s = Math.floor(d / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    return `${days}d ago`;
}

export function formatDateTime(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
}

export function formatSpeed(n) {
    if (n >= 10) return `${Math.round(n)}x`;
    if (Math.abs(n - Math.round(n)) < 0.05) return `${Math.round(n)}x`;
    return `${n.toFixed(1)}x`;
}

export function truncate(s, max) {
    if (typeof s !== "string") s = String(s ?? "");
    if (s.length <= max) return s;
    return s.slice(0, max) + ` …[${s.length - max} chars truncated]`;
}

// Truncate plain text to `max` visible columns, ending with "…" — the
// CLI's "truncate-end" wrap mode for single-line timeline rows.
export function ellipsize(s, max) {
    s = String(s ?? "").replace(/\s*\n\s*/g, " ");
    if (max <= 0) return "";
    if (s.length <= max) return s;
    if (max === 1) return "…";
    return s.slice(0, max - 1).trimEnd() + "…";
}

// "40s", "1m 0s", "2h 3m" — matches the CLI's tool-duration labels.
export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Turn a model id into the display name the CLI footer shows:
//   gpt-6.1-sol → GPT-6.1 Sol, claude-sonnet-5 → Claude Sonnet 5,
//   gemini-4-carbon → Gemini 4 Carbon.
export function prettyModelName(id) {
    const raw = String(id ?? "").trim();
    if (!raw) return "";
    if (/[A-Z ]/.test(raw)) return raw; // already a display name
    const cap = (t) => (/^\d/.test(t) ? t : t[0].toUpperCase() + t.slice(1));
    const parts = raw.split("-").filter(Boolean);
    if (parts[0] === "gpt" && parts.length > 1) {
        return [`GPT-${parts[1]}`, ...parts.slice(2).map(cap)].join(" ");
    }
    if (/^o\d/.test(parts[0])) return [parts[0], ...parts.slice(1).map(cap)].join(" ");
    return parts.map(cap).join(" ");
}

// Display a path the way the CLI timeline does: relative to the session
// cwd when it lives inside it, otherwise home-shortened.
export function displayPath(p, cwd) {
    const s = String(p ?? "");
    if (!s) return "";
    if (cwd) {
        const norm = (x) => x.replace(/\\/g, "/").replace(/\/+$/, "");
        const a = norm(s);
        const b = norm(String(cwd));
        const ci = /^[a-zA-Z]:/.test(b);
        const eq = (x, y) => (ci ? x.toLowerCase() === y.toLowerCase() : x === y);
        if (b && a.length > b.length && eq(a.slice(0, b.length), b) && a[b.length] === "/") {
            const rel = a.slice(b.length + 1);
            return s.includes("\\") ? rel.replace(/\//g, "\\") : rel;
        }
        if (b && eq(a, b)) return ".";
    }
    const home = homedir();
    // Session artifacts (plan.md, files/…) live in the CLI's session
    // folder; the timeline names them relative to that folder.
    const ss = s.replace(/\\/g, "/").match(/\/\.copilot\/session-state\/[^/]+\/(.+)$/);
    if (ss) return ss[1];
    if (home && s.startsWith(home)) return "~" + s.slice(home.length);
    return s;
}

export function shortenPath(p) {
    const home = homedir();
    if (home && typeof p === "string" && p.startsWith(home)) {
        p = "~" + p.slice(home.length);
    }
    return truncate(String(p ?? ""), Math.max(20, width() - 8));
}

// Word-wrap a string to fit within `width() - indent` columns. Preserves
// explicit newlines. Used by the markdown renderer and a few emitters.
export function wrapLines(text, indent = 0) {
    const max = Math.max(20, width() - indent);
    const out = [];
    for (const rawLine of String(text).split("\n")) {
        if (rawLine.length <= max) {
            out.push(rawLine);
            continue;
        }
        let line = rawLine;
        while (line.length > max) {
            let cut = line.lastIndexOf(" ", max);
            if (cut < max * 0.6) cut = max;
            out.push(line.slice(0, cut).trimEnd());
            line = line.slice(cut).trimStart();
        }
        if (line) out.push(line);
    }
    return out;
}
