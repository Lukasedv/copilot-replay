// Minimal markdown → ANSI renderer.
//
// Supports: headings, blockquotes, ordered + unordered lists, fenced code
// blocks, and inline bold / italic / inline-code / links. Intentionally
// simple — fancier constructs (tables, nested lists with mixed markers,
// reference links) are not supported, we just want the assistant replies to
// read nicely instead of as raw markdown characters.
//
// Inline code renders as a padded "chip" on the theme's inline-code
// background, like the Copilot CLI (1.0.100+). Links render as their
// text in the link color, without the raw URL.

import { ANSI_RESET, bgOpen, fg, fgOpen } from "./ansi.js";
import { wrapLines } from "./format.js";

// Private-use sentinels: inline code is turned into CHIP_OPEN … CHIP_CLOSE
// (with NBSP-protected inner spaces) *before* wrapping, so wrapLines
// accounts for the chip's padding and never splits a chip across lines.
const CHIP_OPEN = "\uE000";
const CHIP_CLOSE = "\uE001";
const NBSP = "\uE002";

function protectInlineCode(s) {
    return s.replace(
        /`([^`\n]+)`/g,
        (_, t) => `${CHIP_OPEN}${NBSP}${t.replace(/ /g, NBSP)}${NBSP}${CHIP_CLOSE}`,
    );
}

function chip(t) {
    const open = bgOpen("code");
    const text = t.replace(new RegExp(NBSP, "g"), " ");
    if (!open) return text;
    return `${open}${fgOpen("white")}${text}${ANSI_RESET}`;
}

// Apply inline markdown to a single line: **bold**, *italic*, `code`,
// [text](url).
export function renderMdInline(s) {
    s = protectInlineCode(s);
    s = s.replace(
        /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
        (_, t) => fg.link(t),
    );
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_, t) => fg.bold(t));
    // Italic *text* — only when surrounded by whitespace/punctuation so we
    // don't mangle `**` leftovers or `a*b*c` style glob patterns.
    s = s.replace(
        /(^|[\s(\[{>"'])\*([^*\n]+?)\*(?=[\s.,;:!?)\]}"']|$)/g,
        (_, pre, t) => `${pre}${fg.italic(t)}`,
    );
    s = s.replace(
        new RegExp(`${CHIP_OPEN}([^${CHIP_CLOSE}]*)${CHIP_CLOSE}`, "g"),
        (_, t) => chip(t),
    );
    return s.replace(new RegExp(NBSP, "g"), " ");
}

// Wrap a markdown line while counting inline-code chips at their padded
// width. Returned fragments still contain markdown; feed them to
// renderMdInline.
function wrapMd(text, indent) {
    return wrapLines(protectInlineCode(text), indent).map((w) =>
        w
            .replace(
                new RegExp(`${CHIP_OPEN}${NBSP}([^${CHIP_CLOSE}]*)${NBSP}${CHIP_CLOSE}`, "g"),
                (_, t) => "`" + t.replace(new RegExp(NBSP, "g"), " ") + "`",
            ),
    );
}

// Yields rendered, wrapped markdown lines ready to be writeln'd with the
// given indent (number of spaces reserved at the left).
export function* renderMarkdownLines(text, indent = 2) {
    let inFence = false;
    for (const raw of String(text).split("\n")) {
        const trimmedRight = raw.replace(/\s+$/, "");
        if (/^\s*```/.test(trimmedRight)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            for (const w of wrapLines(raw, indent)) yield fg.gray(w);
            continue;
        }
        const trimmed = trimmedRight;
        if (trimmed === "") {
            yield "";
            continue;
        }

        let m;
        if ((m = trimmed.match(/^(#{1,6})\s+(.*)$/))) {
            for (const w of wrapMd(m[2], indent)) {
                yield fg.bold(renderMdInline(w));
            }
            continue;
        }
        if ((m = trimmed.match(/^>\s?(.*)$/))) {
            const body = wrapMd(m[1], indent + 2);
            for (const w of body) {
                yield `${fg.gray("│")} ${fg.gray(renderMdInline(w))}`;
            }
            continue;
        }
        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(trimmed)) {
            yield fg.dim("─".repeat(Math.max(3, Math.min(40, 80 - indent))));
            continue;
        }
        if ((m = trimmed.match(/^(\s*)[-*+]\s+(.*)$/))) {
            const lead = m[1];
            const body = wrapMd(m[2], indent + lead.length + 2);
            for (let i = 0; i < body.length; i++) {
                yield i === 0
                    ? `${lead}${fg.gray("-")} ${renderMdInline(body[i])}`
                    : `${lead}  ${renderMdInline(body[i])}`;
            }
            continue;
        }
        if ((m = trimmed.match(/^(\s*)(\d+[.)])\s+(.*)$/))) {
            const lead = m[1];
            const marker = m[2];
            const body = wrapMd(
                m[3],
                indent + lead.length + marker.length + 1,
            );
            for (let i = 0; i < body.length; i++) {
                yield i === 0
                    ? `${lead}${fg.gray(marker)} ${renderMdInline(body[i])}`
                    : `${lead}${" ".repeat(marker.length + 1)}${renderMdInline(body[i])}`;
            }
            continue;
        }
        for (const w of wrapMd(trimmed, indent)) yield renderMdInline(w);
    }
}
