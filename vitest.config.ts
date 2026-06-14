// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      // Honest floors ~7pt below current actual (lines/stmts 77, branches 83, funcs 93) — a
      // regression guard, not the aspiration. `pnpm test` runs with --coverage so CI enforces these.
      thresholds: {
        lines: 70,
        functions: 85,
        statements: 70,
        branches: 75,
      },
    },
  },
});
