/** `k9o ai generate` — argument handling and the run against a fake gateway. */

import { describe, expect, it } from "bun:test";
import { generateFromArgs } from "../src/commands/ai.ts";
import type { ParsedArgs } from "../src/args.ts";
import { envelope, runCli, tempCredentials } from "./helpers.ts";

const pa = (positional: string[], flags: Record<string, string> = {}): ParsedArgs => ({ positional, flags });
const RESULT = {
  modelId: "llama-3.1-8b",
  content: "Hello there",
  finishReason: "stop",
  usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  usageType: "inference",
};

async function signedIn(argv: string[], handler: Parameters<typeof runCli>[1]) {
  const c = tempCredentials();
  try {
    return await runCli([...argv, "--credentials-file", c.path], handler);
  } finally {
    c.cleanup();
  }
}

describe("generateFromArgs", () => {
  it("takes the prompt and the optional flags", () => {
    expect(generateFromArgs(pa(["ai", "generate", "hi"], { model: "m", "max-tokens": "50", temperature: "0.5" }))).toEqual({
      prompt: "hi",
      options: { model: "m", maxTokens: 50, temperature: 0.5 },
    });
  });

  it("reads the prompt from stdin for -", () => {
    expect(generateFromArgs(pa(["ai", "generate", "-"]), () => "from stdin")).toEqual({ prompt: "from stdin", options: {} });
  });

  it("refuses no prompt, two prompts, an empty prompt and bad numbers", () => {
    expect("problems" in generateFromArgs(pa(["ai", "generate"]))).toBe(true);
    expect("problems" in generateFromArgs(pa(["ai", "generate", "a", "b"]))).toBe(true);
    expect("problems" in generateFromArgs(pa(["ai", "generate", "-"]), () => "")).toBe(true);
    expect("problems" in generateFromArgs(pa(["ai", "generate", "x"], { "max-tokens": "0" }))).toBe(true);
    expect("problems" in generateFromArgs(pa(["ai", "generate", "x"], { "max-tokens": "1.5" }))).toBe(true);
    expect("problems" in generateFromArgs(pa(["ai", "generate", "x"], { temperature: "3" }))).toBe(true);
    expect("problems" in generateFromArgs(pa(["ai", "generate", "x"], { temperature: "abc" }))).toBe(true);
  });
});

describe("k9o ai generate", () => {
  it("prints the content on stdout and the usage on stderr", async () => {
    const r = await signedIn(["ai", "generate", "Say hello", "--max-tokens", "64"], () => ({ body: envelope(RESULT) }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Hello there\n");
    expect(r.stderr).toContain("5 tokens");
    expect(r.calls[0]!.method).toBe("POST");
    expect(r.calls[0]!.path).toBe("/@portal/ai/generate");
    expect(r.calls[0]!.body).toEqual({ prompt: "Say hello", maxTokens: 64 });
  });

  it("--output json prints the whole envelope", async () => {
    const r = await signedIn(["ai", "generate", "p", "--model", "m", "--output", "json"], () => ({ body: envelope(RESULT) }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).data.usage.totalTokens).toBe(5);
    expect(r.calls[0]!.body).toEqual({ prompt: "p", model: "m" });
  });

  it("usage errors exit 2 before any request", async () => {
    const r = await signedIn(["ai", "generate"], () => ({ body: envelope(RESULT) }));
    expect(r.code).toBe(2);
    expect(r.calls.length).toBe(0);
  });

  it("a 501 from an outside-provider model is an error exit", async () => {
    const r = await signedIn(["ai", "generate", "p", "--model", "gpt-x", "--output", "json"], () => ({
      status: 501,
      body: { code: "K9O_NOT_IMPLEMENTED", message: "External LLM provider is not configured", context: {}, recommendation: null },
    }));
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("K9O_NOT_IMPLEMENTED");
  });
});
