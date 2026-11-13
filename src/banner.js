// Version + ASCII splash banner.

import { readFileSync } from "node:fs";
import { fg } from "./ansi.js";

export function getVersion() {
    try {
        const pkg = JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
        );
        return pkg.version || "0.0.0";
    } catch {
        return "0.0.0";
    }
}

// ASCII "Shadow" block font (public-domain figlet font).
export const BANNER_COPILOT = [
    " ██████╗ ██████╗ ██████╗ ██╗██╗      ██████╗ ████████╗",
    "██╔════╝██╔═══██╗██╔══██╗██║██║     ██╔═══██╗╚══██╔══╝",
    "██║     ██║   ██║██████╔╝██║██║     ██║   ██║   ██║   ",
    "██║     ██║   ██║██╔═══╝ ██║██║     ██║   ██║   ██║   ",
    "╚██████╗╚██████╔╝██║     ██║███████╗╚██████╔╝   ██║   ",
    " ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝ ╚═════╝    ╚═╝   ",
];

export const BANNER_REPLAY = [
    "██████╗ ███████╗██████╗ ██╗      █████╗ ██╗   ██╗",
    "██╔══██╗██╔════╝██╔══██╗██║     ██╔══██╗╚██╗ ██╔╝",
    "██████╔╝█████╗  ██████╔╝██║     ███████║ ╚████╔╝ ",
    "██╔══██╗██╔══╝  ██╔═══╝ ██║     ██╔══██║  ╚██╔╝  ",
    "██║  ██║███████╗██║     ███████╗██║  ██║   ██║   ",
    "╚═╝  ╚═╝╚══════╝╚═╝     ╚══════╝╚═╝  ╚═╝   ╚═╝   ",
];

export function renderSplashLines() {
    const out = [];
    const pad = "  ";
    out.push("");
    for (const ln of BANNER_COPILOT) out.push(pad + fg.blue(ln));
    for (const ln of BANNER_REPLAY) out.push(pad + fg.magenta(ln));
    out.push("");
    out.push(
        pad +
            fg.bold(fg.white("Copilot Replay")) +
            fg.gray(`  v${getVersion()}`),
    );
    out.push(
        pad +
            fg.gray("made by ") +
            fg.white("Lukas Lundin") +
            fg.gray(", Software Solution Engineer, Microsoft"),
    );
    return out;
}

function mascotRows() {
    const head = fg.mascotHead;
    return [
        fg.mascotGoggles("╭─╮╭─╮"),
        fg.mascotGoggles("╰─╯╰─╯"),
        `${head("█ ")}${fg.mascotEyes("▘▝")}${head(" █")}`,
        head(" ▔▔▔▔ "),
    ];
}

function compactCount(n) {
    if (!Number.isFinite(n)) return "0";
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(Math.round(n));
}

function shortDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The summary the CLI prints when you exit (mascot + Changes / AI
// Credits / Tokens / Resume), built from the recorded session.shutdown.
export function renderExitSummaryLines(shutdown, sessionId, endTimestamp) {
    const d = shutdown || {};
    const rows = [];
    const cc = d.codeChanges || {};
    rows.push([
        "Changes",
        `${fg.green(`+${cc.linesAdded ?? 0}`)} ${fg.red(`-${cc.linesRemoved ?? 0}`)}`,
    ]);
    const nano = Number(d.totalNanoAiu ?? d.accountingSnapshot?.totalNanoAiu);
    if (Number.isFinite(nano) && nano > 0) {
        const start = Number(d.sessionStartTime);
        const end = Date.parse(endTimestamp);
        const dur = Number.isFinite(start) && Number.isFinite(end) && end > start
            ? ` ${fg.gray(`(${shortDuration(end - start)})`)}`
            : "";
        rows.push(["AI Credits", `${fg.white((nano / 1e9).toFixed(2))}${dur}`]);
    } else if (Number.isFinite(d.totalPremiumRequests)) {
        rows.push(["Requests", fg.white(String(d.totalPremiumRequests))]);
    }
    const td = d.tokenDetails || d.accountingSnapshot?.tokenDetails;
    if (td) {
        const cached = td.cache_read?.tokenCount ?? 0;
        const written = td.cache_write?.tokenCount ?? 0;
        const up = (td.input?.tokenCount ?? 0) + cached + written;
        const down = td.output?.tokenCount ?? 0;
        rows.push([
            "Tokens",
            `${fg.white(`↑ ${compactCount(up)}`)} ${fg.gray(`(${compactCount(cached)} cached, ${compactCount(written)} written)`)}` +
                ` ${fg.gray("•")} ${fg.white(`↓ ${compactCount(down)}`)}`,
        ]);
    }
    if (sessionId) rows.push(["Resume", fg.white(`copilot --resume=${sessionId}`)]);
    const mascot = mascotRows();
    const n = Math.max(mascot.length, rows.length);
    const out = [""];
    for (let i = 0; i < n; i++) {
        const m = mascot[i] ?? "      ";
        const r = rows[i];
        out.push(`  ${m}   ${r ? `${fg.gray(r[0].padEnd(10))} ${r[1]}` : ""}`.trimEnd());
    }
    out.push("");
    return out;
}

// The Copilot CLI app header (CLI 1.0.64+): the little goggled mascot
// next to the "Copilot vX uses AI. Check for mistakes." caption, padded
// two columns from the left edge. Mirrors the CLI's AppHeader +
// Mascot components. `version` is the CLI version that recorded the
// session (session.start.copilotVersion) so a replay shows the same
// header the presenter saw. Returns pre-colored lines for writeln().
export function renderCliBannerLines(version) {
    const v = String(version || "").replace(/\.unstable\..*$/, "") || getVersion();
    const pad = "  ";
    const mascot = mascotRows();
    const caption = [
        "",
        fg.gray(`Copilot v${v} uses AI.`),
        fg.gray("Check for mistakes."),
        "",
    ];
    return mascot.map((m, i) =>
        `${pad}${m}${caption[i] ? `  ${caption[i]}` : ""}`.trimEnd(),
    );
}
