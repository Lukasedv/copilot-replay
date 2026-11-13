// Playback engine.
//
// Walks the event list at `speed × real-time`, clamped to `[min, cap]` ms
// between events. Responds to `pause / resume`, `skip`, and prev / next
// user.message navigation. When navigating, individual animations honor
// `fastForwarding` so they render instantly rather than spending their
// usual per-character / per-line delays.

import { homedir } from "node:os";
import { isTTY, fg } from "./ansi.js";
import { writeln } from "./io.js";
import { layout } from "./layout.js";
import { waitForStart } from "./anim.js";
import { renderCliBannerLines, renderExitSummaryLines } from "./banner.js";
import { describeEvent } from "./render.js";

export class Player {
    constructor(events, opts) {
        this.events = events;
        this.opts = opts;
        this.speed = opts.speed;
        this.defaultSpeed = opts.speed;
        // Start paused in a TTY so the user can press space to begin the
        // replay on demand. Non-TTY (piped) runs autoplay.
        this.paused = isTTY;
        this.skipRequested = false;
        this.quitRequested = false;
        this.seekNext = false;
        this.seekPrev = false;
        // Step mode: when paused, arrows advance/retreat one renderable
        // event at a time instead of jumping between user prompts.
        this.stepNext = false;
        this.stepPrev = false;
        this.fastForwarding = false;
        this.currentPromptIndex = -1;
        // Index of the last event we actually rendered. Drives stepPrev.
        this.lastRenderedIdx = -1;
        this._rewindTo = null;
        // When a step/seek rewind completes, we re-pause so the user
        // stays in step mode at the new landing point.
        this._pauseAfterSeek = false;
        this._wake = null;
        // CLI mode: "one user-prompt segment per right-arrow press"
        // budget. Each user.message we're about to render consumes one
        // unit; when the budget hits zero we auto-pause and wait for the
        // user to press → again. Starts at 0 so the initial right-arrow
        // press is required before the first user prompt plays.
        this._cliBudget = 0;
        this._lastRenderedType = null;
        this.ctx = null;
    }

    wake() {
        if (this._wake) {
            const w = this._wake;
            this._wake = null;
            w();
        }
    }

    async sleep(ms) {
        if (ms <= 0) return;
        // Safety net: any renderer that forgets to check fastForwarding
        // still exits instantly while we're fast-forwarding a seek/step.
        if (this.fastForwarding) return;
        const deadline = Date.now() + ms;
        while (!this.quitRequested && !this.skipRequested) {
            if (this.paused) {
                await new Promise((r) => {
                    this._wake = r;
                });
                this._wake = null;
                continue;
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) return;
            await new Promise((r) => {
                const t = setTimeout(() => {
                    this._wake = null;
                    r();
                }, remaining);
                this._wake = () => {
                    clearTimeout(t);
                    this._wake = null;
                    r();
                };
            });
        }
    }

    // Block until paused becomes false (or quit). Used for the CLI-mode
    // "wait for right-arrow" gate, which needs to block regardless of
    // delay — sleep() returns instantly for ms <= 0.
    async waitForResume() {
        while (this.paused && !this.quitRequested) {
            await new Promise((r) => {
                this._wake = r;
            });
            this._wake = null;
        }
    }

    async run() {
        const { events, opts } = this;
        if (events.length === 0) {
            writeln(fg.yellow("No events to replay."));
            return;
        }

        // Pre-pass: pair tool starts with their results and collect the
        // side-channel events newer CLIs record (human responses, subagent
        // lifecycle, plan approvals) so each renderer can find them.
        const ctx = buildContext(events, opts);
        const { firstModel, firstMode } = ctx;
        this.ctx = ctx;

        const cwdText = ctx.cwd.replace(homedir(), "~");
        // Configure cli-mode BEFORE enabling the layout so the first
        // draw uses the correct chrome (header row + footer).
        if (opts.cliMode) layout.setCliMode(true, firstModel || "");
        else layout.setModel(firstModel || "");
        if (firstMode) layout.setMode(firstMode);
        layout.setBranch(ctx.branch);
        layout.enable(cwdText);
        layout.setSpeed(this.speed);
        layout.setPaused(this.paused);

        // CLI mode: a fresh-looking CLI screen — just the app header, no
        // "Press SPACE" overlay. Wait for the first → press, then play
        // through one user-prompt segment at a time.
        if (opts.cliMode) {
            for (const l of renderCliBannerLines(ctx.copilotVersion)) writeln(l);
            await this.waitForResume();
            if (this.quitRequested) {
                layout.disable();
                return;
            }
        } else {
            // Initial pause: show the centered "Press SPACE to start
            // replay" overlay until the user hits space.
            await waitForStart(this);
            if (this.quitRequested) {
                layout.disable();
                writeln(fg.gray("━ replay aborted"));
                return;
            }
        }

        let prevTs = null;
        let first = true;
        let i = 0;
        while (i < events.length) {
            if (this.quitRequested) break;

            // LEFT arrow: rewind to the previous user.message by
            // fast-forwarding from the top.
            if (this.seekPrev) {
                this.seekPrev = false;
                const target = this._findPrevUserIndex(events, opts);
                if (target != null) {
                    this._rewindFromTop(target);
                    prevTs = null;
                    first = true;
                    i = 0;
                    continue;
                }
            }
            // LEFT arrow while paused: step back one renderable event
            // and re-pause at that landing point.
            if (this.stepPrev) {
                this.stepPrev = false;
                const target = this._findPrevRenderableIndex(
                    events,
                    opts,
                    ctx,
                    this.lastRenderedIdx - 1,
                );
                if (target != null) {
                    this._rewindFromTop(target);
                    this._pauseAfterSeek = true;
                    prevTs = null;
                    first = true;
                    i = 0;
                    continue;
                }
                // Nothing to go back to — stay paused where we are.
                this.skipRequested = false;
                continue;
            }
            // RIGHT arrow while paused: advance one renderable event at
            // full speed (no typing / thinking animations) and re-pause.
            const stepOnce = this.stepNext;
            if (stepOnce) this.stepNext = false;

            const ev = events[i];
            // Footer state (mode, model, permissions, usage, busy) follows
            // the recording even for events that never render.
            this._applyState(ev, i);
            if (!opts.include.has(ev.type)) {
                i++;
                continue;
            }
            // CLI mode: suppress the "Starting replay of session …"
            // session.start animation (we showed a real-CLI banner
            // instead) and gate advancement at each user.message on the
            // → key budget so each press plays exactly one "user
            // prompt → assistant work" segment.
            if (opts.cliMode && ev.type === "session.start") {
                i++;
                continue;
            }
            const render = describeEvent(ev, opts, ctx);
            if (!render) {
                i++;
                continue;
            }
            if (
                opts.cliMode &&
                ev.type === "user.message" &&
                this._rewindTo == null &&
                !this.stepNext &&
                !this.seekNext
            ) {
                if (this._cliBudget <= 0) {
                    layout.setBusy(false);
                    this.paused = true;
                    layout.setPaused(true);
                    await this.waitForResume();
                    if (this.quitRequested) break;
                }
                if (this._cliBudget > 0) this._cliBudget--;
            }

            const rewinding =
                this._rewindTo != null && i <= this._rewindTo;
            // RIGHT arrow (while playing): fast-forward everything *up to
            // but not including* the next user.message. That user prompt
            // itself plays its full typing animation.
            const seekingNext =
                this.seekNext && ev.type !== "user.message";
            if (this.seekNext && ev.type === "user.message") {
                this.seekNext = false;
            }
            const fastForward = rewinding || seekingNext || stepOnce;
            this.fastForwarding = fastForward;

            const ts = Date.parse(ev.timestamp);
            if (!fastForward && prevTs != null && Number.isFinite(ts)) {
                const raw = Math.max(0, ts - prevTs);
                const scaled = raw / this.speed;
                const delay = Math.max(
                    opts.min,
                    Math.min(opts.cap, scaled),
                );
                await this.sleep(delay);
            } else if (!fastForward && prevTs != null) {
                await this.sleep(opts.min);
            }
            if (this.quitRequested) break;
            if (this.seekPrev || this.stepPrev) {
                this.fastForwarding = false;
                continue;
            }

            // One blank row between timeline entries, except directly
            // after a submitted prompt panel (the CLI butts the first
            // entry right up against it).
            if (
                !first &&
                ev.type !== "user.message" &&
                this._lastRenderedType !== "user.message"
            ) {
                writeln();
            }
            first = false;
            if (ev.type === "user.message") {
                layout.setBusy(false);
            }
            if (ev.type === "user.message" && fastForward) {
                // Rewinding/stepping past a user.message: commit instantly.
                const c = (ev.data?.content ?? "").trim();
                if (c) layout.commitPrompt(c);
                this.currentPromptIndex = i;
            } else {
                if (ev.type === "user.message") this.currentPromptIndex = i;
                await render(this);
            }
            if (ev.type === "user.message") layout.setBusy(true);
            this._lastRenderedType = ev.type;
            this.fastForwarding = false;
            this.lastRenderedIdx = i;
            prevTs = Number.isFinite(ts) ? ts : prevTs;

            if (this._rewindTo != null && i >= this._rewindTo) {
                this._rewindTo = null;
                if (this._pauseAfterSeek) {
                    this._pauseAfterSeek = false;
                    this.paused = true;
                    layout.setPaused(true);
                }
            }
            if (stepOnce) {
                this.paused = true;
                layout.setPaused(true);
            }
            this.skipRequested = false;
            i++;
        }

        layout.setBusy(false);
        layout.setDialog(null);
        layout.disable();
        if (opts.cliMode) {
            // Like quitting the real CLI: print its exit summary.
            const shut = [...events].reverse().find((e) => e.type === "session.shutdown");
            if (shut) {
                for (const l of renderExitSummaryLines(shut.data, ctx.sessionId, shut.timestamp)) {
                    writeln(l);
                }
            }
            return;
        }
        if (this.quitRequested) {
            writeln(fg.gray("━ replay aborted"));
        } else {
            writeln(fg.gray("━ replay complete"));
        }
    }

    _findPrevUserIndex(events, opts) {
        // LEFT goes to the user.message *before* the currently-active
        // prompt, never back to the same block we're already in.
        const cur = this.currentPromptIndex;
        if (cur == null || cur <= 0) return null;
        for (let j = cur - 1; j >= 0; j--) {
            const e = events[j];
            if (e.type !== "user.message") continue;
            if (!opts.include.has(e.type)) continue;
            if (!describeEvent(e, opts, this.ctx)) continue;
            return j;
        }
        return null;
    }

    _findPrevRenderableIndex(events, opts, ctx, from) {
        // Used by stepPrev — walk back until we find an event that would
        // actually produce visible output (in the include set AND
        // describeEvent returns a renderer).
        for (let j = from; j >= 0; j--) {
            const e = events[j];
            if (!opts.include.has(e.type)) continue;
            if (!describeEvent(e, opts, ctx)) continue;
            return j;
        }
        return null;
    }

    _rewindFromTop(target) {
        // Clear the scrollback region and footer input so the replay can
        // be re-walked from event 0 up to `target` without leftover text.
        // Footer state is reset too; the re-walk re-applies it.
        layout.setDialog(null);
        layout.clearTyped();
        layout.setBusy(false);
        layout.setMode(this.ctx?.firstMode || "");
        layout.setModel(this.ctx?.firstModel || "");
        layout.setAllowAll(false);
        layout.aic = null;
        layout.clearScrollRegion();
        this._lastRenderedType = null;
        this._rewindTo = target;
    }

    // Apply footer-visible state carried by an event (regardless of
    // whether the event itself renders anything).
    _applyState(ev, i) {
        const d = ev.data || {};
        switch (ev.type) {
            case "session.mode_changed":
                if (d.newMode) layout.setMode(String(d.newMode));
                break;
            case "session.model_change":
                if (d.newModel) layout.setModel(String(d.newModel));
                break;
            case "session.permissions_changed":
                layout.setAllowAll(!!d.allowAllPermissions);
                break;
            case "session.usage_checkpoint":
            case "session.shutdown": {
                const nano = Number(d.totalNanoAiu ?? d.accountingSnapshot?.totalNanoAiu);
                if (Number.isFinite(nano) && nano > 0) layout.setAic(nano / 1e9);
                break;
            }
            case "session.context_changed":
                if (typeof d.branch === "string") layout.setBranch(d.branch);
                break;
            default:
                break;
        }
        if (this.ctx?.idleAfter?.has(i)) layout.setBusy(false);
    }
}

const ANCHOR_TYPES = new Set([
    "user.message",
    "assistant.turn_start",
    "assistant.message",
    "tool.execution_complete",
]);

// One pass over the event list that indexes everything renderers need.
// Works for both old (pre-1.0.100) and new recordings: every lookup is
// optional and falls back gracefully when the event type doesn't exist.
export function buildContext(events, opts = {}) {
    const toolResults = new Map();
    const toolStarts = new Map();
    const humanResponses = new Map();
    const subagents = new Map();
    const planOutcomes = new Map();
    const thinkMs = new Map();
    const modelChangesWithInfo = new Set();
    const planModeChanges = new Set();
    const idleAfter = new Set();
    let firstModel = "";
    let firstMode = "";
    let cwd = "";
    let branch = "";
    let copilotVersion = "";
    let lastAnchorTs = null;
    const openPlans = [];
    let allowAll = false;

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const d = ev.data || {};
        const ts = Date.parse(ev.timestamp);
        switch (ev.type) {
            case "session.start":
            case "session.resume":
                if (!cwd && d.context?.cwd) cwd = String(d.context.cwd);
                if (!branch && d.context?.branch) branch = String(d.context.branch);
                if (!copilotVersion && d.copilotVersion) copilotVersion = String(d.copilotVersion);
                if (!firstModel && (d.selectedModel || d.model)) {
                    firstModel = String(d.selectedModel || d.model);
                }
                if (!firstMode && d.mode) firstMode = String(d.mode);
                break;
            case "session.model_change":
                if (!firstModel && d.newModel) firstModel = String(d.newModel);
                for (let j = i + 1; j < Math.min(events.length, i + 4); j++) {
                    const n = events[j];
                    if (n.type === "session.info" && n.data?.infoType === "model") {
                        modelChangesWithInfo.add(ev);
                        break;
                    }
                }
                break;
            case "session.mode_changed":
                // The mode before the first change is the session's
                // starting mode — what the CLI showed before any toggle.
                if (!firstMode && d.previousMode) firstMode = String(d.previousMode);
                if (openPlans.length) planModeChanges.add(ev);
                for (const p of openPlans) p.newMode = String(d.newMode || "");
                break;
            case "session.permissions_changed":
                allowAll = !!d.allowAllPermissions;
                for (const p of openPlans) p.allowAll = allowAll;
                break;
            case "tool.execution_start":
                if (d.toolCallId) toolStarts.set(d.toolCallId, ev);
                if (d.toolName === "exit_plan_mode" && d.toolCallId) {
                    const o = { toolCallId: d.toolCallId, newMode: "", allowAll };
                    planOutcomes.set(d.toolCallId, o);
                    openPlans.push(o);
                }
                break;
            case "tool.execution_complete":
                if (d.toolCallId) {
                    toolResults.set(d.toolCallId, ev);
                    const k = openPlans.findIndex((p) => p.toolCallId === d.toolCallId);
                    if (k >= 0) {
                        // Mode flips land right after approval; keep
                        // listening briefly for the matching change.
                        const o = openPlans[k];
                        for (let j = i + 1; j < Math.min(events.length, i + 6) && !o.newMode; j++) {
                            const n = events[j];
                            if (n.type === "session.mode_changed") {
                                o.newMode = String(n.data?.newMode || "");
                                planModeChanges.add(n);
                            }
                            if (n.type === "session.permissions_changed") o.allowAll = !!n.data?.allowAllPermissions;
                        }
                        openPlans.splice(k, 1);
                    }
                }
                break;
            case "human_response.recorded":
                if (d.toolCallId) {
                    humanResponses.set(d.toolCallId, d);
                    const o = planOutcomes.get(d.toolCallId);
                    if (o && d.response?.feedback) o.feedback = String(d.response.feedback);
                }
                break;
            case "subagent.started":
                if (d.toolCallId) subagents.set(d.toolCallId, { ...(subagents.get(d.toolCallId) || {}), started: d });
                break;
            case "subagent.completed":
            case "subagent.failed":
                if (d.toolCallId) subagents.set(d.toolCallId, { ...(subagents.get(d.toolCallId) || {}), completed: d });
                break;
            case "assistant.turn_end": {
                if (d.parentToolCallId) break;
                // Idle once the turn ends and no further assistant turn
                // starts before the next prompt (or the end of the log).
                let idle = true;
                for (let j = i + 1; j < events.length; j++) {
                    const n = events[j];
                    if (n.type === "assistant.turn_start" && !n.data?.parentToolCallId) {
                        idle = false;
                        break;
                    }
                    if (n.type === "user.message" && String(n.data?.content ?? "").trim() && !n.data?.isAutopilotContinuation) break;
                }
                if (idle) idleAfter.add(i);
                break;
            }
            default:
                break;
        }
        if (ev.type === "assistant.message" && !d.parentToolCallId && d.reasoningText) {
            if (lastAnchorTs != null && Number.isFinite(ts)) thinkMs.set(ev, ts - lastAnchorTs);
        }
        if (ANCHOR_TYPES.has(ev.type) && !d.parentToolCallId && Number.isFinite(ts)) {
            lastAnchorTs = ts;
        }
    }
    return {
        toolResults,
        toolStarts,
        humanResponses,
        subagents,
        planOutcomes,
        thinkMs,
        modelChangesWithInfo,
        planModeChanges,
        idleAfter,
        firstModel,
        firstMode,
        cwd,
        branch,
        copilotVersion,
        sessionId: opts.sessionId || "",
    };
}
