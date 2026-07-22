// SPDX-License-Identifier: MIT

// Minimal interactive prompts for the setup wizard — the CLI's ONE interactive surface. Everything
// else is flag-driven, so rather than take on a TUI dependency (`@clack/prompts` et al.) for three
// question shapes, this is a tiny readline layer behind a `Prompter` interface. Tests inject a
// scripted `Prompter`; only the real terminal path (`stdioPrompter`) touches stdin.
//
// Multiselect is deliberately number-driven ("1,3" / "all" / "none" / blank = accept the default)
// rather than an arrow-key checkbox: no raw-mode fiddling, works over every terminal and pipe, and
// reads clearly in a transcript. If we ever want richer chrome, swap `stdioPrompter` for a clack
// implementation of the same interface and no caller changes.

import { createInterface, type Interface } from "node:readline/promises";

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** A dim suffix after the label (e.g. "detected", "marketplace pending"). */
  hint?: string;
}

/** The question surface the setup command drives. Injected in tests; `stdioPrompter` is the real one. */
export interface Prompter {
  confirm(question: string, def?: boolean): Promise<boolean>;
  select<T extends string>(question: string, choices: Choice<T>[], def?: T): Promise<T>;
  /** Returns the chosen subset (order follows `choices`). `preselected` is the default kept on blank. */
  multiselect<T extends string>(
    question: string,
    choices: Choice<T>[],
    preselected?: T[],
  ): Promise<T[]>;
}

/** How a `stdioPrompter` reads/writes — injectable so a test can drive it without the real stdin. */
export interface PromptIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** A readline-backed prompter over the given io (defaults to the process stdio). */
export function stdioPrompter(io?: PromptIo): Prompter {
  const input = io?.input ?? process.stdin;
  const output = io?.output ?? process.stdout;

  // One interface per call keeps the stream un-paused between prompts and avoids a lingering
  // listener; the wizard asks few enough questions that the open/close cost is irrelevant.
  const ask = async (fn: (rl: Interface) => Promise<string>): Promise<string> => {
    const rl = createInterface({ input, output });
    try {
      return await fn(rl);
    } finally {
      rl.close();
    }
  };

  const write = (line: string): void => {
    output.write(`${line}\n`);
  };

  return {
    async confirm(question, def = true) {
      const suffix = def ? "[Y/n]" : "[y/N]";
      const answer = (await ask((rl) => rl.question(`${question} ${suffix} `)))
        .trim()
        .toLowerCase();
      if (answer === "") return def;
      return answer === "y" || answer === "yes";
    },

    async select(question, choices, def) {
      const fallback = choices[0];
      if (fallback === undefined) throw new Error("select() needs at least one choice.");
      write(question);
      choices.forEach((c, i) => {
        write(`  ${String(i + 1)}) ${labelOf(c)}`);
      });
      const defItem =
        (def !== undefined ? choices.find((c) => c.value === def) : undefined) ?? fallback;
      const defNumber = choices.indexOf(defItem) + 1;
      const raw = (await ask((rl) => rl.question(`Choose [${String(defNumber)}]: `))).trim();
      if (raw === "") return defItem.value;
      const n = Number(raw);
      const picked =
        Number.isInteger(n) && n >= 1 && n <= choices.length ? choices[n - 1] : undefined;
      return (picked ?? defItem).value;
    },

    async multiselect(question, choices, preselected = []) {
      const isPre = (v: string): boolean => preselected.includes(v as (typeof preselected)[number]);
      write(question);
      choices.forEach((c, i) => {
        write(`  ${String(i + 1)}) [${isPre(c.value) ? "x" : " "}] ${labelOf(c)}`);
      });
      write("  (numbers e.g. 1,3 · 'all' · 'none' · blank = keep the marked default)");
      const raw = (await ask((rl) => rl.question("Select: "))).trim().toLowerCase();
      if (raw === "") return choices.filter((c) => isPre(c.value)).map((c) => c.value);
      if (raw === "all") return choices.map((c) => c.value);
      if (raw === "none") return [];
      const picked = new Set(
        raw
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= choices.length)
          .map((n) => n - 1),
      );
      return choices.filter((_, i) => picked.has(i)).map((c) => c.value);
    },
  };
}

function labelOf<T extends string>(choice: Choice<T>): string {
  return choice.hint === undefined ? choice.label : `${choice.label} — ${choice.hint}`;
}
