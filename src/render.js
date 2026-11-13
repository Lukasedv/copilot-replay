// Per-event rendering helpers.
//
// `describeEvent(ev, opts, ctx)` returns a zero-arg (or one-arg, taking
// `player`) async function that renders the event when called, or null
// when the event produces no visible output. This lets the player decide
// whether to run it normally (with animation) or as a fast-forward.
//
// The look follows today's Copilot CLI "compact timeline" (1.0.100+):
// every entry is a single row
//
//     ● Read notes.txt 3 lines read
//     $ Shell List files in the current folder 6 lines…
//       Get-ChildItem -File
//     JS Edit app.js +6 -1
//
// with an icon (or a two-letter file-type badge), a bold title, a
// secondary-colored description and metadata, optional right-aligned
// duration, and optional `│` / `└` child rows.

import { ICON, fg, stripAnsi } from "./ansi.js";
import { rawWrite, width, writeln } from "./io.js";
import { layout, modeLabel, paintBg } from "./layout.js";
import {
    displayPath,
    ellipsize,
    formatDateTime,
    formatDuration,
    prettyModelName,
    shortenPath,
    truncate,
    wrapLines,
} from "./format.js";
import { renderMarkdownLines } from "./markdown.js";
import { renderCliBannerLines } from "./banner.js";
import {
    animateThinking,
    streamLines,
    typeColoredLine,
    typeUserPrompt,
} from "./anim.js";

// ── Row primitives ───────────────────────────────────────────────────────

const VARIANTS = {
    success: { icon: ICON.filled, color: () => fg.green },
    error: { icon: ICON.cross, color: () => fg.red },
    warning: { icon: ICON.warning, color: () => fg.yellow },
    info: { icon: ICON.filled, color: () => fg.blue },
    muted: { icon: ICON.empty, color: () => fg.dim },
    loading: { icon: ICON.empty, color: () => fg.gray },
    search: { icon: ICON.search, color: () => fg.dim },
    shell: { icon: ICON.shell, color: () => fg.modeShell },
    task: { icon: ICON.task, color: () => fg.green },
    plain: { icon: ICON.filled, color: () => fg.white },
};

// File-type badges the CLI shows in place of the ● icon on Read / Edit /
// Create rows (1.0.107+).
const BADGES = {
    ts: ["TS", "blue"], mts: ["TS", "blue"], cts: ["TS", "blue"],
    tsx: ["TX", "blue"],
    js: ["JS", "yellow"], mjs: ["JS", "yellow"], cjs: ["JS", "yellow"],
    jsx: ["JX", "yellow"],
    json: ["{}", "green"],
    md: ["MD", "gray"], mdx: ["MX", "gray"],
    rs: ["RS", "red"], py: ["PY", "cyan"], go: ["GO", "cyan"],
    rb: ["RB", "red"], java: ["JV", "red"],
    c: ["C", "cyan"], h: ["H", "cyan"], cpp: ["C+", "cyan"], cc: ["C+", "cyan"],
    cs: ["C#", "green"],
    sh: ["SH", "gray"], bash: ["SH", "gray"],
    yaml: ["YM", "gray"], yml: ["YM", "gray"], toml: ["TM", "gray"],
    html: ["HT", "yellow"], css: ["SS", "cyan"], scss: ["SS", "cyan"],
    sql: ["SQ", "green"],
};

export function fileBadge(path) {
    const base = baseFromPath(path);
    const dot = base.lastIndexOf(".");
    if (dot <= 0 || dot === base.length - 1) return null;
    const hit = BADGES[base.slice(dot + 1).toLowerCase()];
    return hit ? { label: hit[0], color: hit[1] } : null;
}

// Build one timeline row. `meta` may contain ANSI (pre-colored); `desc`
// is plain text and is the part that gets ellipsized to fit.
export function row({
    variant = "success",
    badge = null,
    title = "",
    desc = "",
    meta = "",
    right = "",
    titleColor = null,
}) {
    const W = width();
    const v = VARIANTS[variant] || VARIANTS.success;
    let lead;
    if (badge && variant !== "error") {
        const paint = fg[badge.color] || fg.gray;
        lead = fg.bold(paint(badge.label.slice(0, 2).padEnd(2, " ")));
    } else {
        lead = v.color()(v.icon);
    }
    const titleStr = title ? fg.bold(titleColor ? titleColor(title) : fg.white(title)) : "";
    const metaPlain = stripAnsi(meta);
    const used =
        1 + stripAnsi(lead).length + 1 +
        (title ? title.length + 1 : 0) +
        (metaPlain ? metaPlain.length + 1 : 0) +
        (right ? right.length + 2 : 0) + 1;
    const room = Math.max(8, W - used);
    const d = desc ? ellipsize(desc, room) : "";
    let line = ` ${lead} ${titleStr}`;
    if (d) line += `${title ? " " : ""}${fg.gray(d)}`;
    if (metaPlain) line += ` ${meta}`;
    if (right) {
        const gap = Math.max(2, W - 1 - stripAnsi(line).length - right.length);
        line += " ".repeat(gap) + fg.gray(right);
    }
    return line;
}

// Child rows under an entry: "│ a", "│ b", "└ c".
function childRows(items, color = fg.gray) {
    const out = [];
    const W = width();
    items.forEach((t, i) => {
        const last = i === items.length - 1;
        const glyph = last ? ICON.childLast : ICON.childMid;
        out.push(`   ${fg.gray(glyph)} ${color(ellipsize(t, Math.max(10, W - 6)))}`);
    });
    return out;
}

// "└ " followed by wrapped text, continuation lines indented under it.
function childParagraph(text, renderLine = (s) => fg.gray(s)) {
    const lines = wrapLines(String(text).trim(), 6);
    return lines.map((l, i) =>
        i === 0 ? `   ${fg.gray(ICON.childLast)} ${renderLine(l)}` : `     ${renderLine(l)}`,
    );
}

function emitLines(lines) {
    for (const l of lines) writeln(l);
}

function emitDotLineIcon(color, icon, text, bodyColor = fg.gray) {
    const lines = wrapLines(text, 4);
    writeln(` ${color(icon)} ${bodyColor(lines[0] ?? "")}`);
    for (let i = 1; i < lines.length; i++) writeln(`   ${bodyColor(lines[i])}`);
}

export function emitInfo(text) {
    emitDotLineIcon(fg.blue, ICON.filled, text);
}

export function emitModeChange(prev, next) {
    emitInfo(`Mode changed from ${modeLabel(prev)} to ${modeLabel(next)}`);
}

export function emitModelChange(prev, next) {
    emitInfo(
        prev
            ? `Model changed from ${prettyModelName(prev)} to ${prettyModelName(next)}`
            : `Model set to ${prettyModelName(next)}`,
    );
}

export async function emitSessionStart(ev, ctx, player) {
    const d = ev.data || {};
    const when = formatDateTime(ev.timestamp);
    const model = ctx?.firstModel || d?.selectedModel || d?.model || "unknown";
    const sid =
        (ctx?.sessionId || d?.sessionId || "").slice(0, 8) || "session";
    for (const l of renderCliBannerLines(d.copilotVersion)) writeln(l);
    writeln("");
    const line =
        ` ${fg.brand(ICON.filled)} ${fg.gray("Replaying session ")}` +
        `${fg.bold(fg.white(sid))}` +
        (when ? `${fg.gray(" from ")}${fg.white(when)}` : "") +
        `${fg.gray(" · ")}${fg.white(prettyModelName(model))}`;
    await typeColoredLine(player, line, { perCharMs: 8 });
}

// ── Helpers ──────────────────────────────────────────────────────────────

function baseFromPath(p) {
    if (!p) return "";
    const s = String(p);
    const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return idx >= 0 ? s.slice(idx + 1) : s;
}

// Count logical lines in a string, ignoring a single trailing newline.
function countLines(text) {
    if (!text) return 0;
    const t = String(text).replace(/\r\n/g, "\n").replace(/\n$/, "");
    return t === "" ? 0 : t.split("\n").length;
}

function plural(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
}

// Parse a unified diff to get accurate +added/-removed.
function parseDiffStats(diffText) {
    if (!diffText) return null;
    let added = 0;
    let removed = 0;
    for (const line of String(diffText).split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    return added || removed ? { added, removed } : null;
}

// Split a multi-file diff into { path → stats }.
function parseMultiDiff(diffText) {
    const out = [];
    let cur = null;
    for (const line of String(diffText || "").split("\n")) {
        const m = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
        if (m) {
            cur = { path: m[2], added: 0, removed: 0 };
            out.push(cur);
            continue;
        }
        if (!cur) continue;
        if (line.startsWith("+") && !line.startsWith("+++")) cur.added++;
        else if (line.startsWith("-") && !line.startsWith("---")) cur.removed++;
    }
    return out;
}

function resultText(data) {
    const res = data?.result;
    if (typeof res === "string") return res;
    if (res && typeof res === "object") {
        return String(res.content ?? res.textResultForLlm ?? res.detailedContent ?? "");
    }
    return "";
}

function errorText(data) {
    const e = data?.error;
    if (!e) return resultText(data) || "failed";
    if (typeof e === "string") return e;
    return String(e.message ?? e.code ?? JSON.stringify(e));
}

// Shell output without the trailing "<shellId: …>" / "<exited with …>"
// metadata line the CLI appends for the model (1.0.100 hides it too).
function shellOutput(text) {
    return String(text || "")
        .replace(/\r\n/g, "\n")
        .replace(/\n?<(shellId|exited|command)[^>\n]*>\s*$/i, "")
        .replace(/\n+$/, "");
}

function shellExitCode(data) {
    const c = data?.shellExecution?.exitCode;
    if (Number.isInteger(c)) return c;
    const m = resultText(data).match(/exit(?:ed with)? code (-?\d+)/i);
    return m ? Number(m[1]) : null;
}

function durationBetween(a, b) {
    const ta = Date.parse(a?.timestamp);
    const tb = Date.parse(b?.timestamp);
    if (!Number.isFinite(ta) || !Number.isFinite(tb) || tb < ta) return "";
    return formatDuration(tb - ta);
}

function humanizeToolName(name) {
    const s = String(name || "tool").replace(/[_-]+/g, " ").trim();
    return s ? s[0].toUpperCase() + s.slice(1) : "Tool";
}

// Internal tools hidden from replay output — plumbing the audience
// doesn't need to see (the CLI hides these from its timeline too).
const HIDDEN_TOOLS = new Set([
    "report_intent",
    "stop_bash",
    "stop_powershell",
    "list_bash",
    "list_powershell",
    "update_todo",
]);

const SHELL_TOOLS = new Set(["bash", "shell", "powershell"]);
const SHELL_IO_TOOLS = new Set([
    "read_bash",
    "write_bash",
    "read_powershell",
    "write_powershell",
]);

// Every built-in tool name we know how to render; anything else with a
// dash is treated as an MCP / plugin tool.
const KNOWN_TOOL_NAMES = new Set([
    ...SHELL_TOOLS, ...SHELL_IO_TOOLS, ...HIDDEN_TOOLS,
    "edit", "create", "view", "show_file", "apply_patch", "grep", "glob", "rg",
    "web_fetch", "web_search", "ask_user", "sql", "task", "read_agent",
    "write_agent", "list_agents", "task_complete", "exit_plan_mode", "skill",
    "think", "store_memory",
]);

export function isMcpTool(name, data) {
    if (data?.mcpServerName) return true;
    if (!name || typeof name !== "string") return false;
    if (KNOWN_TOOL_NAMES.has(name)) return false;
    return name.includes("-");
}

function mcpToolSummary(args) {
    if (!args || typeof args !== "object") return "";
    for (const key of ["question", "query", "prompt", "message", "input", "text", "description", "name", "path", "url"]) {
        if (typeof args[key] === "string" && args[key].trim()) {
            return args[key].trim();
        }
    }
    return "";
}

// Short one-liner summary of a tool call's primary argument.
export function summarizeToolArgs(toolName, args) {
    if (!args || typeof args !== "object") return typeof args === "string" ? args : "";
    const a = args;
    const tryPath = (v) => (v ? shortenPath(String(v)) : "");
    switch (toolName) {
        case "edit":
        case "create":
        case "view":
        case "show_file":
            return tryPath(a.path);
        case "bash":
        case "shell":
        case "powershell":
            return truncate(String(a.command ?? ""), 160);
        case "grep":
        case "rg":
            return [a.pattern && `"${a.pattern}"`, a.path && tryPath(a.path)]
                .filter(Boolean)
                .join(" in ");
        case "glob":
            return String(a.pattern ?? "");
        case "web_fetch":
            return String(a.url ?? "");
        case "web_search":
            return String(a.query ?? "");
        case "report_intent":
            return String(a.intent ?? "");
        case "ask_user":
            return String(a.question ?? a.message ?? "");
        case "sql":
            return String(a.description ?? a.query ?? "");
        case "write_bash":
        case "write_powershell":
            return String(a.input ?? "");
        case "task":
            return String(a.description ?? a.name ?? "");
        default:
            return mcpToolSummary(a);
    }
}

// Human title fallback when no specialized renderer applies.
export function defaultToolTitle(name, args) {
    const a = args && typeof args === "object" ? args : {};
    switch (name) {
        case "view":
        case "show_file":
            return "Read";
        case "edit":
        case "apply_patch":
            return "Edit";
        case "create":
            return "Create";
        case "bash":
        case "shell":
        case "powershell":
        case "read_bash":
        case "write_bash":
        case "read_powershell":
        case "write_powershell":
            return "Shell";
        case "grep":
        case "rg":
        case "glob":
            return "Search";
        case "web_fetch":
            return "Fetch";
        case "web_search":
            return "Web search";
        case "ask_user":
            return "Asked user";
        case "sql":
            return "SQL";
        case "task":
            return a.agent_type ? humanizeToolName(a.agent_type) : "Task";
        case "task_complete":
            return "Task complete";
        case "exit_plan_mode":
            return "Plan ready for review";
        case "think":
            return "Think about next steps";
        default:
            return humanizeToolName(name);
    }
}

// ── Specialized tool renderers ───────────────────────────────────────────

function failedRow(title, desc, data, extra = {}) {
    const err = errorText(data).replace(/\r\n/g, "\n").trim();
    const lines = err.split("\n").filter((l) => l.trim()).slice(0, 3);
    return [
        row({ variant: "error", title, desc, ...extra }),
        ...childRows(lines.length ? lines : ["failed"], fg.red),
    ];
}

function renderView(args, data, ctx) {
    const p = displayPath(args?.path, ctx?.cwd);
    if (data?.success === false) return failedRow("Read", p, data);
    const text = resultText(data);
    let meta = "";
    if (/^File too large to read at once/i.test(text)) meta = "file too large";
    else if (text) meta = `${plural(countLines(text), "line")} read`;
    return [row({ badge: fileBadge(args?.path), title: "Read", desc: p, meta: fg.gray(meta) })];
}

function diffMeta(stats) {
    if (!stats) return "";
    const parts = [];
    if (stats.added || !stats.removed) parts.push(fg.green(`+${stats.added || 0}`));
    if (stats.removed) parts.push(fg.red(`-${stats.removed}`));
    return parts.join(" ");
}

function renderEdit(args, data, ctx) {
    const p = displayPath(args?.path, ctx?.cwd);
    if (data?.success === false) return failedRow("Edit", p, data);
    let stats = parseDiffStats(data?.result?.detailedContent);
    if (!stats) {
        const oldLines = countLines(String(args?.old_str ?? ""));
        const newLines = countLines(String(args?.new_str ?? ""));
        if (oldLines || newLines) stats = { added: newLines, removed: oldLines };
    }
    return [row({ badge: fileBadge(args?.path), title: "Edit", desc: p, meta: diffMeta(stats) })];
}

function renderCreate(args, data, ctx) {
    const p = displayPath(args?.path, ctx?.cwd);
    if (data?.success === false) return failedRow("Create", p, data);
    const n = countLines(String(args?.file_text ?? ""));
    return [row({ badge: fileBadge(args?.path), title: "Create", desc: p, meta: fg.green(`+${n}`) })];
}

// apply_patch: one row per touched file, with per-file +/- counts taken
// from the result's combined diff (CLI 1.0.107 patch summaries).
function renderApplyPatch(args, data, ctx) {
    const patch = typeof args === "string" ? args : String(args?.input ?? args?.patch ?? "");
    const files = [];
    for (const line of patch.split("\n")) {
        const m = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+?)\s*$/);
        if (m) files.push({ op: m[1], path: m[2] });
    }
    if (data?.success === false) {
        return failedRow("Edit", files.map((f) => displayPath(f.path, ctx?.cwd)).join(", "), data);
    }
    const diffs = parseMultiDiff(data?.result?.detailedContent);
    if (files.length === 0) {
        const total = parseDiffStats(data?.result?.detailedContent);
        return [row({ title: "Edit", desc: ellipsize(resultText(data), 120), meta: diffMeta(total) })];
    }
    const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase();
    return files.map((f) => {
        const d = diffs.find((x) => norm(x.path).endsWith(norm(f.path)) || norm(f.path).endsWith(norm(x.path)));
        const title = f.op === "Add" ? "Create" : f.op === "Delete" ? "Delete" : "Edit";
        const meta = f.op === "Delete"
            ? fg.red(`-${d?.removed ?? 0}`)
            : diffMeta(d ? { added: d.added, removed: d.removed } : null);
        return row({ badge: fileBadge(f.path), title, desc: displayPath(f.path, ctx?.cwd), meta });
    });
}

function renderShell(name, args, data) {
    const command = String(args?.command ?? "").trim();
    const description = String(args?.description ?? "").trim();
    const desc = description || command;
    const out = shellOutput(resultText(data));
    const code = shellExitCode(data);
    const failed = data?.success === false || (code != null && code !== 0);
    const metaParts = [];
    if (data && out) metaParts.push(fg.gray(`${plural(countLines(out), "line")}…`));
    if (failed) metaParts.push(fg.red(code != null ? `exit ${code}` : "failed"));
    const lines = [
        row({
            variant: failed ? "error" : "shell",
            title: "Shell",
            desc,
            meta: metaParts.join(" "),
        }),
    ];
    if (description && command) {
        lines.push(`   ${fg.dim(ellipsize(command, Math.max(10, width() - 4)))}`);
    }
    if (data?.success === false && !out) {
        lines.push(...childRows([errorText(data).split("\n")[0]], fg.red));
    }
    return lines;
}

function renderShellIO(name, args, data) {
    const out = shellOutput(resultText(data));
    const isWrite = name.startsWith("write_");
    const desc = isWrite
        ? `Send input ${String(args?.input ?? "").replace(/\n/g, "⏎")}`
        : "Read output";
    return [
        row({
            variant: data?.success === false ? "error" : "shell",
            title: "Shell",
            desc,
            meta: out ? fg.gray(`${plural(countLines(out), "line")}…`) : "",
        }),
    ];
}

function renderSearch(name, args, data, ctx) {
    const pattern = String(args?.pattern ?? args?.query ?? "");
    const where = args?.path || args?.paths;
    let desc = name === "glob" ? pattern : pattern ? `"${pattern}"` : "";
    if (where) {
        const w = Array.isArray(where) ? where.join(", ") : String(where);
        desc += ` in ${displayPath(w, ctx?.cwd)}`;
    }
    if (data?.success === false) return failedRow("Search", desc, data, { variant: "error" });
    const text = resultText(data).trim();
    let meta = "";
    if (text && !/^No (matches|files) found/i.test(text)) {
        const n = text.split("\n").filter((l) => l.trim() && !/^\[glob:/.test(l)).length;
        const mode = args?.output_mode;
        meta =
            name === "glob" || mode === "files_with_matches" || mode === "count" || !mode
                ? plural(n, "file")
                : plural(n, "line");
    } else if (data) {
        meta = "no matches";
    }
    return [row({ variant: "search", title: "Search", desc, meta: fg.gray(meta) })];
}

// SQL against the session todo table renders as the CLI's "Todo" entries.
function parseSqlTodos(query) {
    const q = String(query || "");
    const ins = q.match(/insert\s+(?:or\s+\w+\s+)?into\s+["`[]?todo(s|_deps)["`\]]?\s*(\([^)]*\))?\s*values\s*([\s\S]*)/i);
    if (ins) {
        const isDeps = ins[1].toLowerCase() === "_deps";
        const tuples = [...ins[3].matchAll(/\(\s*'((?:''|[^'])*)'\s*(?:,\s*'((?:''|[^'])*)')?/g)];
        const items = tuples.map((t) => (isDeps ? `${t[1]} → ${t[2] ?? ""}` : (t[2] ?? t[1])).replace(/''/g, "'"));
        return { kind: isDeps ? "dependency added" : "add", items };
    }
    const upd = q.match(/update\s+["`[]?todos["`\]]?\s+set\s+[\s\S]*?status\s*=\s*'(\w+)'([\s\S]*)/i);
    if (upd) {
        const status = upd[1].toLowerCase();
        const ids = [...upd[2].matchAll(/'((?:''|[^'])*)'/g)].map((m) => m[1].replace(/''/g, "'"));
        const kind = status === "done" ? "done" : status === "in_progress" ? "start" : status === "blocked" ? "blocked" : null;
        if (kind) return { kind, items: ids };
    }
    return null;
}

const TODO_TITLES = {
    add: "Todo added",
    start: "Todo started",
    done: "Todo completed",
    blocked: "Todo blocked",
    "dependency added": "Todo dependency",
};

function renderSql(args, data) {
    if (data?.success === false) {
        return failedRow("SQL", String(args?.description ?? args?.query ?? ""), data);
    }
    const todo = parseSqlTodos(args?.query);
    if (todo && todo.items.length) {
        return [
            row({
                variant: todo.kind === "done" ? "task" : "success",
                title: TODO_TITLES[todo.kind],
                meta: fg.gray(plural(todo.items.length, "item")),
            }),
            ...childRows(todo.items),
        ];
    }
    return [
        row({
            title: "SQL",
            desc: String(args?.description || args?.query || "Query executed"),
        }),
    ];
}

function renderTaskComplete(args, data) {
    const summary =
        String(args?.summary ?? "").trim() || resultText(data).trim();
    const lines = [row({ title: "Task complete" })];
    if (summary) {
        const md = [...renderMarkdownLines(summary, 6)];
        md.forEach((l, i) => {
            lines.push(i === 0 ? `   ${fg.gray(ICON.childLast)} ${l}` : `     ${l}`);
        });
    }
    return lines;
}

function renderTask(d, data, ctx) {
    const args = d.arguments || {};
    const sub = ctx?.subagents?.get(d.toolCallId) || {};
    const title =
        sub.started?.agentDisplayName ||
        (args.agent_type ? humanizeToolName(args.agent_type) : "Task");
    const desc = String(args.description ?? args.name ?? "");
    const calls = sub.completed?.totalToolCalls;
    const ms = sub.completed?.durationMs;
    if (data?.success === false) return failedRow(title, desc, data);
    return [
        row({
            title,
            desc,
            meta: Number.isFinite(calls) ? fg.gray(plural(calls, "tool call")) : "",
            right: Number.isFinite(ms) ? formatDuration(ms) : "",
        }),
    ];
}

function renderSkill(args, data) {
    const name = String(args?.skill ?? args?.name ?? "");
    const title = name ? `skill(${name})` : "skill";
    if (data?.success === false) return failedRow(title, "", data);
    return [row({ title })];
}

function renderMcp(name, d, data) {
    const server = d.mcpServerName;
    const tool = d.mcpToolName;
    const title = server && tool ? `${server}/${tool}` : name;
    const desc = mcpToolSummary(d.arguments);
    if (data?.success === false) return failedRow(title, desc, data);
    return [row({ title, desc })];
}

function renderGeneric(name, args, data) {
    const title = defaultToolTitle(name, args);
    const desc = summarizeToolArgs(name, args);
    if (data?.success === false) return failedRow(title, desc, data);
    return [row({ title, desc })];
}

// ── ask_user ─────────────────────────────────────────────────────────────

// Fixed, human pace for "the user is answering" animations — like typed
// prompts, these are not scaled by --speed so the audience can follow.
const HUMAN_STEP_MS = 260;
const HUMAN_CHAR_MS = 28;
const HUMAN_READ_MS = 900;

function extractAskUserFields(args) {
    const props = args?.requestedSchema?.properties;
    if (props && typeof props === "object") {
        const out = [];
        for (const key of Object.keys(props)) {
            const p = props[key] || {};
            const options = [];
            if (Array.isArray(p.oneOf)) {
                for (const o of p.oneOf) {
                    if (o && typeof o === "object") {
                        options.push({ const: String(o.const ?? ""), label: String(o.title ?? o.const ?? "") });
                    }
                }
            } else if (Array.isArray(p.enum)) {
                const names = Array.isArray(p.enumNames) ? p.enumNames : null;
                p.enum.forEach((e, i) => options.push({ const: String(e), label: String(names?.[i] ?? e) }));
            } else if (p.type === "boolean") {
                options.push({ const: "true", label: "Yes" }, { const: "false", label: "No" });
            }
            out.push({
                key,
                title: String(p.title || key),
                isFreeText: options.length === 0,
                options,
                defaultValue: p.default != null ? String(p.default) : "",
            });
        }
        if (out.length) return out;
    }
    if (Array.isArray(args?.choices) && args.choices.length) {
        return [{
            key: "",
            title: "",
            isFreeText: false,
            options: args.choices.map((c) => ({ const: String(c), label: String(c) })),
            defaultValue: "",
        }];
    }
    return [{ key: "", title: "", isFreeText: true, options: [], defaultValue: "" }];
}

// Work out what the user answered, per field. Prefers the structured
// `human_response.recorded` event (CLI 1.0.106+); falls back to parsing
// the tool result text that older recordings carry.
function resolveAskUserAnswer(fields, resultData, human) {
    const res = resultData?.result;
    const content = String(res?.content ?? "").trim();
    const detailed = String(res?.detailedContent ?? "").trim();
    if (/^User (declined|did not)/i.test(content)) return { kind: "declined" };
    if (/^User can(celled|celed)\b/i.test(content)) return { kind: "cancelled" };
    const values = new Map();
    const hc = human?.response?.content;
    if (hc && typeof hc === "object") {
        for (const [k, v] of Object.entries(hc)) values.set(k, String(v));
    } else if (typeof hc === "string" && fields.length === 1) {
        values.set(fields[0].key, hc);
    }
    if (!values.size) {
        const sel = content.match(/^User selected:\s*([\s\S]+)$/);
        if (sel && fields.length === 1) values.set(fields[0].key, sel[1].trim());
    }
    if (!values.size && /^User responded:?\s*\n/i.test(detailed)) {
        const body = detailed.replace(/^User responded:?\s*\n/i, "");
        for (const ln of body.split("\n")) {
            const m = ln.match(/^\s*([^:]+):\s*(.*)$/);
            if (!m) continue;
            const f = fields.find((x) => x.title === m[1].trim() || x.key === m[1].trim());
            if (f) values.set(f.key, m[2].trim());
        }
    }
    if (!values.size) {
        const resp = content.match(/^User responded:\s*([\s\S]+)$/i);
        const body = (resp ? resp[1] : content).trim();
        if (body && fields.length === 1) values.set(fields[0].key, body);
        else if (body && /=/.test(body)) {
            for (const part of body.split(/,\s*/)) {
                const m = part.match(/^([\w.-]+)\s*=\s*(.+)$/);
                if (m) values.set(m[1], m[2].trim());
            }
        }
    }
    if (!values.size) return content || detailed ? { kind: "text", text: content || detailed } : null;
    return { kind: "values", values };
}

function dialogRule() {
    return fg.border("─".repeat(layout.footerWidth()));
}

function questionLines(question, reserved = 12) {
    const room = Math.max(4, (layout.rows || 24) - reserved - 4);
    const lines = [...renderMarkdownLines(question, 2)];
    const shown = lines.slice(0, room);
    if (lines.length > room) shown[room - 1] = fg.gray("…");
    return shown.map((l) => ` ${fg.white(l)}`);
}

function askDialog(question, field, cursor, typed, hints) {
    const out = [dialogRule(), ` ${fg.bold(fg.white("Copilot needs information."))}`];
    out.push(...questionLines(question, field.isFreeText ? 10 : 8 + field.options.length));
    out.push("");
    if (field.isFreeText) {
        const W = layout.footerWidth();
        if (field.title) out.push(` ${fg.white(field.title)}`);
        out.push(` ${fg.panel("▄".repeat(W - 2))}`);
        const body = `  ${fg.brand(ICON.chevron)} ${fg.white(typed)}${fg.brand("█")}`;
        const pad = Math.max(0, W - 2 - stripAnsi(body).length);
        out.push(` ${paintBg(body + " ".repeat(pad))}`);
        out.push(` ${fg.panel("▀".repeat(W - 2))}`);
        out.push("");
        out.push(` ${fg.gray(hints || "enter accept · ctrl+d decline · esc clear")}`);
    } else {
        if (field.title) out.push(` ${fg.white(field.title)}:`);
        const opts = [...field.options.map((o) => o.label), "Other (type your answer)"];
        opts.forEach((label, i) => {
            const isCur = i === cursor;
            const text = i === opts.length - 1 && typed ? typed : label;
            out.push(
                isCur
                    ? ` ${fg.brand(ICON.chevron)} ${fg.bold(fg.brand(text))}`
                    : `   ${fg.white(text)}`,
            );
        });
        out.push("");
        out.push(` ${fg.gray("↑/↓ select · enter accept · ctrl+d decline · esc cancel")}`);
    }
    out.push(dialogRule());
    return out;
}

function waitingRow(title, desc) {
    return row({ variant: "loading", title, desc });
}

// While a dialog is open, the CLI shows a pending "○ …" row at the
// bottom of the timeline. Draw it in place (no newline) so it can be
// replaced by the final row when the dialog closes.
function drawPending(line) {
    if (!layout.active) return;
    rawWrite(`\x1b[${layout.nextRow};1H\x1b[2K${line}`);
}

function clearPending() {
    if (!layout.active) return;
    rawWrite(`\x1b[${layout.nextRow};1H\x1b[2K`);
}

async function animateAskUser(player, question, fields, answer) {
    if (!layout.active || player.fastForwarding) return;
    const values = answer?.kind === "values" ? answer.values : new Map();
    for (const f of fields) {
        if (player.quitRequested) break;
        const val = values.get(f.key) ?? (fields.length === 1 && answer?.kind === "text" ? answer.text : undefined);
        if (f.isFreeText) {
            layout.setDialog(askDialog(question, f, 0, "", null));
            drawPending(waitingRow("Asking user", "Waiting for response"));
            await player.sleep(HUMAN_READ_MS);
            let typed = "";
            for (const ch of String(val ?? "").slice(0, 200)) {
                if (player.quitRequested || player.fastForwarding) break;
                typed += ch;
                layout.setDialog(askDialog(question, f, 0, typed, null));
                await player.sleep(HUMAN_CHAR_MS);
            }
            await player.sleep(HUMAN_STEP_MS * 2);
        } else {
            let target = f.options.findIndex((o) => o.const === val || o.label === val);
            const isOther = val != null && target < 0;
            if (isOther) target = f.options.length;
            if (target < 0) target = 0;
            layout.setDialog(askDialog(question, f, 0, "", null));
            drawPending(waitingRow("Asking user", "Waiting for response"));
            await player.sleep(HUMAN_READ_MS);
            for (let c = 1; c <= target; c++) {
                if (player.quitRequested || player.fastForwarding) break;
                layout.setDialog(askDialog(question, f, c, "", null));
                await player.sleep(HUMAN_STEP_MS);
            }
            if (isOther) {
                let typed = "";
                for (const ch of String(val).slice(0, 200)) {
                    if (player.quitRequested || player.fastForwarding) break;
                    typed += ch;
                    layout.setDialog(askDialog(question, f, target, typed, null));
                    await player.sleep(HUMAN_CHAR_MS);
                }
            }
            await player.sleep(HUMAN_STEP_MS * 2);
        }
    }
    clearPending();
    layout.setDialog(null);
}

async function emitAskUser(startEv, resultEv, human, player) {
    const d = startEv.data || {};
    const args = d.arguments || {};
    const question = String(args.question ?? args.message ?? "").trim();
    const fields = extractAskUserFields(args);
    const answer = resolveAskUserAnswer(fields, resultEv?.data, human);

    await animateAskUser(player, question, fields, answer);
    if (player.quitRequested) return;

    const right = durationBetween(startEv, resultEv);
    const lines = [row({ title: "Asked user", desc: question.split("\n")[0], right })];
    if (answer?.kind === "declined") {
        lines.push(...childRows(["User declined"]));
    } else if (answer?.kind === "cancelled") {
        lines.push(...childRows(["User cancelled"]));
    } else if (answer?.kind === "values") {
        const items = [];
        for (const f of fields) {
            const v = answer.values.get(f.key);
            if (v == null) continue;
            const label = f.options.find((o) => o.const === v)?.label ?? v;
            items.push(f.title ? `${f.title}: ${label}` : label);
        }
        lines.push(...childRows(items.length ? items : ["(no answer)"]));
    } else if (answer?.kind === "text") {
        lines.push(...childRows([answer.text.split("\n")[0]]));
    }
    emitLines(lines);
}

// ── exit_plan_mode ───────────────────────────────────────────────────────

function planDialog(summary, cursor) {
    const W = Math.max(30, layout.footerWidth());
    const inner = W - 4;
    const box = (s = "") => {
        const pad = Math.max(0, inner - stripAnsi(s).length);
        return `${fg.border("│")} ${s}${" ".repeat(pad)} ${fg.border("│")}`;
    };
    const out = [fg.border(`╭${"─".repeat(W - 2)}╮`)];
    out.push(box(fg.bold(fg.white("Plan Ready for Review"))));
    out.push(box(fg.border("─".repeat(inner))));
    for (const l of [...renderMarkdownLines(summary || "", 6)].slice(0, 10)) {
        out.push(box(` ${l}`));
    }
    out.push(box());
    const opts = [
        "Accept plan and continue in Autopilot execution mode (recommended)",
        "Accept plan and continue in Interactive execution mode",
        "Exit to Interactive execution mode without running the plan",
        "Suggest changes",
    ];
    opts.forEach((o, i) => {
        const text = ellipsize(`${i + 1}. ${o}`, inner - 2);
        out.push(
            box(i === cursor ? `${fg.brand(ICON.chevron)} ${fg.bold(fg.brand(text))}` : `  ${fg.white(text)}`),
        );
    });
    out.push(box());
    out.push(box(fg.gray(ellipsize("↑/↓ to navigate · enter to select · ctrl+e to show full plan · esc to cancel", inner))));
    out.push(fg.border(`╰${"─".repeat(W - 2)}╯`));
    return out;
}

function planChoice(outcome, resultData) {
    const content = resultText(resultData);
    const approved = /^Plan approved/i.test(content) || outcome?.approved === true;
    if (approved) return outcome?.newMode === "autopilot" ? 0 : 1;
    if (outcome?.feedback || /feedback|suggest/i.test(content)) return 3;
    return 2;
}

async function emitExitPlanMode(startEv, resultEv, outcome, player) {
    const args = startEv.data?.arguments || {};
    const summary = String(args.summary ?? args.plan ?? "").trim();
    const choice = planChoice(outcome, resultEv?.data);
    if (layout.active && !player.fastForwarding && resultEv) {
        layout.setDialog(planDialog(summary, 0));
        drawPending(waitingRow("Plan ready for review", ellipsize(summary.split("\n")[0], 60)));
        await player.sleep(HUMAN_READ_MS * 2);
        for (let c = 1; c <= choice; c++) {
            if (player.quitRequested || player.fastForwarding) break;
            layout.setDialog(planDialog(summary, c));
            await player.sleep(HUMAN_STEP_MS);
        }
        await player.sleep(HUMAN_STEP_MS * 2);
        clearPending();
        layout.setDialog(null);
    }
    if (player.quitRequested) return;
    const first = resultText(resultEv?.data).split("\n")[0].trim();
    const failed = resultEv?.data?.success === false;
    writeln(
        row({
            variant: failed ? "error" : "success",
            title: "Plan ready for review",
            desc: first || ellipsize(summary.split("\n")[0], 80),
            right: durationBetween(startEv, resultEv),
        }),
    );
    if (outcome?.newMode && outcome.newMode !== "plan") {
        writeln("");
        emitInfo(
            outcome.newMode === "autopilot"
                ? `Execution mode: Autopilot. Permission policy: ${outcome.allowAll ? "Allow All" : "Manual Approval"} for this session. Defaults for future sessions: unchanged.`
                : `Execution mode: ${modeLabel(outcome.newMode)}. Defaults for future sessions: unchanged.`,
        );
    }
}

// ── Thinking / assistant messages ────────────────────────────────────────

// The CLI strips "**" and heading-only lines from reasoning summaries
// and hides reasoning that's empty once invisible characters go.
export function cleanReasoning(text) {
    const t = String(text || "")
        .split("\n")
        .filter((l) => !/^\s*\*\*[^*]+\*\*\s*$/.test(l))
        .join("\n")
        .replace(/\*\*/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return /[^\s\u200b-\u200f\u2060\ufeff]/.test(t) ? t : "";
}

function thoughtLabel(ms) {
    return Number.isFinite(ms) && ms > 0
        ? `Thought for ${Math.max(1, Math.round(ms / 1000))}s`
        : "Thought";
}

async function emitThinking(player, reasoning, ms, mode) {
    await animateThinking(player, reasoning);
    if (player.quitRequested) return;
    const expanded = mode === "expanded";
    const chev = expanded ? ICON.chevronDown : ICON.chevron;
    writeln(` ${fg.dim(chev)} ${fg.italic(fg.dim(thoughtLabel(ms)))}`);
    if (!expanded) return;
    const lines = wrapLines(reasoning, 6).map(
        (l) => `${fg.dim("│")} ${fg.italic(fg.dim(l))}`,
    );
    await streamLines(lines, player, { indent: "   ", perLineMs: 25 });
}

// ── Dispatcher ───────────────────────────────────────────────────────────

function isHiddenUserMessage(d) {
    const content = String(d.content ?? "").trim();
    if (!content) return true;
    if (d.isAutopilotContinuation) return true;
    const src = String(d.source ?? "");
    // Skill payloads, autopilot nudges, memory injections and system
    // notifications are not things the user typed. Messages forwarded by
    // another agent or sent through a /command are shown as prompts.
    if (/^(skill-|autopilot$|system$|memory$|agent-coordinator)/.test(src)) return true;
    if (/^<(system_notification|skill-context|system-reminder)[\s>]/.test(content)) return true;
    return false;
}

export function describeEvent(ev, opts, ctx) {
    const d = ev.data || {};
    switch (ev.type) {
        case "session.start":
            return async (player) => {
                await emitSessionStart(ev, ctx, player);
            };
        case "user.message": {
            if (isHiddenUserMessage(d)) return null;
            const content = String(d.content).trim();
            return async (player) => {
                await typeUserPrompt(content, player);
            };
        }
        case "assistant.message": {
            // Subagent turns are nested under their task in the CLI, not
            // shown inline in the main timeline.
            if (d.parentToolCallId) return null;
            const mode = opts.thinking ?? (opts.showThinking === false ? "hidden" : "expanded");
            const reasoning = mode === "hidden" ? "" : cleanReasoning(d.reasoningText);
            const content = String(d.content ?? "").trim();
            if (!reasoning && !content) return null;
            const ms = ctx?.thinkMs?.get(ev);
            return async (player) => {
                if (reasoning) {
                    await emitThinking(player, reasoning, ms, mode);
                    if (player.quitRequested) return;
                }
                if (content) {
                    if (reasoning) writeln("");
                    const lines = [...renderMarkdownLines(content, 4)];
                    if (lines.length > 0) {
                        writeln(` ${fg.white(ICON.filled)} ${lines[0]}`);
                        await streamLines(lines.slice(1), player, {
                            indent: "   ",
                            perLineMs: 30,
                        });
                    }
                }
            };
        }
        case "tool.execution_start": {
            if (d.parentToolCallId) return null;
            const resultEv = ctx?.toolResults?.get(d.toolCallId);
            const data = resultEv?.data;
            const toolName = d.toolName ?? "tool";
            const args = d.arguments;
            if (HIDDEN_TOOLS.has(toolName)) return null;

            if (toolName === "ask_user") {
                return async (player) => {
                    await emitAskUser(ev, resultEv, ctx?.humanResponses?.get(d.toolCallId), player);
                };
            }
            if (toolName === "exit_plan_mode") {
                return async (player) => {
                    await emitExitPlanMode(ev, resultEv, ctx?.planOutcomes?.get(d.toolCallId), player);
                };
            }
            let lines;
            if (toolName === "view" || toolName === "show_file") lines = () => renderView(args, data, ctx);
            else if (toolName === "edit") lines = () => renderEdit(args, data, ctx);
            else if (toolName === "create") lines = () => renderCreate(args, data, ctx);
            else if (toolName === "apply_patch") lines = () => renderApplyPatch(args, data, ctx);
            else if (SHELL_TOOLS.has(toolName)) lines = () => renderShell(toolName, args, data);
            else if (SHELL_IO_TOOLS.has(toolName)) lines = () => renderShellIO(toolName, args, data);
            else if (toolName === "grep" || toolName === "rg" || toolName === "glob") lines = () => renderSearch(toolName, args, data, ctx);
            else if (toolName === "sql") lines = () => renderSql(args, data);
            else if (toolName === "task_complete") lines = () => renderTaskComplete(args, data);
            else if (toolName === "task") lines = () => renderTask(d, data, ctx);
            else if (toolName === "skill") lines = () => renderSkill(args, data);
            else if (isMcpTool(toolName, d)) lines = () => renderMcp(toolName, d, data);
            else lines = () => renderGeneric(toolName, args, data);
            return () => emitLines(lines());
        }
        case "tool.execution_complete":
            return null;
        case "session.mode_changed":
            // Plan approval already prints the resulting execution mode.
            if (ctx?.planModeChanges?.has(ev)) {
                return null;
            }
            return () => {
                if (d.newMode) layout.setMode(String(d.newMode));
                // The real CLI surfaces the mode as a badge in the
                // footer rather than printing change lines.
                if (opts?.cliMode) return;
                emitModeChange(d.previousMode, d.newMode);
            };
        case "session.model_change":
            // Newer CLIs follow a model change with a session.info that
            // carries the exact "Model changed from …" text; prefer that.
            // The initial model resolution isn't announced at all.
            if (ctx?.modelChangesWithInfo?.has(ev)) return null;
            if (!d.previousModel) return null;
            return () => {
                if (d.newModel) layout.setModel(String(d.newModel));
                if (opts?.cliMode) return;
                emitModelChange(d.previousModel, d.newModel);
            };
        case "session.info": {
            const msg = String(d.message ?? "").trim();
            if (!msg) return null;
            return () => emitInfo(msg);
        }
        case "session.warning": {
            const msg = String(d.message ?? "").trim();
            if (!msg) return null;
            return () => emitDotLineIcon(fg.yellow, ICON.warning, msg);
        }
        case "session.error": {
            const msg = String(d.message ?? "").trim();
            if (!msg) return null;
            return () => emitDotLineIcon(fg.red, ICON.cross, msg, fg.red);
        }
        case "session.plan_changed":
            return () => emitInfo("Plan updated");
        default:
            return null;
    }
}
