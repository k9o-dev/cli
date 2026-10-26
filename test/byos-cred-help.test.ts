/**
 * `k9o byos-cred create --help` must describe the transport accurately:
 * the credential is sent over TLS through the platform API to the vault, so it is NOT "never sent to the
 * gateway". A false custody claim in help text is a customer-facing security statement.
 */
import { describe, expect, it } from "bun:test";
import { main } from "../src/index.ts";

async function helpText(): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
  try {
    const code = await main(["byos-cred", "create", "--help"]);
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = orig;
  }
}

describe("byos-cred help custody wording", () => {
  it("states the accurate transport and never claims the gateway is bypassed", async () => {
    const { code, out } = await helpText();
    expect(code).toBe(0);
    const flat = out.replace(/\s+/g, " ");
    expect(flat).toContain("sent over TLS through the platform API straight to the vault, which seals it");
    expect(flat).toContain("never stores it outside the vault and never returns it");
    expect(flat.toLowerCase()).not.toContain("never sent to the gateway");
    expect(flat.toLowerCase()).not.toContain("never leaves your machine");
  });
});
