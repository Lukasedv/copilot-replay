// Session discovery and target resolution.
//
// Sessions live under `~/.copilot/session-state/<id>/events.jsonl` with an
// optional sibling `workspace.yaml` carrying `cwd:` and `summary:` hints.
// `listSessions` returns every directory that has an events.jsonl, sorted
// newest-first. `resolveTarget` turns a positional CLI argument into a
// session record, accepting a full id, a prefix, an absolute/relative path
// to an events file, or a path to a session directory.

import {
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { sanitizeDeep, sanitizeString } from "./ansi.js";

export const SESSION_STATE_DIR = join(
    homedir(),
    ".copilot",
    "session-state",
);

export function listSessions() {
    if (!existsSync(SESSION_STATE_DIR)) return [];
    const entries = readdirSync(SESSION_STATE_DIR);
    const out = [];
    for (const name of entries) {
        const dir = join(SESSION_STATE_DIR, name);
        const eventsPath = join(dir, "events.jsonl");
        if (!existsSync(eventsPath)) continue;
        let mtime;
        let cwd = "";
        let summary = "";
        try {
            mtime = statSync(eventsPath).mtimeMs;
        } catch {
            continue;
        }
        const yaml = join(dir, "workspace.yaml");
        if (existsSync(yaml)) {
            try {
                const text = readFileSync(yaml, "utf-8");
                const m1 = /^cwd:\s*(.*)$/m.exec(text);
                if (m1) cwd = sanitizeString(m1[1].trim());
                const m2 = /^summary:\s*(.*)$/m.exec(text);
                if (m2) summary = sanitizeString(m2[1].trim());
            } catch {
                /* ignore — metadata is best-effort */
            }
        }
        out.push({ id: name, dir, eventsPath, mtime, cwd, summary });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
}

export function loadEvents(path) {
    const raw = readFileSync(path, "utf-8");
    const out = [];
    for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
            // Sanitize every string field before any downstream renderer
            // can write it to the terminal. See ansi.js sanitizeString for
            // the rationale (OSC 52 clipboard hijacks, cursor games, etc.).
            out.push(sanitizeDeep(JSON.parse(line)));
        } catch {
            /* skip malformed lines */
        }
    }
    return out;
}

export function resolveTarget(positional, { die }) {
    if (positional.length === 0) return null;
    const arg = positional[0];
    const asPath = resolve(arg);
    if (existsSync(asPath)) {
        const st = statSync(asPath);
        if (st.isFile()) {
            return {
                id: basename(asPath),
                dir: join(asPath, ".."),
                eventsPath: asPath,
                mtime: st.mtimeMs,
                cwd: "",
                summary: "",
            };
        }
        if (st.isDirectory()) {
            const p = join(asPath, "events.jsonl");
            if (existsSync(p)) {
                return {
                    id: basename(asPath),
                    dir: asPath,
                    eventsPath: p,
                    mtime: statSync(p).mtimeMs,
                    cwd: "",
                    summary: "",
                };
            }
        }
    }
    // Treat as a session id (possibly partial prefix).
    const list = listSessions();
    const exact = list.find((s) => s.id === arg);
    if (exact) return exact;
    const prefix = list.filter((s) => s.id.startsWith(arg));
    if (prefix.length === 1) return prefix[0];
    if (prefix.length > 1) {
        die(
            `Ambiguous session id "${arg}" (${prefix.length} matches). ` +
                `Try --list.`,
        );
    }
    die(`No session matching "${arg}". Try --list.`);
}
