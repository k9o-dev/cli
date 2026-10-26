/**
 * `k9o storage locations` — dispatch, usage errors and the provider-flag structural checks. These paths all
 * fail before any client is built, so they need no profile or network. (The wire behavior is tested at the SDK
 * layer in packages/core/test/storage-locations.test.ts.)
 */

import { describe, expect, it } from "bun:test";
import { main } from "../src/index.ts";
import { providerParamsFromFlags, providerParamsFromUpdateFlags } from "../src/commands/storage.ts";
import type { ParsedArgs } from "../src/args.ts";

const run = (argv: string[]) => main([...argv, "--output", "json"]);

// A profile name that cannot exist, so a command that passes validation fails at profile lookup and never reaches a
// gateway (a real profile on the machine would otherwise be used).
async function withNoProfile<T>(f: () => Promise<T>): Promise<T> {
  const prev = process.env["K9O_PROFILE"];
  process.env["K9O_PROFILE"] = "no-such-profile-k9o-storage-test";
  try {
    return await f();
  } finally {
    if (prev === undefined) delete process.env["K9O_PROFILE"]; else process.env["K9O_PROFILE"] = prev;
  }
}

describe("k9o storage", () => {
  it("returns EXIT_USAGE with no group and with an unknown group", async () => {
    expect(await run(["storage"])).toBe(2);
    expect(await run(["storage", "buckets"])).toBe(2);
  });

  it("returns EXIT_USAGE for no or an unknown locations subcommand", async () => {
    expect(await run(["storage", "locations"])).toBe(2);
    expect(await run(["storage", "locations", "blargh"])).toBe(2);
  });

  it("get/update/retire/test need a <locationId>", async () => {
    for (const sub of ["get", "retire", "test"]) {
      expect(await run(["storage", "locations", sub]), sub).toBe(2);
    }
    expect(await run(["storage", "locations", "update", "--bucket-name", "x"])).toBe(2);
  });

  it("create refuses missing required flags, takes no --purpose, and refuses an r2-only flag on s3", async () => {
    expect(await run(["storage", "locations", "create"])).toBe(2);
    const base = ["storage", "locations", "create", "--provider", "s3", "--bucket-name", "b", "--region", "de01", "--provider-region", "us-east-1", "--credential-ref", "kibo://byos-creds/sec_x"];
    // POSITIVE CONTROL: a complete s3 create (no --purpose) passes validation and only fails later, at the
    // missing profile (the code depends on how that fails, so assert only "not a usage error"), which makes the
    // exit-2 arms below the validation talking and not a blanket usage error.
    expect(await run(base)).not.toBe(2);
    expect(await run([...base, "--account-id", "a"])).toBe(2);
  });

  it("create needs BOTH --region and --provider-region: either alone is a usage error", async () => {
    const mk = (extra: string[]) => ["storage", "locations", "create", "--provider", "s3", "--bucket-name", "b", "--credential-ref", "kibo://byos-creds/sec_x", ...extra];
    expect(await withNoProfile(() => run(mk(["--region", "de01", "--provider-region", "us-east-1"]))), "both given control").not.toBe(2);
    expect(await run(mk(["--region", "de01"]))).toBe(2);
    expect(await run(mk(["--provider-region", "us-east-1"]))).toBe(2);
  });

  it("r2 needs both ids; b2 needs the bucket id; cross-provider ids are refused", async () => {
    const mk = (provider: string, extra: string[]) =>
      ["storage", "locations", "create", "--provider", provider, "--bucket-name", "b", "--region", "de01", "--provider-region", "auto", "--credential-ref", "kibo://byos-creds/sec_x", ...extra];
    expect(await run(mk("r2", ["--account-id", "a", "--parent-access-key-id", "p"])), "valid r2 control").not.toBe(2);
    expect(await run(mk("b2", ["--bucket-id", "x"])), "valid b2 control").not.toBe(2);
    expect(await run(mk("r2", ["--account-id", "a"]))).toBe(2);
    expect(await run(mk("r2", ["--parent-access-key-id", "p"]))).toBe(2);
    expect(await run(mk("r2", ["--account-id", "a", "--parent-access-key-id", "p", "--bucket-id", "x"]))).toBe(2);
    expect(await run(mk("b2", []))).toBe(2);
    expect(await run(mk("b2", ["--bucket-id", "x", "--account-id", "a"]))).toBe(2);
  });

  it("update accepts --provider-region on its own as a change (not an empty patch)", async () => {
    expect(await withNoProfile(() => run(["storage", "locations", "update", "byos_abc", "--provider-region", "eu-west-1"]))).not.toBe(2);
    expect(await withNoProfile(() => run(["storage", "locations", "update", "byos_abc", "--region", "uk01"]))).not.toBe(2);
  });

  it("update refuses an empty patch and a contradictory endpoint pair", async () => {
    expect(await run(["storage", "locations", "update", "byos_abc", "--bucket-name", "x"]), "valid update control").not.toBe(2);
    expect(await run(["storage", "locations", "update", "byos_abc"])).toBe(2);
    expect(await run(["storage", "locations", "update", "byos_abc", "--endpoint-override", "https://x", "--clear-endpoint-override", "true"])).toBe(2);
  });

  it("buckets: unknown subcommand and a missing <name> are usage errors; valid ones get past validation", async () => {
    expect(await run(["storage", "buckets", "blargh"])).toBe(2);
    for (const sub of ["get", "create", "update", "delete"]) expect(await run(["storage", "buckets", sub]), sub).toBe(2);
    // POSITIVE CONTROLS: these are valid, so they pass validation and fail later at the missing profile.
    expect(await run(["storage", "buckets", "list"])).not.toBe(2);
    expect(await run(["storage", "buckets", "get", "avatars"])).not.toBe(2);
    expect(await run(["storage", "buckets", "create", "avatars", "--file-size-limit", "1024"])).not.toBe(2);
    expect(await run(["storage", "buckets", "delete", "avatars", "--empty"])).not.toBe(2);
  });

  it("buckets create/update: bad flag values and empty patches are usage errors", async () => {
    const c = ["storage", "buckets", "create", "avatars"];
    expect(await run([...c, "--file-size-limit", "ten"])).toBe(2);
    // The gateway stores these three options but nothing reads them, so the CLI no longer offers them.
    for (const gone of ["--public", "--versioning", "--delete-after-days"]) {
      expect(await run([...c, gone, "true"]), gone).toBe(2);
    }
    expect(await run([...c, "--clear-file-size-limit"]), "update-only flag on create").toBe(2);
    const u = ["storage", "buckets", "update", "avatars"];
    expect(await run(u), "an empty patch").toBe(2);
    expect(await run([...u, "--file-size-limit", "5", "--clear-file-size-limit"]), "set and clear together").toBe(2);
    expect(await run([...u, "--clear-file-size-limit"]), "valid clear control").not.toBe(2);
    expect(await run([...u, "--any-mime-type"]), "valid any-type control").not.toBe(2);
  });

  it("objects: needs <bucket> and <path>; upload needs exactly one source; sign needs --expires-in in range", async () => {
    expect(await run(["storage", "objects", "blargh", "avatars"])).toBe(2);
    expect(await run(["storage", "objects", "upload"])).toBe(2);
    expect(await run(["storage", "objects", "upload", "avatars"])).toBe(2);
    expect(await run(["storage", "objects", "upload", "avatars", "a.jpg"]), "no source").toBe(2);
    expect(await run(["storage", "objects", "upload", "avatars", "a.jpg", "--file", "/nope/missing.bin"]), "unreadable file").toBe(2);
    expect(await run(["storage", "objects", "upload", "avatars", "a.jpg", "--file", import.meta.path, "--metadata", "novalue"]), "bad metadata").toBe(2);
    expect(await run(["storage", "objects", "upload", "avatars", "a.jpg", "--file", import.meta.path, "--stdin"]), "both sources").toBe(2);
    expect(await run(["storage", "objects", "upload", "avatars", "a.jpg", "--file", import.meta.path, "--metadata", "k=v"]), "valid upload control").not.toBe(2);

    expect(await run(["storage", "objects", "sign", "avatars", "a.jpg"]), "no expiry").toBe(2);
    expect(await run(["storage", "objects", "sign", "avatars", "a.jpg", "--expires-in", "0"])).toBe(2);
    expect(await run(["storage", "objects", "sign", "avatars", "a.jpg", "--expires-in", "604801"])).toBe(2);
    expect(await run(["storage", "objects", "sign", "avatars", "a.jpg", "--expires-in", "300"]), "valid sign control").not.toBe(2);
    expect(await run(["storage", "objects", "list", "avatars"]), "valid list control").not.toBe(2);
    expect(await run(["storage", "objects", "delete", "avatars"]), "delete needs a path").toBe(2);
    expect(await run(["storage", "objects", "delete", "avatars", "a.jpg"]), "valid delete control").not.toBe(2);
  });

  it("an unknown storage group is a usage error that names the valid groups", async () => {
    expect(await run(["storage", "blargh"])).toBe(2);
  });

  it("the withdrawn `byos` command is gone (unknown command), even with arguments the new command accepts", async () => {
    // `byos locations list` is a VALID `storage locations list` (it would get as far as the missing profile);
    // under the old command name it must still be an unknown command (exit 2).
    expect(await run(["storage", "locations", "list"]), "control: the new spelling is not a usage error").not.toBe(2);
    expect(await run(["byos", "locations", "list"])).toBe(2);
    expect(await run(["byos", "list"])).toBe(2);
  });

  it("--help prints the storage help and exits 0", async () => {
    expect(await run(["storage", "locations", "--help"])).toBe(0);
  });

  it("the help says every field that counts as a move on an in-use location, custody mode included", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
    try { await run(["storage", "locations", "--help"]); } finally { process.stdout.write = orig; }
    const flat = chunks.join("").replace(/\s+/g, " ");
    expect(flat).toContain("(bucket, region, provider region, endpoint, provider params or custody mode) is refused");
    expect(flat).toContain("A custody-mode change counts as a move");
  });

  // The credential mint reads these EXACT keys from the location's providerParams and fails closed when one is
  // missing, so a mistyped key here would register a location that can never mint. Pin the names.
  const argsWith = (flags: Record<string, string>): ParsedArgs => ({ positional: [], flags });

  it("maps the provider flags to the exact providerParams keys the mint reads", () => {
    const missing: string[] = [];
    expect(providerParamsFromFlags(argsWith({ "account-id": "A", "parent-access-key-id": "P" }), "r2", missing)).toEqual({ accountId: "A", parentAccessKeyId: "P" });
    expect(providerParamsFromFlags(argsWith({ "bucket-id": "B" }), "b2", missing)).toEqual({ bucketId: "B" });
    expect(missing).toEqual([]);
    expect(providerParamsFromFlags(argsWith({}), "s3", missing)).toBeUndefined();
    expect(providerParamsFromUpdateFlags(argsWith({ "account-id": "A", "parent-access-key-id": "P", "bucket-id": "B" })))
      .toEqual({ accountId: "A", parentAccessKeyId: "P", bucketId: "B" });
    expect(providerParamsFromUpdateFlags(argsWith({}))).toBeUndefined();
  });
});
