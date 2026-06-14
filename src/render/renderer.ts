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
      // Captured stdout/stderr passes through verbatim (it carries its own newlines).
      return event.text;
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
    // Structural agent frames with nothing human-readable to print:
    case "text_start":
    case "tool_call_input_delta":
    case "tool_call_input_complete":
    case "tool_call_executing":
      return null;
  }
}

function formatOutputValue(value: unknown): string {
  if (typeof value === "string") return value;
  // JSON.stringify returns undefined at runtime for undefined/functions (its types lie).
  if (value === undefined) return "null";
  return JSON.stringify(value, null, 2);
}
