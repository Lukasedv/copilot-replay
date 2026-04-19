// Low-level stdout helpers.
//
// When the sticky `Layout` is active, `write` / `writeln` park the cursor at
// the bottom of the scroll region before emitting so that trailing newlines
// scroll the replay content instead of drawing over the footer. `rawWrite`
// bypasses that and is used by the layout / animation code to paint specific
// rows directly.

import process from "node:process";

export const STREAM = process.stdout;

let layoutRef = null;

/** Called by `layout.js` to register the active Layout singleton. */
export function setLayoutRef(ref) {
    layoutRef = ref;
}

export function rawWrite(s) {
    STREAM.write(s);
}

export function write(s) {
    if (layoutRef && layoutRef.active) {
        STREAM.write(`\x1b[${layoutRef.scrollBottomRow};1H`);
    }
    STREAM.write(s);
}

export function writeln(s = "") {
    if (layoutRef && layoutRef.active) {
        STREAM.write(`\x1b[${layoutRef.scrollBottomRow};1H`);
        STREAM.write(s + "\n");
    } else {
        STREAM.write(s + "\n");
    }
}

/** Reasonable column width for wrap calculations. */
export function width() {
    return STREAM.columns && STREAM.columns > 40 ? STREAM.columns : 100;
}
