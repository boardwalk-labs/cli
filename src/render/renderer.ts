// SPDX-License-Identifier: MIT

// The run-event renderer — one renderer for `boardwalk dev` (and, later, `run --wait` streaming),
// driven entirely by the SDK's channel mapping so `--stream phase,output` means the same thing
// everywhere.
//
// Line-oriented and pipe-friendly: agent text/reasoning deltas stream raw (no per-delta prefix);
// everything else renders as one prefixed line. When the subscription is EXACTLY the `output`
// channel, the output value prints bare (no decoration) so `boardwalk dev --stream output | jq`
// just works.

import {
  CHANNELS,
  DEFAULT_CHANNELS,
  matchesChannels,
  type Channel,
  type RunEvent,
} from "@boardwalk-labs/workflow";
import { CliError } from "../errors.js";

export interface ChannelFlags {
  /** `--verbose`: subscribe to every channel. */
  verbose: boolean;
  /** `--stream <channels>`: explicit comma-separated channel list. */
  stream?: string | undefined;
}

/** Resolve `--verbose` / `--stream` to a channel subscription (default: lifecycle+phase+output). */
export function parseChannels(flags: ChannelFlags): readonly Channel[] {
  if (flags.verbose && flags.stream !== undefined) {
    throw new CliError("Use either --verbose or --stream <channels>, not both.");
  }
  if (flags.verbose) return CHANNELS;
  if (flags.stream === undefined) return DEFAULT_CHANNELS;

  const names = flags.stream
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) {
    throw new CliError(`--stream needs at least one channel (${CHANNELS.join(", ")}).`);
  }
  const out: Channel[] = [];
  for (const name of names) {
    if (!isChannel(name)) {
      throw new CliError(
        `Unknown channel "${name}".`,
        `Valid channels: ${CHANNELS.join(", ")} (or --verbose for all).`,
      );
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Narrow a raw `--stream` token to a known {@link Channel} (predicate, no cast). */
function isChannel(name: string): name is Channel {
  return CHANNELS.some((c) => c === name);
}

export interface EventRenderer {
  /** Render one event to the writer iff it matches the subscription. */
  render(event: RunEvent): void;
}

/**
 * Build the renderer. `write` receives raw text (newlines included where intended) — pass
 * `process.stdout.write` in the CLI, an accumulator in tests.
 */
export function createRenderer(
  channels: readonly Channel[],
  write: (text: string) => void,
): EventRenderer {
  const outputOnly = channels.length === 1 && channels[0] === "output";

  return {
    render(event: RunEvent): void {
      if (!matchesChannels(event, channels)) return;
      const text = formatEvent(event, outputOnly);
      if (text !== null) write(text);
    },
  };
}

/**
 * A renderer that emits every event as one line of NDJSON (no channel filtering, no ANSI) — the
 * machine-readable counterpart of {@link createRenderer}, for `runs --logs/--follow --json-stream`.
 * One `write` per event, so a pipe/`tail -f` sees each event as soon as it arrives.
 */
export function createJsonLineRenderer(write: (text: string) => void): EventRenderer {
  return {
    render(event: RunEvent): void {
      write(`${JSON.stringify(event)}\n`);
    },
  };
}

function formatEvent(event: RunEvent, outputOnly: boolean): string | null {
  switch (event.kind) {
    case "run_status": {
      const line = `● workflow ${event.status}`;
      if (event.error !== undefined) {
        return `${line}\n  ${event.error.code}: ${event.error.message}\n`;
      }
      return `${line}\n`;
    }
    case "phase":
      return `▸ ${event.name}\n`;
    case "output": {
      const value = formatOutputValue(event.value);
      return outputOnly ? `${value}\n` : `── output ──\n${value}\n`;
    }
    case "program_output":
      // Captured stdout/stderr. Producers differ on framing — the hosted runner emits one frame
      // per console call WITHOUT a trailing newline; the self-host engine forwards raw stdout
      // chunks WITH them — so terminate the frame unless it already is (otherwise consecutive
      // `console.log` lines run together on one line).
      return event.text.endsWith("\n") ? event.text : `${event.text}\n`;
    case "turn_started":
      return "· agent turn started\n";
    case "turn_ended": {
      const usage = event.usage;
      const tokens =
        usage?.totalTokens !== undefined ? ` (${String(usage.totalTokens)} tokens)` : "";
      const error = event.error !== undefined ? ` — ${event.error.message}` : "";
      return `· agent turn ${event.reason}${tokens}${error}\n`;
    }
    case "text_delta":
    case "reasoning_delta":
      return event.text; // stream raw — the model's words ARE the output here
    case "text_end":
      return "\n";
    case "tool_call_start":
      return `· tool ${event.toolName} …\n`;
    case "tool_call_result": {
      const summary = event.result.humanSummary ?? event.result.kind ?? "done";
      return `· tool result: ${summary}\n`;
    }
    case "tool_call_error":
      return `· tool error: ${event.error.message}\n`;
    case "tool_output_delta":
      return event.text; // stream a tool's incremental stdout/stderr verbatim (e.g. a long bash run)
    case "suspended": {
      const when =
        event.wakeAt !== undefined
          ? ` until ${new Date(event.wakeAt).toISOString()}`
          : event.reason === "human_input"
            ? " awaiting human input"
            : "";
      return `⏸ suspended (${event.reason})${when}\n`;
    }
    case "resumed":
      return "▶ resumed\n";
    case "egress_denied":
      // The platform egress proxy blocked an outbound request — surface WHY the fetch failed so
      // the author isn't staring at an opaque network error.
      return `⊘ egress denied: ${event.method !== undefined ? `${event.method} ` : ""}${event.host} — ${event.reason}\n`;
    case "human_input_requested":
      return `⏸ input needed [${event.key}]: ${event.prompt}\n`;
    case "human_input_resolved":
      return `▶ input received [${event.key}]\n`;
    case "compaction_started": {
      // The leaf is reducing its own context to fit the model's window. Say what tripped it, and the
      // window when known — absent means the leaf never learned one and the budget is the fallback.
      const win =
        event.contextTokens !== undefined
          ? ` for a ${event.contextTokens.toLocaleString("en-US")}-token window`
          : "";
      return `⊟ compacting context: ${event.tokens.toLocaleString("en-US")} tokens, past the ${event.budget.toLocaleString("en-US")} budget${win}\n`;
    }
    case "compaction_ended": {
      // `none` is not a failure — the loop proceeds without reclaiming; every turn means thrashing.
      const freed = event.reclaimed.toLocaleString("en-US");
      const now = event.tokens.toLocaleString("en-US");
      const what =
        event.method === "summarized"
          ? `summarized the oldest turns, freed ${freed} tokens`
          : event.method === "deduped"
            ? `dropped stale repeated reads, freed ${freed} tokens`
            : "nothing left to reclaim";
      return `▣ compaction done: ${what} — now ${now} tokens\n`;
    }
    // Structural agent frames with nothing human-readable to print:
    case "text_start":
    case "tool_call_input_delta":
    case "tool_call_input_complete":
    case "tool_call_executing":
      return null;
  }
}

/** Render an `output(...)` value for display: strings verbatim, everything else pretty JSON. Shared
 *  by the live renderer and `boardwalk run`'s result block so both surface output identically. */
export function formatOutputValue(value: unknown): string {
  if (typeof value === "string") return value;
  // JSON.stringify returns undefined at runtime for undefined/functions (its types lie).
  if (value === undefined) return "null";
  return JSON.stringify(value, null, 2);
}
