// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import type { RunEvent } from "@boardwalk-labs/workflow";
import { CHANNELS, DEFAULT_CHANNELS } from "@boardwalk-labs/workflow";
import { createRenderer, parseChannels } from "./renderer.js";

function event(body: Record<string, unknown>): RunEvent {
  return { runId: "r1", turnId: "t1", seq: 1, t: 0, ...body } as unknown as RunEvent;
}

function rendered(channels: ReturnType<typeof parseChannels>, events: RunEvent[]): string {
  let out = "";
  const renderer = createRenderer(channels, (text) => {
    out += text;
  });
  for (const e of events) renderer.render(e);
  return out;
}

describe("parseChannels", () => {
  it("defaults to lifecycle + phase + output", () => {
    expect(parseChannels({ verbose: false })).toEqual(DEFAULT_CHANNELS);
  });

  it("--verbose subscribes to every channel", () => {
    expect(parseChannels({ verbose: true })).toEqual(CHANNELS);
  });

  it("--stream parses an explicit comma-separated list (deduped, trimmed)", () => {
    expect(parseChannels({ verbose: false, stream: " output , phase ,output" })).toEqual([
      "output",
      "phase",
    ]);
  });

  it("rejects an unknown channel with the valid list", () => {
    expect(() => parseChannels({ verbose: false, stream: "outputs" })).toThrow(/Unknown channel/);
  });

  it("rejects --verbose combined with --stream", () => {
    expect(() => parseChannels({ verbose: true, stream: "output" })).toThrow(/not both/);
  });

  it("rejects an empty --stream", () => {
    expect(() => parseChannels({ verbose: false, stream: " , " })).toThrow(/at least one/);
  });
});

describe("createRenderer", () => {
  it("renders only subscribed channels", () => {
    const events = [
      event({ kind: "run_status", status: "running" }),
      event({ kind: "phase", name: "Fetch", id: "p1" }),
      event({ kind: "program_output", stream: "stdout", text: "noise\n" }),
      event({ kind: "output", value: { ok: true } }),
    ];
    const out = rendered(parseChannels({ verbose: false }), events);
    expect(out).toContain("● workflow running");
    expect(out).toContain("▸ Fetch");
    expect(out).toContain('"ok": true');
    expect(out).not.toContain("noise");
  });

  it("prints the bare value when subscribed to output only (pipe-friendly)", () => {
    const out = rendered(parseChannels({ verbose: false, stream: "output" }), [
      event({ kind: "run_status", status: "running" }),
      event({ kind: "output", value: "plain result" }),
    ]);
    expect(out).toBe("plain result\n");
  });

  it("includes the failure error on a failed run_status", () => {
    const out = rendered(parseChannels({ verbose: false }), [
      event({
        kind: "run_status",
        status: "failed",
        error: { code: "PROGRAM_ERROR", message: "boom" },
      }),
    ]);
    expect(out).toContain("● workflow failed");
    expect(out).toContain("PROGRAM_ERROR: boom");
  });

  it("streams agent text deltas raw under --verbose", () => {
    const out = rendered(parseChannels({ verbose: true }), [
      event({ kind: "turn_started" }),
      event({ kind: "text_start", blockId: "b" }),
      event({ kind: "text_delta", blockId: "b", text: "Hel" }),
      event({ kind: "text_delta", blockId: "b", text: "lo" }),
      event({ kind: "text_end", blockId: "b" }),
      event({ kind: "turn_ended", reason: "complete", usage: { totalTokens: 7 } }),
    ]);
    expect(out).toContain("· agent turn started");
    expect(out).toContain("Hello\n");
    expect(out).toContain("· agent turn complete (7 tokens)");
  });

  it("passes program output through verbatim on the log channel", () => {
    const out = rendered(parseChannels({ verbose: false, stream: "log" }), [
      event({ kind: "program_output", stream: "stderr", text: "warn: x\n" }),
      event({ kind: "output", value: "hidden" }),
    ]);
    expect(out).toBe("warn: x\n");
  });

  it("renders an egress denial with the method, host, and reason", () => {
    const out = rendered(parseChannels({ verbose: true }), [
      event({
        kind: "egress_denied",
        method: "GET",
        host: "blocked-host.example.com",
        reason: "not in the allowlist",
      }),
    ]);
    expect(out).toBe("⊘ egress denied: GET blocked-host.example.com — not in the allowlist\n");
  });

  it("terminates newline-less program output frames so console.log lines never run together", () => {
    // The hosted runner emits one frame per console call with NO trailing newline; without
    // normalization consecutive lines concatenate ("diff chars=25729repo-two: 1 commit(s)").
    const out = rendered(parseChannels({ verbose: false, stream: "log" }), [
      event({ kind: "program_output", stream: "stdout", text: "repo-one: 3 commit(s)" }),
      event({ kind: "program_output", stream: "stdout", text: "repo-two: 1 commit(s)" }),
    ]);
    expect(out).toBe("repo-one: 3 commit(s)\nrepo-two: 1 commit(s)\n");
  });
});
