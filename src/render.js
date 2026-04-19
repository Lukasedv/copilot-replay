// Per-event rendering helpers.
//
// `describeEvent(ev, opts, ctx)` returns a zero-arg (or one-arg, taking
// `player`) async function that renders the event when called. This lets
// the player decide whether to run it normally (with animation) or as a
// fast-forward no-op.

import { BULLET, fg } from "./ansi.js";
import { writeln } from "./io.js";
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
    const baseFromPath = (p) => {
        if (!p) return "";
        const s = String(p);
        const idx = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
        return idx >= 0 ? s.slice(idx + 1) : s;
    };
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
        default:
            return name;
    }
}

function emitToolResult(name, data) {
    if (data?.success === false) {
        const err = truncate(String(data.error ?? "failed"), 300);
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
            `${fg.gray(`(${name})`)}`,
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
                if (content) {
                    if (reasoning) writeln("");
                    if (player.quitRequested) return;
                    const lines = [...renderMarkdownLines(content, 2)];
                    if (lines.length > 0) {
                        writeln(`${fg.magenta(BULLET)} ${lines[0]}`);
                        await streamLines(lines.slice(1), player, {
                            indent: "  ",
                            perLineMs: 30,
                        });
                    }
                }
            };
        }
        case "tool.execution_start": {
            const resultEv = ctx?.toolResults?.get(d.toolCallId);
            return () =>
                emitToolStart(d.toolName ?? "tool", d.arguments, resultEv?.data);
        }
        case "tool.execution_complete":
            return null;
        case "session.mode_changed":
            return () => emitModeChange(d.previousMode, d.newMode);
        case "session.model_change":
            return () => emitModelChange(d.previousModel, d.newModel);
        case "session.info":
            return () => emitInfo(String(d.message ?? ""));
        case "session.plan_changed":
            return () => emitDotLine(fg.cyan, "plan updated", fg.cyan);
        default:
            return null;
    }
}
