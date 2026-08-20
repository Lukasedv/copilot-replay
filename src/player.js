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
import { describeEvent } from "./render.js";
import { renderCliBannerLines } from "./banner.js";

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

        // Pair tool_start with its matching tool_complete for inline
        // rendering. Also discover the session's first model for the
        // animated "Starting replay…" header.
        const toolResults = new Map();
        const reasoningDurations = new Map();
        const startData =
            events.find((event) => event.type === "session.start")?.data || {};
        let firstModel = startData.selectedModel || startData.model || "";
        let firstMode = "";
        let turnStartedAt = null;
        for (const ev of events) {
            if (ev.type === "tool.execution_complete" && ev.data?.toolCallId) {
                toolResults.set(ev.data.toolCallId, ev);
            }
            if (ev.type === "assistant.turn_start") {
                const timestamp = Date.parse(ev.timestamp);
                turnStartedAt = Number.isFinite(timestamp) ? timestamp : null;
            }
            if (ev.type === "assistant.reasoning" && turnStartedAt != null) {
                const timestamp = Date.parse(ev.timestamp);
                if (Number.isFinite(timestamp)) {
                    reasoningDurations.set(ev.id, timestamp - turnStartedAt);
                }
            }
            if (ev.type === "assistant.turn_end") turnStartedAt = null;
            if (
                !firstModel &&
                ev.type === "session.model_change" &&
                ev.data?.newModel
            ) {
                firstModel = ev.data.newModel;
            }
            if (
                !firstMode &&
                ev.type === "session.mode_changed" &&
                ev.data?.previousMode
            ) {
                // The mode before the first change is the session's
                // starting mode — that's what the CLI would have
                // displayed before any user toggle.
                firstMode = ev.data.previousMode;
            }
            if (
                !firstMode &&
                ev.type === "session.start" &&
                ev.data?.mode
            ) {
                firstMode = ev.data.mode;
            }
        }
        const ctx = {
            toolResults,
            reasoningDurations,
            firstModel,
            sessionId: opts.sessionId || "",
        };

        const cwdFromSession = startData.context?.cwd || "";
        const cwdText = cwdFromSession.replace(homedir(), "~");
        // Configure cli-mode BEFORE enabling the layout so the first
        // draw uses the correct (smaller) chrome height — otherwise
        // layout.enable() lays out for 4 chrome rows and the shrink to
        // 2 leaves stale cwd/rule rows above the gray input panel.
        if (opts.cliMode) {
            layout.setCliMode(true, firstModel || "");
            layout.setSessionInfo({
                model: firstModel,
                branch: startData.context?.branch || "",
                reasoningEffort: startData.reasoningEffort || "",
                contextTier: startData.contextTier || "",
            });
            layout.setCliHeader(
                renderCliBannerLines(startData.copilotVersion || "unknown"),
            );
            if (firstMode) layout.setMode(firstMode);
        }
        layout.enable(cwdText);
        layout.setSpeed(this.speed);
        layout.setPaused(this.paused);

        // CLI mode starts at the current Copilot header and waits for the
        // first → press, then plays one user-prompt segment at a time.
        if (opts.cliMode && isTTY) {
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
            if (
                opts.cliMode &&
                isTTY &&
                ev.type === "user.message" &&
                !(ev.data?.source) &&
                this._rewindTo == null &&
                !this.stepNext &&
                !this.seekNext
            ) {
                if (this._cliBudget <= 0) {
                    this.paused = true;
                    layout.setPaused(true);
                    await this.waitForResume();
                    if (this.quitRequested) break;
                }
                if (this._cliBudget > 0) this._cliBudget--;
            }
            const render = describeEvent(ev, opts, ctx);
            if (!render) {
                i++;
                continue;
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

            if (!first && ev.type !== "user.message") writeln();
            first = false;
            if (ev.type === "user.message" && fastForward) {
                // Rewinding/stepping past a user.message: commit instantly.
                const c = (ev.data?.content ?? "").trim();
                if (c) layout.commitPrompt(c);
                this.currentPromptIndex = i;
            } else {
                if (ev.type === "user.message") this.currentPromptIndex = i;
                await render(this);
            }
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

        layout.disable();
        if (opts.cliMode) return;
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
            const c = (e.data?.content ?? "").trim();
            if (!c) continue;
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
        layout.clearTyped();
        if (layout.active) {
            layout.clearContent();
            layout.redrawCliHeader();
        }
        this._rewindTo = target;
    }
}
