// SPDX-License-Identifier: MIT

// Import a module by a NON-STATIC specifier so Bun's single-file compiler (`bun build --compile`)
// does NOT bundle it into the binary — `import("literal")` would be. This is load-bearing for the
// local-engine commands (`dev`, `runner`): their dependency graph (@boardwalk-labs/engine,
// @boardwalk-labs/runner) pulls Node-only builtins (`node:sqlite`) that Bun can't provide, and Bun
// EAGERLY resolves every bundled module's imports at binary startup — so bundling them would crash
// EVERY command, not just those two. Excluding them keeps the control-plane commands working in the
// binary; the callers `assertNodeRuntime()` first, so under the binary the user gets a clear pointer
// to the Node build instead of a missing-module error. Under Node the specifier resolves normally.
//
// The type parameter restores full typing that a dynamic specifier otherwise erases: pass
// `lazyImport<typeof import("./commands/dev.js")>("./commands/dev.js")` — the `typeof import(...)` is
// a type-only reference (erased at emit, so it does NOT re-introduce the static import).
export async function lazyImport<T>(specifier: string): Promise<T> {
  const mod: unknown = await import(specifier);
  return mod as T;
}
