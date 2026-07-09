// SPDX-License-Identifier: MIT

// Minimal ambient types for the `Bun` global — present ONLY when the CLI runs as a Bun single-file
// executable (`bun build --compile`) or under `bun run`; `undefined` under Node. Declared here (a
// narrow subset of Bun.build) so `tsc` typechecks the Bun bundler branch in bundle.ts WITHOUT a
// dependency on `@types/bun`. Reference `Bun` only behind `typeof Bun !== "undefined"` — under Node
// it is an undeclared global, so a bare `Bun` reference would throw ReferenceError.

export {};

declare global {
  /** A single build output (extends Blob; `.text()` yields its contents). */
  interface BunBuildArtifact extends Blob {
    readonly path: string;
    readonly kind: "entry-point" | "chunk" | "asset" | "sourcemap" | "bytecode";
  }
  interface BunBuildOutput {
    readonly success: boolean;
    readonly outputs: readonly BunBuildArtifact[];
    readonly logs: readonly unknown[];
  }
  interface BunBuildConfig {
    entrypoints: readonly string[];
    target?: "node" | "bun" | "browser";
    format?: "esm" | "cjs" | "iife";
    external?: readonly string[];
    sourcemap?: "none" | "linked" | "inline" | "external";
    minify?: boolean;
  }

  var Bun:
    | undefined
    | {
        build(config: BunBuildConfig): Promise<BunBuildOutput>;
      };
}
