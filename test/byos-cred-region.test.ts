/**
 * `k9o byos-cred create`: `--region` is the PLATFORM region of the vault write (a short code) and `--provider-region`
 * is the provider's STS / SigV4 signing region. The AWS-family providers need both; the others need only `--region`
 * These fail before any client is built.
 */
import { describe, expect, it } from "bun:test";
import { main } from "../src/index.ts";
import { collectSigV4Value } from "../src/commands/byos-cred.ts";
import { KError } from "@k9o/core";
import type { ParsedArgs } from "../src/args.ts";

const run = (argv: string[]) => main([...argv, "--output", "json"]);

// A profile name that cannot exist, so a complete command fails at profile lookup and never reaches a gateway.
async function withNoProfile<T>(f: () => Promise<T>): Promise<T> {
  const prev = process.env["K9O_PROFILE"];
  process.env["K9O_PROFILE"] = "no-such-profile-k9o-byos-region-test";
  try {
    return await f();
  } finally {
    if (prev === undefined) delete process.env["K9O_PROFILE"]; else process.env["K9O_PROFILE"] = prev;
  }
}

const aws = (provider: string, extra: string[]) =>
  ["byos-cred", "create", "byos/x", "--provider", provider, "--access-key-id", "AKIA1", "--secret-access-key", "shh", ...extra];

describe("k9o byos-cred create regions", () => {
  it("s3, s3_compatible and minio need --provider-region as well as --region", async () => {
    for (const provider of ["s3", "s3_compatible", "minio"]) {
      expect(await withNoProfile(() => run(aws(provider, ["--region", "de01", "--provider-region", "us-east-1"]))), `${provider} complete control`).not.toBe(2);
      expect(await run(aws(provider, ["--region", "de01"])), `${provider} without --provider-region`).toBe(2);
      expect(await run(aws(provider, ["--provider-region", "us-east-1"])), `${provider} without --region`).toBe(2);
    }
  });

  it("a malformed --provider-region is refused (exit 70) before a profile is looked up, and the platform short code is not an AWS region", async () => {
    for (const bad of ["de01", "x.attacker.net#", "us-east-1.evil", "US-EAST-1"]) {
      expect(await withNoProfile(() => run(aws("s3", ["--region", "de01", "--provider-region", bad]))), bad).toBe(70);
    }
    // POSITIVE CONTROL: the same command with a real AWS region is not refused for its region.
    expect(await withNoProfile(() => run(aws("s3", ["--region", "de01", "--provider-region", "us-east-1"])))).not.toBe(70);
  });

  it("gcs, b2 and r2 need only --region", async () => {
    const gcs = ["byos-cred", "create", "byos/g", "--provider", "gcs", "--private-key-pem", "x", "--client-id", "sa@p.iam", "--region", "de01"];
    const b2 = ["byos-cred", "create", "byos/b", "--provider", "b2", "--key-id", "k", "--app-key", "a", "--region", "de01"];
    const r2 = ["byos-cred", "create", "byos/r", "--provider", "r2", "--api-token", "t", "--region", "de01"];
    for (const argv of [gcs, b2, r2]) {
      expect(await withNoProfile(() => run(argv)), argv[3]).not.toBe(2);
    }
  });
});

describe("the sealed aws_sigv4 signing region", () => {
  const args = (flags: Record<string, string>): ParsedArgs => ({ positional: [], flags });

  it("is the provider's --provider-region, never the platform --region", async () => {
    const got = await collectSigV4Value(args({ region: "de01", "provider-region": "us-east-1", "access-key-id": "AKIA1", "secret-access-key": "shh" }), "s3");
    expect(got).toEqual({ accessKeyId: "AKIA1", secretAccessKey: "shh", providerRegion: "us-east-1" });
  });

  it("refuses a missing or empty --provider-region", async () => {
    for (const flags of [{ region: "de01" }, { region: "de01", "provider-region": "" }]) {
      const got = await collectSigV4Value(args({ ...flags, "access-key-id": "a", "secret-access-key": "b" }), "s3");
      expect(got).toBeInstanceOf(KError);
    }
  });
});
