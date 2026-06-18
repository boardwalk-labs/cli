// SPDX-License-Identifier: MIT

/**
 * Read the whole of stdin as UTF-8 — for a piped secret value or provider API key
 * (`echo $TOKEN | boardwalk secrets set NAME`). The single place the stream-chunk type is narrowed.
 */
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    // `for await` over a stream yields `any` (Node's stream types predate async iteration); a chunk
    // is a Buffer or string at runtime, so narrow it to bytes here once rather than at each call site.
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}
