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
