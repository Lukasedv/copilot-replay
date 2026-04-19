#!/usr/bin/env node
// copilot-replay — replay a GitHub Copilot CLI session from its events.jsonl
// at a controllable speed. Reads only; never contacts the Copilot service.
//
// See src/cli.js for the actual implementation.

import { main } from "../src/cli.js";
import { layout } from "../src/layout.js";

main().catch((err) => {
    try {
        layout.disable();
    } catch {}
    process.stderr.write(
        `copilot-replay: ${err?.stack || err?.message || err}\n`,
    );
    process.exit(1);
});
