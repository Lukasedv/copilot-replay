// Per-event rendering helpers.
//
// `describeEvent(ev, opts, ctx)` returns a zero-arg (or one-arg, taking
// `player`) async function that renders the event when called. This lets
// the player decide whether to run it normally (with animation) or as a
// fast-forward no-op.

import { BULLET, fg } from "./ansi.js";
import { writeln } from "./io.js";
import { layout } from "./layout.js";
import {
    formatDateTime,
    shortenPath,
    truncate,
    wrapLines,
} from "./format.js";
import { renderMarkdownLines } from "./markdown.js";
import {
    animateThinking,
    streamLines,
    typeColoredLine,
    typeUserPrompt,
} from "./anim.js";

function emitDotLine(dotColor, text, bodyColor = fg.white) {
    writeln(`${dotColor(BULLET)} ${bodyColor(text)}`);
}

function thoughtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    return `${Math.max(1, Math.round(ms / 1000))}s`;
}

export function emitInfo(text) {
    emitDotLine(fg.cyan, text, fg.cyan);
}

export function emitModeChange(prev, next) {
    emitDotLine(fg.cyan, `mode ${prev ?? "?"} → ${next ?? "?"}`, fg.cyan);
}

export function emitModelChange(prev, next) {
    emitDotLine(fg.cyan, `model ${prev ?? "?"} → ${next ?? "?"}`, fg.cyan);
}

export async function emitSessionStart(ev, ctx, player) {
    const d = ev.data || {};
    const when = formatDateTime(ev.timestamp);
    const model = ctx?.firstModel || d?.model || "unknown";
    const sid =
        (ctx?.sessionId || d?.sessionId || "").slice(0, 8) || "session";
    const line =
        `${fg.cyan(BULLET)} ${fg.gray("Starting replay of session ")}` +
        `${fg.bold(fg.white(sid))}` +
        (when ? `${fg.gray(" at ")}${fg.white(when)}` : "") +
        `${fg.gray(",  model: ")}${fg.bold(fg.magenta(model))}`;
    await typeColoredLine(player, line, { perCharMs: 8 });
}

// ── Helpers for tool-call rendering ─────────────────────────────────────

function baseFromPath(p) {
    if (!p) return "";
    const s = String(p);
    const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return idx >= 0 ? s.slice(idx + 1) : s;
}

// Count logical lines in a string, ignoring a single trailing newline.
function countLines(text) {
    if (!text) return 0;
    return text.replace(/\n$/, "").split("\n").length;
}

// Parse a unified diff from detailedContent to get accurate +added/-removed.
function parseDiffStats(diffText) {
    if (!diffText) return null;
    let added = 0;
    let removed = 0;
    for (const line of diffText.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    return added || removed ? { added, removed } : null;
}

// Internal tools that are hidden from replay output — they are plumbing
// the demo audience doesn't need to see.
const HIDDEN_TOOLS = new Set([
    "report_intent",
    "stop_bash",
    "update_todo",
    "list_bash",
]);

// Map raw tool names to friendlier display labels.
function toolLabel(name) {
    switch (name) {
        case "bash":
        case "shell":
        case "powershell":
        case "read_bash":
        case "write_bash":
            return "shell";
        case "task":
            return "agent";
        case "exit_plan_mode":
            return "plan";
        default:
            return name;
    }
}

// MCP / plugin tools arrive with names like "workiq-ask_work_iq" or
// "github-mcp-server-search_issues". They are not in our known tool
// switch/case lists, so their args fall through to the generic JSON
// dump, which on workiq can be a multi-kilobyte question + response
// pair. Treat them specially: render a short, human-readable one-liner
// from known keys and suppress the (often massive) result payload.
const KNOWN_TOOL_NAMES = new Set([
    "bash", "shell", "powershell", "read_bash", "write_bash", "list_bash",
    "stop_bash", "edit", "create", "view", "show_file", "grep", "glob",
    "web_fetch", "web_search", "report_intent", "ask_user", "sql", "task",
    "task_complete", "exit_plan_mode", "update_todo",
]);

export function isMcpTool(name) {
    if (!name || typeof name !== "string") return false;
    if (KNOWN_TOOL_NAMES.has(name)) return false;
    return name.includes("-");
}

function mcpToolSummary(args) {
    if (!args || typeof args !== "object") return "";
    // Prefer user-facing intent keys in this order.
    for (const key of ["question", "query", "prompt", "message", "input", "text"]) {
        if (typeof args[key] === "string" && args[key].trim()) {
            return truncate(args[key].trim(), 200);
        }
    }
    return "";
}

// Short one-liner summary of a tool call's primary argument. Tool-specific
// so the replay reads naturally (path for editors, command for shell, etc).
export function summarizeToolArgs(toolName, args) {
    if (!args || typeof args !== "object") return "";
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
            return [a.pattern && `"${a.pattern}"`, a.path && tryPath(a.path)]
                .filter(Boolean)
                .join("  ");
        case "glob":
            return String(a.pattern ?? "");
        case "web_fetch":
            return truncate(String(a.url ?? ""), 160);
        case "web_search":
            return truncate(String(a.query ?? ""), 160);
        case "report_intent":
            return truncate(String(a.intent ?? ""), 160);
        case "ask_user":
            return truncate(String(a.message ?? ""), 160);
        case "sql":
            return truncate(String(a.query ?? ""), 160);
        case "read_bash":
            return "";
        case "write_bash":
            return truncate(String(a.input ?? ""), 80);
        case "task":
        case "task_complete":
        case "exit_plan_mode":
            return "";
        default: {
            try {
                return truncate(JSON.stringify(a), 160);
            } catch {
                return "";
            }
        }
    }
}

// Human title fallback when the agent didn't supply a description.
export function defaultToolTitle(name, args) {
    const a = args && typeof args === "object" ? args : {};
    switch (name) {
        case "view":
        case "show_file":
            return a.path ? `Read ${baseFromPath(a.path)}` : "Read file";
        case "edit":
            return a.path ? `Edit ${baseFromPath(a.path)}` : "Edit file";
        case "create":
            return a.path ? `Create ${baseFromPath(a.path)}` : "Create file";
        case "bash":
        case "shell":
        case "powershell":
            return "Run shell command";
        case "read_bash":
            return "Read shell output";
        case "write_bash":
            return "Send shell input";
        case "grep":
            return a.pattern ? `Search for ${a.pattern}` : "Search";
        case "glob":
            return a.pattern ? `Find ${a.pattern}` : "Find files";
        case "web_fetch":
            return "Fetch URL";
        case "web_search":
            return "Web search";
        case "report_intent":
            return "Report intent";
        case "ask_user":
            return "Ask user";
        case "sql":
            return "SQL query";
        case "task":
            return a.description || a.name || "Run agent task";
        case "task_complete":
            return "Task complete";
        case "exit_plan_mode":
            return "Plan approved";
        default:
            return name;
    }
}

function emitToolResult(name, data) {
    if (data?.success === false) {
        const err = truncate(
            String(data.error?.message ?? data.error ?? "failed"),
            300,
        );
        writeln(`  ${fg.red("⎿")} ${fg.red(err)}`);
        return;
    }
    const res = data?.result;
    let text = "";
    if (typeof res === "string") text = res;
    else if (res && typeof res === "object") {
        text =
            res.content ?? res.detailedContent ?? res.textResultForLlm ?? "";
    }
    text = String(text ?? "").trim();
    if (!text) return;
    const rawLines = text.split("\n");
    const nLines = rawLines.length;
    if (nLines >= 3) {
        writeln(`  ${fg.gray("⎿")} ${fg.dim(fg.gray(`${nLines} lines`))}`);
        return;
    }
    const first = truncate(rawLines[0] ?? "", 200);
    writeln(`  ${fg.gray("⎿")} ${fg.dim(fg.gray(first))}`);
    if (rawLines[1]) {
        writeln(`    ${fg.dim(fg.gray(truncate(rawLines[1], 200)))}`);
    }
}

function emitToolStart(name, args, resultData) {
    const description =
        args && typeof args === "object" && args.description
            ? String(args.description)
            : "";
    const primary = summarizeToolArgs(name, args);
    const title = description || defaultToolTitle(name, args);
    writeln(
        `${fg.green(BULLET)} ${fg.bold(fg.white(title))} ` +
            `${fg.gray(`(${toolLabel(name)})`)}`,
    );
    if (primary) {
        const lines = wrapLines(truncate(primary, 300), 4);
        writeln(`  ${fg.gray("⎿")} ${fg.gray(lines[0])}`);
        for (let i = 1; i < lines.length; i++) {
            writeln(`    ${fg.gray(lines[i])}`);
        }
    }
    if (resultData) emitToolResult(name, resultData);
}

const SHELL_TOOLS = new Set([
    "bash",
    "shell",
    "local_shell",
    "powershell",
    "read_bash",
    "write_bash",
]);

const SEARCH_TOOLS = new Set(["grep", "rg", "glob", "web_search"]);

function compactSearchDescription(name, args) {
    const a = args && typeof args === "object" ? args : {};
    if (name === "web_search") return truncate(String(a.query ?? ""), 180);
    const pattern = String(a.pattern ?? a.query ?? "");
    if (!pattern) return "";
    if (name === "glob") return `"${truncate(pattern, 120)}"`;
    const location = a.path ? shortenPath(String(a.path)) : "files";
    return `"${truncate(pattern, 120)}" in ${location}`;
}

function compactFileStats(name, args, resultData) {
    const a = args && typeof args === "object" ? args : {};
    if (name === "create") {
        const lines = countLines(String(a.file_text ?? a.content ?? ""));
        return lines > 0 ? { added: lines, removed: 0 } : null;
    }
    if (name !== "edit" && name !== "apply_patch") return null;
    const detailed = resultData?.result?.detailedContent ?? "";
    const patch = String(a.patch ?? "");
    const parsed = parseDiffStats(detailed) || parseDiffStats(patch);
    if (parsed) return parsed;
    const oldLines = countLines(String(a.old_str ?? ""));
    const newLines = countLines(String(a.new_str ?? ""));
    return oldLines || newLines
        ? { added: newLines, removed: oldLines }
        : null;
}

function emitCompactTool(name, args, resultData) {
    const a = args && typeof args === "object" ? args : {};
    const failed = resultData?.success === false;
    let icon = BULLET;
    let iconColor = failed ? fg.red : fg.green;
    let title = name;
    let description = "";
    let stats = null;

    if (["view", "show_file"].includes(name)) {
        title = "Read";
        description = baseFromPath(a.path) || "file";
    } else if (name === "create") {
        title = "Create";
        description = baseFromPath(a.path) || "file";
        stats = compactFileStats(name, a, resultData);
    } else if (name === "edit" || name === "apply_patch") {
        title = "Edit";
        description = baseFromPath(a.path) || (name === "apply_patch" ? "files" : "file");
        stats = compactFileStats(name, a, resultData);
    } else if (SHELL_TOOLS.has(name)) {
        icon = "$";
        iconColor = failed ? fg.red : fg.yellow;
        title = "Shell";
        description = truncate(
            String(a.description ?? a.command ?? a.input ?? ""),
            180,
        ).replace(/\s+/g, " ");
    } else if (SEARCH_TOOLS.has(name)) {
        icon = "/";
        iconColor = failed ? fg.red : fg.gray;
        title = "Search";
        description = compactSearchDescription(name, a);
    } else if (name === "task") {
        title = "Agent";
        description = truncate(String(a.description ?? a.name ?? ""), 180);
    } else if (isMcpTool(name)) {
        title = name;
        description = mcpToolSummary(a);
    } else {
        title = defaultToolTitle(name, a);
        description = summarizeToolArgs(name, a);
    }

    if (failed) {
        icon = "✗";
        const error = String(
            resultData?.error?.message ?? resultData?.error ?? "failed",
        );
        description = description
            ? `${description} — ${truncate(error, 100)}`
            : truncate(error, 180);
    }

    let line = `${iconColor(icon)} ${fg.bold(fg.white(title))}`;
    if (description) line += ` ${fg.white(description)}`;
    if (stats?.added) line += ` ${fg.green(`+${stats.added}`)}`;
    if (stats?.removed) line += ` ${fg.red(`-${stats.removed}`)}`;
    writeln(line);
}

// ── Specialized tool renderers ─────────────────────────────────────────

function emitCreateFile(args) {
    const path = String(args?.path ?? "");
    const base = baseFromPath(path) || "file";
    const lines = countLines(String(args?.file_text ?? ""));

    let title = `${fg.green(BULLET)} ${fg.bold(fg.white(`Create ${base}`))}`;
    if (lines > 0) title += ` ${fg.green(`+${lines}`)}`;
    writeln(title);

    if (path) {
        writeln(`  ${fg.gray("⎿")} ${fg.gray(shortenPath(path))}`);
    }
}

function emitEditFile(args, resultData) {
    const path = String(args?.path ?? "");
    const base = baseFromPath(path) || "file";

    // Prefer accurate diff stats from the unified diff in detailedContent.
    const detailed = resultData?.result?.detailedContent ?? "";
    let stats = parseDiffStats(detailed);
    // Fallback: count old_str vs new_str lines (less accurate but usable).
    if (!stats) {
        const oldLines = countLines(String(args?.old_str ?? ""));
        const newLines = countLines(String(args?.new_str ?? ""));
        if (oldLines || newLines) stats = { added: newLines, removed: oldLines };
    }

    let title = `${fg.green(BULLET)} ${fg.bold(fg.white(`Edit ${base}`))}`;
    if (stats?.added) title += ` ${fg.green(`+${stats.added}`)}`;
    if (stats?.removed) title += ` ${fg.red(`-${stats.removed}`)}`;
    writeln(title);

    if (path) {
        writeln(`  ${fg.gray("⎿")} ${fg.gray(shortenPath(path))}`);
    }
}

function emitTaskComplete(args, resultData) {
    const summary =
        String(args?.summary ?? "").trim() ||
        String(resultData?.result?.content ?? "").trim();
    writeln(`${fg.green(BULLET)} ${fg.bold(fg.white("Task complete"))}`);
    if (summary) {
        const lines = renderMarkdownLines(summary, 2);
        if (lines.length > 0) {
            writeln(`  ${fg.gray("⎿")} ${lines[0]}`);
            for (let i = 1; i < lines.length; i++) {
                writeln(`  ${lines[i]}`);
            }
        }
    }
}

function emitMcpTool(name, args) {
    const summary = mcpToolSummary(args);
    writeln(
        `${fg.green(BULLET)} ${fg.bold(fg.white(name))} ` +
            `${fg.gray(`(${toolLabel(name)})`)}`,
    );
    if (summary) {
        const lines = wrapLines(summary, 4);
        writeln(`  ${fg.gray("⎿")} ${fg.gray(lines[0])}`);
        for (let i = 1; i < lines.length; i++) {
            writeln(`    ${fg.gray(lines[i])}`);
        }
    }
}

// Parse an ask_user tool result into a structured answer. Copilot CLI
// produces a handful of well-known shapes; everything else falls through
// as a free-text response.
function parseAskUserResult(resultData) {
    const res = resultData?.result;
    const content = String(res?.content ?? "").trim();
    const detailed = String(res?.detailedContent ?? "").trim();
    if (!content && !detailed) return null;
    if (/^User declined\b/i.test(content)) return { kind: "declined" };
    if (/^User can(celled|celed)\b/i.test(content)) {
        return { kind: "cancelled" };
    }
    const selMatch = content.match(/^User selected:\s*([\s\S]+)$/);
    if (selMatch) {
        return { kind: "choice", choice: selMatch[1].trim() };
    }
    // Form response: detailedContent has "User responded:\nkey: val\n..."
    // If that's present, parse it as key→value pairs.
    if (/^User responded:?\s*\n/i.test(detailed)) {
        const body = detailed.replace(/^User responded:?\s*\n/i, "");
        const fields = [];
        for (const ln of body.split("\n")) {
            const m = ln.match(/^\s*([^:]+):\s*(.*)$/);
            if (m) fields.push({ key: m[1].trim(), value: m[2].trim() });
        }
        if (fields.length > 0) return { kind: "form", fields };
    }
    const respMatch = content.match(/^User responded:\s*([\s\S]+)$/i);
    if (respMatch) {
        const body = respMatch[1].trim();
        // Inline comma-separated "k1=v1, k2=v2" form output.
        if (/^[\w.-]+=[^,]/.test(body) && body.includes("=")) {
            const fields = [];
            for (const part of body.split(/,\s*/)) {
                const m = part.match(/^([\w.-]+)\s*=\s*(.+)$/);
                if (m) fields.push({ key: m[1].trim(), value: m[2].trim() });
            }
            if (fields.length > 0) return { kind: "form", fields };
        }
        return { kind: "text", text: body };
    }
    return { kind: "text", text: detailed || content };
}

// Extract the list of choices from an ask_user call, mapping each to a
// short display label and a "const" value that the result will match on.
// Returns an array of { label, const } entries, or null if this isn't a
// multiple-choice style call.
function extractAskUserChoices(args) {
    if (!args || typeof args !== "object") return null;
    if (Array.isArray(args.choices) && args.choices.length > 0) {
        return args.choices.map((c) => ({ label: String(c), const: String(c) }));
    }
    return null;
}

// Extract form fields from a `requestedSchema` so we can show each field's
// human title next to the user's chosen value. Returns null if this call
// doesn't have a schema.
function extractAskUserFields(args) {
    const props = args?.requestedSchema?.properties;
    if (!props || typeof props !== "object") return null;
    const out = [];
    for (const key of Object.keys(props)) {
        const p = props[key] || {};
        const title = String(p.title || key);
        const options = [];
        if (Array.isArray(p.oneOf)) {
            for (const o of p.oneOf) {
                if (o && typeof o === "object") {
                    options.push({
                        const: String(o.const ?? ""),
                        label: String(o.title ?? o.const ?? ""),
                    });
                }
            }
        } else if (Array.isArray(p.enum)) {
            const enumNames = Array.isArray(p.enumNames) ? p.enumNames : null;
            for (let i = 0; i < p.enum.length; i++) {
                options.push({
                    const: String(p.enum[i]),
                    label: String(
                        enumNames?.[i] ?? p.enum[i],
                    ),
                });
            }
        }
        out.push({
            key,
            title,
            type: p.type || "string",
            isFreeText: !options.length,
            options,
        });
    }
    return out.length > 0 ? out : null;
}

async function emitAskUser(d, resultData, player) {
    const args = d.arguments || {};
    const question = String(args.question ?? args.message ?? "").trim();
    const choices = extractAskUserChoices(args);
    const fields = extractAskUserFields(args);
    const answer = parseAskUserResult(resultData);

    writeln(
        `${fg.yellow(BULLET)} ${fg.bold(fg.white("Question for you"))} ` +
            `${fg.gray("(ask_user)")}`,
    );
    if (question) {
        const qLines = renderMarkdownLines(question, 2);
        await streamLines(qLines, player, { indent: "  ", perLineMs: 40 });
    }

    // Multiple choice — reveal options one by one, then type the selection.
    if (choices) {
        writeln("");
        const selected = answer?.kind === "choice" ? answer.choice : null;
        for (const c of choices) {
            const isSel = selected && c.label === selected;
            const mark = isSel ? fg.cyan("●") : fg.gray("○");
            const text = isSel ? fg.bold(fg.cyan(c.label)) : fg.gray(c.label);
            writeln(`    ${mark} ${text}`);
            await player.sleep(120);
        }
        writeln("");
        if (selected) {
            await player.sleep(300);
            const line = `  ${fg.gray("⎿")} ${fg.dim(fg.gray("User selected: "))}${fg.cyan(selected)}`;
            await typeColoredLine(player, line, { perCharMs: 12 });
        } else if (answer?.kind === "declined") {
            writeln(`  ${fg.gray("⎿")} ${fg.dim(fg.gray("User declined to answer"))}`);
        } else if (answer?.kind === "cancelled") {
            writeln(`  ${fg.gray("⎿")} ${fg.dim(fg.gray("User cancelled"))}`);
        }
        return;
    }

    // Schema form — reveal fields one at a time and type out every answer
    // so the audience can follow along.
    if (fields) {
        writeln("");
        const answered = new Map();
        if (answer?.kind === "form") {
            for (const f of answer.fields) answered.set(f.key, f.value);
        }
        for (const f of fields) {
            const val = answered.get(f.key);
            const labelLine =
                `  ${fg.gray("▸")} ${fg.bold(fg.white(f.title))}` +
                `  ${fg.dim(fg.gray(`(${f.key})`))}`;
            writeln(labelLine);
            if (val != null) {
                let displayLabel = val;
                const opt = f.options.find((o) => o.const === val);
                if (opt) displayLabel = opt.label;
                const line =
                    `      ${fg.gray("→")} ` +
                    (f.isFreeText
                        ? fg.white(displayLabel)
                        : fg.cyan(displayLabel));
                if (!player.fastForwarding) {
                    await player.sleep(200);
                    await typeColoredLine(player, line, {
                        perCharMs: f.isFreeText ? 20 : 12,
                    });
                } else {
                    writeln(line);
                }
            } else {
                writeln(`      ${fg.gray("→")} ${fg.dim(fg.gray("(no answer)"))}`);
            }
            await player.sleep(150);
        }
        writeln("");
        if (answer?.kind === "declined") {
            writeln(`  ${fg.gray("⎿")} ${fg.dim(fg.gray("User declined"))}`);
        } else if (answer?.kind === "cancelled") {
            writeln(`  ${fg.gray("⎿")} ${fg.dim(fg.gray("User cancelled"))}`);
        } else {
            writeln(`  ${fg.gray("⎿")} ${fg.dim(fg.gray("User submitted form"))}`);
        }
        return;
    }

    // Free-text reply (no choices, no schema). Type the answer out so it
    // feels like the user is responding live.
    if (answer?.kind === "text" && answer.text) {
        writeln("");
        const wrapped = wrapLines(answer.text, 6);
        for (let i = 0; i < wrapped.length; i++) {
            const prefix = i === 0 ? `    ${fg.cyan("›")} ` : "      ";
            const line = prefix + fg.white(wrapped[i]);
            if (!player.fastForwarding) {
                await typeColoredLine(player, line, { perCharMs: 18 });
            } else {
                writeln(line);
            }
        }
    } else if (answer?.kind === "declined") {
        writeln(`  ${fg.gray("⎿")} ${fg.dim(fg.gray("User declined"))}`);
    } else if (answer?.kind === "cancelled") {
        writeln(`  ${fg.gray("⎿")} ${fg.dim(fg.gray("User cancelled"))}`);
    }
}

export function describeEvent(ev, opts, ctx) {
    const d = ev.data || {};
    switch (ev.type) {
        case "session.start":
            return async (player) => {
                await emitSessionStart(ev, ctx, player);
            };
        case "user.message": {
            const content = (d.content ?? "").trim();
            if (!content) return null;
            // Filter out skill/system-injected user.messages — these have
            // a `source` field (e.g. "skill-workiq") and contain payloads
            // like <skill-context …> that the real Copilot CLI never types
            // into the user prompt box.
            if (d.source) return null;
            return async (player) => {
                await typeUserPrompt(content, player);
            };
        }
        case "assistant.message": {
            const reasoning = (d.reasoningText ?? "").trim();
            const content = (d.content ?? "").trim();
            if (!reasoning && !content) return null;
            return async (player) => {
                if (reasoning && opts.showThinking) {
                    if (opts.cliMode) {
                        writeln(`${fg.blue("❯")} ${fg.gray("Thought")}`);
                    } else {
                        await animateThinking(player, reasoning);
                        if (player.quitRequested) return;
                        writeln(
                            `${fg.magenta(BULLET)} ` +
                                `${fg.dim(fg.magenta("Thinking"))}`,
                        );
                        const lines = [...renderMarkdownLines(reasoning, 2)];
                        await streamLines(lines, player, {
                            indent: "  ",
                            perLineMs: 25,
                        });
                    }
                }
                if (content) {
                    if (reasoning) writeln("");
                    if (player.quitRequested) return;
                    const lines = [...renderMarkdownLines(content, 2)];
                    if (lines.length > 0) {
                        const dotColor = opts.cliMode ? fg.blue : fg.magenta;
                        writeln(`${dotColor(BULLET)} ${lines[0]}`);
                        await streamLines(lines.slice(1), player, {
                            indent: "  ",
                            perLineMs: 30,
                        });
                    }
                }
            };
        }
        case "assistant.reasoning_delta":
            return null;
        case "assistant.reasoning": {
            const reasoning = String(d.content ?? "").trim();
            if (!reasoning || !opts.showThinking) return null;
            return async (player) => {
                if (opts.cliMode) {
                    const duration = thoughtDuration(
                        ctx?.reasoningDurations?.get(ev.id),
                    );
                    const label = duration
                        ? `Thought for ${duration}`
                        : "Thought";
                    writeln(`${fg.blue("❯")} ${fg.gray(label)}`);
                    return;
                }
                await animateThinking(player, reasoning);
                if (player.quitRequested) return;
                writeln(
                    `${fg.magenta(BULLET)} ${fg.dim(fg.magenta("Thinking"))}`,
                );
                const lines = [...renderMarkdownLines(reasoning, 2)];
                await streamLines(lines, player, {
                    indent: "  ",
                    perLineMs: 25,
                });
            };
        }
        case "tool.execution_start": {
            const resultEv = ctx?.toolResults?.get(d.toolCallId);
            const toolName = d.toolName ?? "tool";

            // Hide internal plumbing tools from the demo audience.
            if (HIDDEN_TOOLS.has(toolName)) return null;

            // Specialized renderers for tools that benefit from richer
            // presentation than the generic bullet+summary.
            if (toolName === "ask_user") {
                return async (player) => {
                    await emitAskUser(d, resultEv?.data, player);
                };
            }
            if (opts.cliMode) {
                return () =>
                    emitCompactTool(toolName, d.arguments, resultEv?.data);
            }
            if (toolName === "create") {
                return () => emitCreateFile(d.arguments);
            }
            if (toolName === "edit") {
                return () => emitEditFile(d.arguments, resultEv?.data);
            }
            if (toolName === "task_complete") {
                return () => emitTaskComplete(d.arguments, resultEv?.data);
            }

            // MCP / plugin tools: show a clean one-liner, drop the giant
            // response payload entirely.
            if (isMcpTool(toolName)) {
                return () => emitMcpTool(toolName, d.arguments);
            }

            // Generic tool rendering for everything else.
            return () =>
                emitToolStart(toolName, d.arguments, resultEv?.data);
        }
        case "tool.execution_complete":
            return null;
        case "session.mode_changed":
            return () => {
                if (d.newMode) layout.setMode(String(d.newMode));
                // Real Copilot CLI doesn't print "mode X → Y" lines;
                // it surfaces the current mode as a label in the
                // input-box chrome. In --cli-mode we match that and
                // only update the label.
                if (opts?.cliMode) return;
                emitModeChange(d.previousMode, d.newMode);
            };
        case "session.model_change":
            return () => {
                layout.setSessionInfo({
                    model:
                        typeof d.newModel === "string"
                            ? d.newModel
                            : undefined,
                    reasoningEffort:
                        typeof d.reasoningEffort === "string"
                            ? d.reasoningEffort
                            : undefined,
                    contextTier:
                        typeof d.contextTier === "string"
                            ? d.contextTier
                            : undefined,
                });
                if (opts?.cliMode) return;
                emitModelChange(d.previousModel, d.newModel);
            };
        case "session.info":
            return () => emitInfo(String(d.message ?? ""));
        case "session.plan_changed":
            return () => emitDotLine(fg.cyan, "plan updated", fg.cyan);
        default:
            return null;
    }
}
