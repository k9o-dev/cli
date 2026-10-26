/** `k9o ai embed` — dispatch, usage errors and input assembly. These fail before any client is built. */

import { describe, expect, it } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.ts";
import { embedInputsFromArgs } from "../src/commands/ai.ts";
import type { ParsedArgs } from "../src/args.ts";

const run = (argv: string[]) => main([...argv, "--output", "json"]);
const pa = (positional: string[], flags: Record<string, string> = {}): ParsedArgs => ({ positional, flags });

describe("k9o ai", () => {
  it("usage errors: no subcommand, unknown subcommand, no input, texts plus --file", async () => {
    expect(await run(["ai"])).toBe(2);
    expect(await run(["ai", "blargh"])).toBe(2);
    expect(await run(["ai", "embed"])).toBe(2);
    // A READABLE file, so only the "not both" rule can refuse this.
    const f = join(mkdtempSync(join(tmpdir(), "k9o-ai-file-")), "n.txt");
    writeFileSync(f, "body");
    expect(await run(["ai", "embed", "hello", "--file", f])).toBe(2);
  });

  it("a valid call is not a usage error (positive control: it only fails later, at the missing profile)", async () => {
    // A profile name that cannot exist, so the control fails at profile lookup and never reaches a gateway with
    // the text (a real profile on the machine would otherwise be used).
    const prev = process.env["K9O_PROFILE"];
    process.env["K9O_PROFILE"] = "no-such-profile-k9o-ai-test";
    try {
      expect(await run(["ai", "embed", "hello"])).not.toBe(2);
    } finally {
      if (prev === undefined) delete process.env["K9O_PROFILE"]; else process.env["K9O_PROFILE"] = prev;
    }
  });

  it("texts become one input each, in order", () => {
    expect(embedInputsFromArgs(pa(["ai", "embed", "a", "b"]))).toEqual({ input: ["a", "b"] });
  });

  it("--file is ONE input (the whole file), read through the injected reader", () => {
    const got = embedInputsFromArgs(pa(["ai", "embed"], { file: "n.txt" }), (p) => `body of ${p}\nline two`);
    expect(got).toEqual({ input: ["body of n.txt\nline two"] });
  });

  it("an unreadable --file is a problem that does not echo content", () => {
    const got = embedInputsFromArgs(pa(["ai", "embed"], { file: "missing.txt" }), () => { throw new Error("ENOENT secret-path-content"); });
    expect(got).toEqual({ problems: ["cannot read --file missing.txt"] });
  });
});
