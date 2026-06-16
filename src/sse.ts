// SPDX-License-Identifier: MIT

// A tiny, dependency-free Server-Sent Events reader for `boardwalk runs <id> --follow`.
//
// Split in two so the parsing is pure + unit-testable without a socket:
//   • parseSseFrames(chunks)  — fold a stream of decoded string chunks into SSE frames per the
//                               WHATWG EventSource grammar (field lines, `:` comments, blank-line
//                               dispatch, multi-line `data`). No network, no fetch.
//   • readSseFrames(body)     — adapt a fetch `Response.body` byte stream into decoded chunks and
//                               run it through the parser.
//
// We surface `id` and `event` alongside `data` because the run stream carries the cursor in `id:`
// (for `Last-Event-ID` resume) and the v1 event kind in `event:` (with `stream_error` as the one
// transport-level frame outside the RunEvent contract).

/** One dispatched SSE frame. `data` is the concatenation of its `data:` lines (newline-joined). */
export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Fold decoded string chunks into frames. A frame dispatches on a blank line; lines starting with
 * `:` are comments (heartbeats) and ignored; a field line is `field: value` (one leading space
 * after the colon is stripped). Unknown fields are ignored, per the spec.
 */
export async function* parseSseFrames(chunks: AsyncIterable<string>): AsyncGenerator<SseFrame> {
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];

  const flush = function* (): Generator<SseFrame> {
    // Per the EventSource spec, a block dispatches only when it carried `data` — a block of only
    // `id`/`event`/`retry`/comments (e.g. the initial `retry:` frame, a heartbeat) is a no-op.
    if (dataLines.length > 0) {
      const frame: SseFrame = { data: dataLines.join("\n") };
      if (id !== undefined) frame.id = id;
      if (event !== undefined) frame.event = event;
      yield frame;
    }
    id = undefined;
    event = undefined;
    dataLines.length = 0;
  };

  /** Fold one (non-terminated) field line into the in-progress frame. */
  const handleLine = (line: string): void => {
    if (line.startsWith(":")) return; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // Strip exactly one leading space after the colon (spec). No colon ⇒ whole line is the field
    // name with an empty value.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    // unknown fields (e.g. `retry`) are ignored
  };

  for await (const chunk of chunks) {
    buffer += chunk;
    // Process every COMPLETE line; keep the trailing partial in `buffer` for the next chunk.
    let newline: number;
    while ((newline = indexOfLineEnd(buffer)) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + lineEndLength(buffer, newline));
      if (line === "") yield* flush();
      else handleLine(line);
    }
  }
  // A stream that ends mid-line (no trailing terminator) still folds + dispatches its last frame.
  if (buffer.length > 0) handleLine(buffer);
  yield* flush();
}

/** Index of the next line terminator (\n or \r) in `s`, or -1. */
function indexOfLineEnd(s: string): number {
  const lf = s.indexOf("\n");
  const cr = s.indexOf("\r");
  if (lf === -1) return cr;
  if (cr === -1) return lf;
  return Math.min(lf, cr);
}

/** Length of the terminator at `idx` (2 for a CRLF pair, else 1). */
function lineEndLength(s: string, idx: number): number {
  return s[idx] === "\r" && s[idx + 1] === "\n" ? 2 : 1;
}

/** Decode a fetch `Response.body` (a byte stream) into UTF-8 string chunks for {@link parseSseFrames}.
 *  Node 24's web `ReadableStream` is async-iterable, so we iterate it directly. */
export async function* decodeByteStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const bytes of body) {
    const text = decoder.decode(bytes, { stream: true });
    if (text.length > 0) yield text;
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}

/** Read frames straight off a fetch `Response.body`. */
export function readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  return parseSseFrames(decodeByteStream(body));
}
