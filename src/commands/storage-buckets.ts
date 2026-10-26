/**
 * `k9o storage buckets …` and `k9o storage objects …` — the project's logical buckets and the objects in them.
 * Wire to `client.storage.*`. `k9o storage locations …` (the customer's own object stores) is in `storage.ts`.
 *
 * Not offered: bucket `public`, `versioning` and `deleteAfterDays`. The gateway stores them but nothing reads
 * them, so a flag would promise behaviour that does not happen.
 */

import { readFileSync } from "node:fs";
import { KError } from "@k9o/core";
import type { CreateBucketOptions, UpdateBucketOptions } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE } from "../exit-codes.ts";

export const BUCKET_SUBCOMMANDS = ["list", "get", "create", "update", "delete"] as const;
export const OBJECT_SUBCOMMANDS = ["upload", "list", "sign", "delete"] as const;

export const STORAGE_BUCKETS_HELP = `
k9o storage buckets — the project's logical buckets

USAGE
  k9o storage buckets list
  k9o storage buckets get <name>
  k9o storage buckets create <name> [flags]
  k9o storage buckets update <name> [flags]
  k9o storage buckets delete <name> [--empty]

CREATE / UPDATE FLAGS
  --file-size-limit <bytes>        update: --clear-file-size-limit removes it
  --allowed-mime-types <a,b,...>   update: --any-mime-type allows every type
  --location <locationId>          link the bucket to a storage location (update: --unlink-location)

Bucket names are 3 to 63 characters: lowercase letters, digits and hyphens, not starting or ending with a hyphen.
delete refuses a non-empty bucket; --empty purges its objects first.
`.trim() + "\n";

export const STORAGE_OBJECTS_HELP = `
k9o storage objects — objects in a bucket

USAGE
  k9o storage objects upload <bucket> <path> (--file <local-file> | --stdin) [--content-type <t>] [--upsert]
                                              [--metadata k=v,k=v]
  k9o storage objects list   <bucket> [--prefix <p>]
  k9o storage objects sign   <bucket> <path> --expires-in <seconds> [--download]
  k9o storage objects delete <bucket> <path>

upload refuses an existing path unless --upsert. sign returns a pre-authenticated GET URL; --expires-in is
required (1 to 604800 seconds, no default). The gateway caps a signed URL's real lifetime at 900 seconds
whatever you ask for, and says so on stderr. A signed PUT is not available.
`.trim() + "\n";

type Fmt = ReturnType<typeof resolveOutputFormat>;

function usage(format: Fmt, message: string, recommendation: string): number {
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message, context: {}, recommendation }));
  return EXIT_USAGE;
}

function parseNonNegInt(v: string | undefined): number | undefined | "bad" {
  if (v === undefined) return undefined;
  return /^\d+$/.test(v) ? Number(v) : "bad";
}

/** Shared create/update flag parsing. Pushes problems into `bad` and returns the patch. */
export function bucketOptionsFromFlags(args: ParsedArgs, forUpdate: boolean, bad: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const gone of ["public", "versioning", "delete-after-days", "clear-delete-after-days"]) {
    if (args.flags[gone] !== undefined) bad.push(`--${gone} (not supported: the gateway does not act on it)`);
  }

  const size = parseNonNegInt(args.flags["file-size-limit"]);
  if (size === "bad") bad.push("--file-size-limit (bytes, a non-negative integer)");
  else if (size !== undefined) out["fileSizeLimit"] = size;

  const mimes = args.flags["allowed-mime-types"];
  if (mimes !== undefined) {
    const list = mimes.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (list.length === 0) bad.push("--allowed-mime-types (a comma-separated list)");
    else out["allowedMimeTypes"] = list;
  }
  const loc = args.flags["location"];
  if (loc !== undefined) out["byosBindingId"] = loc;

  if (forUpdate) {
    const clear = (flag: string, key: string, conflictsWith: string) => {
      if (args.flags[flag] === undefined) return;
      if (out[conflictsWith] !== undefined || key in out) bad.push(`--${flag} conflicts with the matching set flag`);
      else out[key] = null;
    };
    clear("clear-file-size-limit", "fileSizeLimit", "fileSizeLimit");
    clear("any-mime-type", "allowedMimeTypes", "allowedMimeTypes");
    clear("unlink-location", "byosBindingId", "byosBindingId");
  } else {
    for (const f of ["clear-file-size-limit", "any-mime-type", "unlink-location"]) {
      if (args.flags[f] !== undefined) bad.push(`--${f} (update only)`);
    }
  }
  return out;
}

export function parseMetadata(raw: string | undefined, bad: string[]): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) {
      bad.push(`--metadata entry "${pair}" (expected key=value)`);
      continue;
    }
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

export async function dispatchBuckets(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const name = args.positional[3];
  if (sub === undefined) {
    process.stdout.write(STORAGE_BUCKETS_HELP);
    return EXIT_USAGE;
  }
  if (!(BUCKET_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return usage(format, `unknown storage buckets subcommand "${sub}"`, `Valid: ${BUCKET_SUBCOMMANDS.join(" | ")}`);
  }
  if (sub !== "list" && name === undefined) {
    return usage(format, `k9o storage buckets ${sub} requires <name> (positional)`, `k9o storage buckets ${sub} avatars`);
  }
  const bad: string[] = [];
  let options: Record<string, unknown> = {};
  if (sub === "create" || sub === "update") {
    options = bucketOptionsFromFlags(args, sub === "update", bad);
    if (sub === "update" && Object.keys(options).length === 0 && bad.length === 0) bad.push("at least one field to change");
  }
  if (bad.length > 0) {
    return usage(format, `k9o storage buckets ${sub}: ${bad.join(", ")}`, "k9o storage buckets --help lists the flags.");
  }

  const { client } = clientFromProfile(args, { requireProject: true });
  if (sub === "list") {
    const env = await client.storage.listBuckets();
    emitSuccess(format, env, (rows) =>
      rows.length === 0
        ? "No buckets."
        : ["Buckets:", ...rows.map((b) => `  ${b.name}`)].join("\n"),
    );
  } else if (sub === "get") {
    const env = await client.storage.getBucket(name!);
    emitSuccess(format, env, (b) =>
      [
        `Bucket ${b.name}`,
        `  fileSizeLimit: ${b.fileSizeLimit ?? "none"}`,
        `  allowedMimeTypes: ${b.allowedMimeTypes.length === 0 ? "any" : b.allowedMimeTypes.join(", ")}`,
        `  location: ${b.byosBindingId ?? "platform-managed"}`,
      ].join("\n"),
    );
  } else if (sub === "create") {
    const env = await client.storage.createBucket(name!, options as CreateBucketOptions);
    emitSuccess(format, env, (b) => `Created bucket ${b.name}`);
  } else if (sub === "update") {
    const env = await client.storage.updateBucket(name!, options as UpdateBucketOptions);
    emitSuccess(format, env, (b) => `Updated bucket ${b.name}`);
  } else {
    const env = await client.storage.deleteBucket(name!, { empty: args.flags["empty"] === "true" });
    emitSuccess(format, env, (d) => `Deleted bucket ${d.name} (${d.objectsDeleted} object(s) removed)`);
  }
  return EXIT_SUCCESS;
}

export async function dispatchObjects(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const bucket = args.positional[3];
  const path = args.positional[4];
  if (sub === undefined) {
    process.stdout.write(STORAGE_OBJECTS_HELP);
    return EXIT_USAGE;
  }
  if (!(OBJECT_SUBCOMMANDS as readonly string[]).includes(sub)) {
    return usage(format, `unknown storage objects subcommand "${sub}"`, `Valid: ${OBJECT_SUBCOMMANDS.join(" | ")}`);
  }
  if (bucket === undefined) {
    return usage(format, `k9o storage objects ${sub} requires <bucket> (positional)`, STORAGE_OBJECTS_HELP);
  }
  if (sub !== "list" && path === undefined) {
    return usage(format, `k9o storage objects ${sub} requires <path> (positional)`, STORAGE_OBJECTS_HELP);
  }

  const bad: string[] = [];
  let bytes: Uint8Array | undefined;
  let expiresIn = 0;
  let metadata: Record<string, string> | undefined;
  if (sub === "upload") {
    const file = args.flags["file"];
    const stdin = args.flags["stdin"] === "true";
    if (file !== undefined && stdin) bad.push("pass --file or --stdin, not both");
    else if (file === undefined && !stdin) bad.push("--file <local-file> or --stdin");
    metadata = parseMetadata(args.flags["metadata"], bad);
    if (bad.length === 0) {
      try {
        bytes = stdin ? new Uint8Array(readFileSync(0)) : new Uint8Array(readFileSync(file!));
      } catch (e) {
        bad.push(`cannot read the input: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  if (sub === "sign") {
    const raw = args.flags["expires-in"];
    if (raw === undefined) bad.push("--expires-in <seconds> (required; there is no default)");
    else if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 604_800) bad.push("--expires-in (an integer from 1 to 604800)");
    else expiresIn = Number(raw);
  }
  if (bad.length > 0) {
    return usage(format, `k9o storage objects ${sub}: ${bad.join(", ")}`, STORAGE_OBJECTS_HELP);
  }

  const { client } = clientFromProfile(args, { requireProject: true });
  const handle = client.storage.from(bucket);
  if (sub === "upload") {
    const contentType = args.flags["content-type"];
    const env = await handle.upload(path!, bytes!, {
      ...(contentType !== undefined ? { contentType } : {}),
      upsert: args.flags["upsert"] === "true",
      ...(metadata !== undefined ? { metadata } : {}),
    });
    emitSuccess(format, env, (o) => `Uploaded ${bucket}/${o.path} (${o.size} bytes)`);
  } else if (sub === "list") {
    const prefix = args.flags["prefix"];
    const env = await handle.list(prefix !== undefined ? { prefix } : {});
    emitSuccess(format, env, (rows) =>
      rows.length === 0 ? "No objects." : [`Objects in ${bucket}:`, ...rows.map((o) => `  ${String(o.size).padStart(10)}  ${o.path}`)].join("\n"),
    );
  } else if (sub === "sign") {
    const env = await handle.createSignedUrl(path!, { expiresIn, download: args.flags["download"] === "true" });
    emitSuccess(format, env, (s) => s.signedUrl);
    if (env.data.expiresIn < expiresIn && format !== "json") {
      process.stderr.write(`note: the URL expires in ${env.data.expiresIn} seconds (the gateway's cap), not ${expiresIn}.\n`);
    }
  } else {
    const env = await handle.remove(path!);
    emitSuccess(format, env, (r) => (r.deleted ? `Deleted ${bucket}/${r.path}` : `Nothing at ${bucket}/${r.path}`));
  }
  return EXIT_SUCCESS;
}
