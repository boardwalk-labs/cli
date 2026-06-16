// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { parseSseFrames, readSseFrames, type SseFrame } from "./sse.js";

/** Feed a list of string chunks as an async iterable (each yielded on a microtask). */
async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const p of parts) yield await Promise.resolve(p);
}

async function collect(source: AsyncGenerator<SseFrame>): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const f of source) out.push(f);
  return out;
}

describe("parseSseFrames", () => {
  it("parses one frame with id, event, and data", async () => {
    const frames = await collect(parseSseFrames(chunks('id: 42\nevent: phase\ndata: {"a":1}\n\n')));
    expect(frames).toEqual([{ id: "42", event: "phase", data: '{"a":1}' }]);
  });

  it("joins multiple data: lines with newlines", async () => {
    const frames = await collect(parseSseFrames(chunks("data: line1\ndata: line2\n\n")));
    expect(frames).toEqual([{ data: "line1\nline2" }]);
  });

  it("strips exactly one leading space after the colon", async () => {
    const frames = await collect(parseSseFrames(chunks("data:  two-spaces\n\n")));
    expect(frames[0]?.data).toBe(" two-spaces"); // one space stripped, one kept
  });

  it("ignores comment/heartbeat lines and a data-less retry block (no dispatch)", async () => {
    const frames = await collect(
      parseSseFrames(chunks(": hb\nretry: 1000\n\nevent: x\ndata: y\n\n")),
    );
    // Only the block carrying `data` dispatches; the comment + retry-only block is a no-op.
    expect(frames).toEqual([{ event: "x", data: "y" }]);
  });

  it("dispatches the trailing frame even without a final blank line", async () => {
    const frames = await collect(parseSseFrames(chunks("event: done\ndata: bye")));
    expect(frames).toEqual([{ event: "done", data: "bye" }]);
  });

  it("reassembles frames split across chunk boundaries", async () => {
    const frames = await collect(
      parseSseFrames(chunks("id: 1\nev", "ent: phase\nda", "ta: hi\n\n")),
    );
    expect(frames).toEqual([{ id: "1", event: "phase", data: "hi" }]);
  });

  it("handles CRLF line endings", async () => {
    const frames = await collect(parseSseFrames(chunks("id: 7\r\ndata: x\r\n\r\n")));
    expect(frames).toEqual([{ id: "7", data: "x" }]);
  });

  it("treats a lone blank line (no fields) as a no-op", async () => {
    const frames = await collect(parseSseFrames(chunks("\n\ndata: real\n\n")));
    expect(frames).toEqual([{ data: "real" }]);
  });

  it("emits frames in order across a multi-frame stream", async () => {
    const frames = await collect(
      parseSseFrames(chunks("id: 1\ndata: a\n\nid: 2\ndata: b\n\nid: 3\ndata: c\n\n")),
    );
    expect(frames.map((f) => f.data)).toEqual(["a", "b", "c"]);
  });
});

describe("readSseFrames", () => {
  it("decodes a fetch Response.body byte stream into frames", async () => {
    const body = new Response("id: 9\nevent: phase\ndata: ok\n\n").body;
    expect(body).not.toBeNull();
    const frames = await collect(readSseFrames(body as ReadableStream<Uint8Array>));
    expect(frames).toEqual([{ id: "9", event: "phase", data: "ok" }]);
  });
});
