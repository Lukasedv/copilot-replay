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
