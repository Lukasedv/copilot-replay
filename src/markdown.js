// Minimal markdown → ANSI renderer.
//
// Supports: headings, blockquotes, ordered + unordered lists, fenced code
// blocks, and inline bold / italic / inline-code / links. Intentionally
// simple — fancier constructs (tables, nested lists with mixed markers,
// reference links) are not supported, we just want the assistant replies to
// read nicely instead of as raw markdown characters.

import { fg } from "./ansi.js";
import { wrapLines } from "./format.js";

// Apply inline markdown to a single line: **bold**, *italic*, `code`,
// [text](url).
export function renderMdInline(s) {
    // Links first — replace with styled text so later passes don't touch them.
    s = s.replace(
        /\[([^\]\n]+)\]\(([^)\n]+)\)/g,
        (_, t, u) => `${fg.blue(t)}${fg.dim(fg.gray(` (${u})`))}`,
    );
    // Inline code `code`
    s = s.replace(/`([^`\n]+)`/g, (_, t) => fg.yellow(t));
    // Bold **text**
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, (_, t) => fg.bold(t));
    // Italic *text* — only when surrounded by whitespace/punctuation so we
    // don't mangle `**` leftovers or `a*b*c` style glob patterns.
    s = s.replace(
        /(^|[\s(\[{>"'])\*([^*\n]+?)\*(?=[\s.,;:!?)\]}"']|$)/g,
        (_, pre, t) => `${pre}\x1b[3m${t}\x1b[23m`,
    );
    return s;
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
            for (const w of wrapLines(raw, indent)) yield fg.dim(fg.gray(w));
            continue;
        }
        const trimmed = trimmedRight;
        if (trimmed === "") {
            yield "";
            continue;
        }

        let m;
        if ((m = trimmed.match(/^(#{1,6})\s+(.*)$/))) {
            for (const w of wrapLines(m[2], indent)) yield fg.bold(fg.cyan(w));
            continue;
        }
        if ((m = trimmed.match(/^>\s?(.*)$/))) {
            const body = wrapLines(m[1], indent + 2);
            for (const w of body) {
                yield `${fg.gray("│")} ${fg.dim(renderMdInline(w))}`;
            }
            continue;
        }
        if ((m = trimmed.match(/^(\s*)[-*+]\s+(.*)$/))) {
            const lead = m[1];
            const body = wrapLines(m[2], indent + lead.length + 2);
            for (let i = 0; i < body.length; i++) {
                yield i === 0
                    ? `${lead}${fg.cyan("•")} ${renderMdInline(body[i])}`
                    : `${lead}  ${renderMdInline(body[i])}`;
            }
            continue;
        }
        if ((m = trimmed.match(/^(\s*)(\d+[.)])\s+(.*)$/))) {
            const lead = m[1];
            const marker = m[2];
            const body = wrapLines(
                m[3],
                indent + lead.length + marker.length + 1,
            );
            for (let i = 0; i < body.length; i++) {
                yield i === 0
                    ? `${lead}${fg.cyan(marker)} ${renderMdInline(body[i])}`
                    : `${lead}${" ".repeat(marker.length + 1)}${renderMdInline(body[i])}`;
            }
            continue;
        }
        for (const w of wrapLines(trimmed, indent)) yield renderMdInline(w);
    }
}
