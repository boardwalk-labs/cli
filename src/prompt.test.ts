// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { stdioPrompter, type Choice } from "./prompt.js";

/** A prompter wired to in-memory streams: `answer` writes a reply line for the next question. */
function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (c: Buffer) => (out += c.toString()));
  const p = stdioPrompter({ input, output });
  const answer = (line: string): void => void input.write(`${line}\n`);
  return { p, answer, out: () => out };
}

const ABC: Choice<"a" | "b" | "c">[] = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
];

describe("confirm", () => {
  it("returns the default on a blank line", async () => {
    const { p, answer } = harness();
    const got = p.confirm("OK?", true);
    answer("");
    expect(await got).toBe(true);
  });

  it("reads an explicit no", async () => {
    const { p, answer } = harness();
    const got = p.confirm("OK?", true);
    answer("n");
    expect(await got).toBe(false);
  });
});

describe("select", () => {
  it("returns the numbered choice", async () => {
    const { p, answer } = harness();
    const got = p.select("Pick", ABC);
    answer("2");
    expect(await got).toBe("b");
  });

  it("falls back to the default value on blank", async () => {
    const { p, answer } = harness();
    const got = p.select("Pick", ABC, "c");
    answer("");
    expect(await got).toBe("c");
  });

  it("falls back to the default on an out-of-range number", async () => {
    const { p, answer } = harness();
    const got = p.select("Pick", ABC, "b");
    answer("9");
    expect(await got).toBe("b");
  });
});

describe("multiselect", () => {
  it("parses a comma list into the chosen subset (in choice order)", async () => {
    const { p, answer } = harness();
    const got = p.multiselect("Pick", ABC);
    answer("3,1");
    expect(await got).toEqual(["a", "c"]);
  });

  it("keeps the preselected default on a blank line", async () => {
    const { p, answer } = harness();
    const got = p.multiselect("Pick", ABC, ["b"]);
    answer("");
    expect(await got).toEqual(["b"]);
  });

  it("supports 'all' and 'none'", async () => {
    const all = harness();
    const gotAll = all.p.multiselect("Pick", ABC, ["a"]);
    all.answer("all");
    expect(await gotAll).toEqual(["a", "b", "c"]);

    const none = harness();
    const gotNone = none.p.multiselect("Pick", ABC, ["a"]);
    none.answer("none");
    expect(await gotNone).toEqual([]);
  });
});
