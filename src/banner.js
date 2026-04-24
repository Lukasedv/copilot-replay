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

// Real-Copilot-CLI-style banner: rounded box with logo + header lines.
// Used by --cli-mode so the session opening looks like a fresh CLI
// launch rather than a replay. Returns an array of pre-colored lines
// suitable for writeln().
export function renderCliBannerLines() {
    const BOX_WIDTH = 60;
    const h = "─".repeat(BOX_WIDTH - 2);
    const content = [
        {
            text: `${fg.bold(fg.white("GitHub Copilot"))} ${fg.gray(`v${getVersion()}`)}`,
            plain: `GitHub Copilot v${getVersion()}`,
        },
        {
            text: fg.gray("Describe a task to get started."),
            plain: "Describe a task to get started.",
        },
        { text: "", plain: "" },
        {
            text: `${fg.gray("Tip:")} ${fg.cyan("/init")} ${fg.gray(
                "Initialize Copilot instructions for this repository.",
            )}`,
            plain: "Tip: /init Initialize Copilot instructions for this repository.",
        },
        {
            text: fg.gray("Copilot uses AI. Check for mistakes."),
            plain: "Copilot uses AI. Check for mistakes.",
        },
    ];

    const lines = [];
    lines.push(fg.magenta(`╭${h}╮`));
    for (const row of content) {
        const visible = row.plain.length;
        const padRight = Math.max(0, BOX_WIDTH - 4 - visible);
        lines.push(
            `${fg.magenta("│")} ${row.text}${" ".repeat(padRight)} ${fg.magenta("│")}`,
        );
    }
    lines.push(fg.magenta(`╰${h}╯`));
    return lines;
}
