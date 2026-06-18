// SPDX-License-Identifier: MIT

// resolveLog / resolveErrLog — the shared line sinks for commands. Every command takes an optional
// `log` in its deps so tests can capture output; these fall back to stdout / stderr when none is
// injected. One place for the fallback, so commands don't each re-inline the `deps.log ?? …` dance.

/** A command's deps always carry an optional line sink. */
interface HasLog {
  log?: (line: string) => void;
}

/** Resolve a command's stdout sink: the injected `deps.log`, else `console.log`. */
export function resolveLog(deps: HasLog): (line: string) => void {
  return (
    deps.log ??
    ((line: string): void => {
      console.log(line);
    })
  );
}

/**
 * Resolve a STDERR sink: the injected `deps.log`, else `console.error`. Use for diagnostics that
 * must not pollute a command's stdout payload (e.g. a streamed event feed).
 */
export function resolveErrLog(deps: HasLog): (line: string) => void {
  return (
    deps.log ??
    ((line: string): void => {
      console.error(line);
    })
  );
}
