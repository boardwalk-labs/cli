#!/usr/bin/env node
// SPDX-License-Identifier: MIT

// Thin shim → the compiled CLI entrypoint. Kept JS (not TS) so the published `bin` runs without a
// build step on the consumer's machine; `dist/index.js` is produced by `pnpm build`.
import "../dist/index.js";
