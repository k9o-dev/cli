/**
 * `k9o storage locations` subcommands — register and manage the customer's own object stores (storage
 * locations) for the active project. Replaces the withdrawn purpose-based `k9o byos`.
 *
 * Deliberately independent of `k9o byos-cred create` (`commands/byos-cred.ts`) — this command never creates or
 * inspects a credential, only registers a caller-supplied `--credential-ref` string. Run `k9o byos-cred create`
 * first to obtain a `kibo://byos-creds/<secId>` reference, then pass it here.
 *
 * Wire to `client.storage.locations.*` per the SDK at packages/core/src/storage-locations.ts.
 */

import { KError } from "@k9o/core";
import type { StorageLocationProvider, StorageLocationCustodyMode, StorageLocationProviderParams } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { dispatchBuckets, dispatchObjects, STORAGE_BUCKETS_HELP, STORAGE_OBJECTS_HELP } from "./storage-buckets.ts";

const PROVIDER_VALUES = ["s3", "s3_compatible", "gcs", "azure_blob", "minio", "r2", "b2"] as const;
const CUSTODY_VALUES = ["PLATFORM_MANAGED", "BYOK", "HYOK"] as const;

function printStorageHelp(): void {
  process.stdout.write(`
k9o storage — buckets, objects and storage locations

USAGE
  k9o storage buckets <list|get|create|update|delete> [args...] [flags...]
  k9o storage objects <upload|list|sign|delete> <bucket> [args...] [flags...]
  k9o storage locations <subcommand> [args...] [flags...]

  Run \`k9o storage buckets\` or \`k9o storage objects\` with no subcommand for their flags.

LOCATIONS (your own object stores)

SUBCOMMANDS
  list                          List the live storage locations of the active project
  create                        Register a location from a pre-created credential reference
  get <locationId>              Show one location
  update <locationId>           Change a live location
  retire <locationId>           Retire a location (refused while a bucket or Dataset uses it)
  test <locationId>             Dry-run check of a location

k9o storage locations create requires a credentialRef from a credential you pre-created
separately with \`k9o byos-cred create\` — this command never creates one itself, it only
registers the reference you pass it. A location has no purpose: which bucket or Dataset
uses it is decided when you link it.

CREATE FLAGS
  --provider <p>                ${PROVIDER_VALUES.join(" | ")}
  --bucket-name <name>          Bucket/container name
  --region <region>             Platform region, a short code such as de01 (must be inside the project's residency set)
  --provider-region <name>      The provider's own name for the bucket's location (us-east-1, auto for R2); never residency-checked
  --endpoint-override <url>     S3-compatible custom endpoint (optional)
  --credential-ref <ref>        kibo://byos-creds/<secId> from \`k9o byos-cred create\`
  --custody-mode <m>            ${CUSTODY_VALUES.join(" | ")} (default: PLATFORM_MANAGED)

  --account-id <id>             r2 only — Cloudflare account id (required with --parent-access-key-id)
  --parent-access-key-id <id>   r2 only — the parent (scoping) access key id
  --bucket-id <id>              b2 only — the Backblaze bucket id

UPDATE FLAGS (any of)
  --bucket-name, --region, --provider-region, --endpoint-override <url>, --clear-endpoint-override,
  --credential-ref, --custody-mode, and the provider flags above. Provider flags REPLACE the
  whole provider-params map, so pass every one you want to keep. Moving a location that is in
  use (bucket, region, provider region, endpoint, provider params or custody mode) is refused; rotating the
  credential is not. A custody-mode change counts as a move: it re-states the custody claim
  for data already stored there.

r2 and b2 need the extra id fields above. The gateway stores them as given and the credential
mint fails closed when one is missing, so this CLI checks that they are present and on the right
provider before sending. It does not re-validate their exact format.

Example:
  k9o byos-cred create byos/s3-prod --access-key-id ... --secret-access-key ...
  k9o storage locations create --provider s3 --bucket-name acme-docs --region de01 --provider-region us-east-1 \\
    --credential-ref kibo://byos-creds/sec_abc123
  k9o storage locations create --provider r2 --bucket-name acme-docs --region de01 --provider-region auto \\
    --credential-ref kibo://byos-creds/sec_abc123 \\
    --account-id <32-hex> --parent-access-key-id <32-hex>
`.trim() + "\n");
}

export async function dispatchStorage(args: ParsedArgs): Promise<number> {
  const group = args.positional[1];
  const sub = args.positional[2];
  const format = resolveOutputFormat(args.flags);
  if (group === undefined || args.flags["help"] === "true") {
    printStorageHelp();
    return group === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (group === "buckets") return await dispatchBuckets(args);
    if (group === "objects") return await dispatchObjects(args);
    if (group !== "locations") {
      emitError(format, new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `unknown storage group "${group}"`,
        context: { group },
        recommendation: "Valid: buckets | objects | locations",
      }));
      return EXIT_USAGE;
    }
    if (sub === undefined) {
      printStorageHelp();
      return EXIT_USAGE;
    }
    if (sub === "list") return await cmdList(args);
    if (sub === "create") return await cmdCreate(args);
    if (sub === "get") return await cmdGet(args);
    if (sub === "update") return await cmdUpdate(args);
    if (sub === "retire") return await cmdRetire(args);
    if (sub === "test") return await cmdTest(args);
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown storage locations subcommand "${sub}"`,
      context: { sub },
      recommendation: "Valid: list | create | get | update | retire | test",
    }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function isOneOf<T extends string>(values: readonly T[], v: string | undefined): v is T {
  return v !== undefined && (values as readonly string[]).includes(v);
}

/** The id positional for get/update/retire/test: `k9o storage locations <sub> <locationId>`. */
function locationIdOf(args: ParsedArgs): string | undefined {
  return args.flags["id"] ?? args.positional[3];
}

function requireLocationId(args: ParsedArgs, sub: string, format: ReturnType<typeof resolveOutputFormat>): string | null {
  const id = locationIdOf(args);
  if (id === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `k9o storage locations ${sub} requires <locationId> (positional)`,
      context: {},
      recommendation: `k9o storage locations ${sub} byos_abc123`,
    }));
    return null;
  }
  return id;
}

/**
 * Provider-conditional structural checks over the three provider flags. Returns the providerParams to send
 * (or `undefined` when no provider flag was given) and pushes problems into `missing`. Deliberately NOT
 * re-validating exact format: the mint is the source of truth.
 */
export function providerParamsFromFlags(
  args: ParsedArgs,
  provider: string | undefined,
  missing: string[],
): StorageLocationProviderParams | undefined {
  const accountId = args.flags["account-id"];
  const parentAccessKeyId = args.flags["parent-access-key-id"];
  const bucketId = args.flags["bucket-id"];
  if (provider === "r2") {
    if (accountId === undefined) missing.push("--account-id (required for r2)");
    if (parentAccessKeyId === undefined) missing.push("--parent-access-key-id (required for r2)");
    if (bucketId !== undefined) missing.push("--bucket-id (b2-only, not valid for r2)");
  } else if (provider === "b2") {
    if (bucketId === undefined) missing.push("--bucket-id (required for b2)");
    if (accountId !== undefined) missing.push("--account-id (r2-only, not valid for b2)");
    if (parentAccessKeyId !== undefined) missing.push("--parent-access-key-id (r2-only, not valid for b2)");
  } else if (accountId !== undefined || parentAccessKeyId !== undefined || bucketId !== undefined) {
    missing.push("--account-id/--parent-access-key-id/--bucket-id (r2/b2-only, not valid for this provider)");
  }
  const params: StorageLocationProviderParams = {};
  if (accountId !== undefined) params["accountId"] = accountId;
  if (parentAccessKeyId !== undefined) params["parentAccessKeyId"] = parentAccessKeyId;
  if (bucketId !== undefined) params["bucketId"] = bucketId;
  return Object.keys(params).length > 0 ? params : undefined;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.storage.locations.list();
  emitSuccess(format, envelope, (locations) => {
    if (locations.length === 0) return "No storage locations.";
    const rows = locations.map((l) =>
      `  ${l.id.padEnd(24)}  ${l.provider.padEnd(14)}  ${l.bucketName.padEnd(30)}  ${l.region}  ${l.providerRegion}`,
    );
    return ["Storage locations:", ...rows].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdCreate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const provider = args.flags["provider"];
  const bucketName = args.flags["bucket-name"];
  const region = args.flags["region"];
  const providerRegion = args.flags["provider-region"];
  const credentialRef = args.flags["credential-ref"];
  const custodyModeFlag = args.flags["custody-mode"];

  const missing: string[] = [];
  if (!isOneOf(PROVIDER_VALUES, provider)) missing.push(`--provider (${PROVIDER_VALUES.join("|")})`);
  if (bucketName === undefined) missing.push("--bucket-name");
  if (region === undefined) missing.push("--region");
  if (providerRegion === undefined) missing.push("--provider-region");
  if (credentialRef === undefined) missing.push("--credential-ref");
  if (custodyModeFlag !== undefined && !isOneOf(CUSTODY_VALUES, custodyModeFlag)) missing.push(`--custody-mode (${CUSTODY_VALUES.join("|")})`);
  const providerParams = providerParamsFromFlags(args, provider, missing);

  if (missing.length > 0) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `k9o storage locations create is missing/invalid required flags: ${missing.join(", ")}`,
      context: { missing },
      recommendation: "Run `k9o byos-cred create` first to get a --credential-ref, then k9o storage --help for the full flag list.",
    }));
    return EXIT_USAGE;
  }

  const { client } = clientFromProfile(args, { requireProject: true });
  const endpointOverride = args.flags["endpoint-override"];
  const envelope = await client.storage.locations.create({
    provider: provider as StorageLocationProvider,
    bucketName: bucketName!,
    region: region!,
    providerRegion: providerRegion!,
    ...(endpointOverride !== undefined ? { endpointOverride } : {}),
    credentialRef: credentialRef!,
    ...(custodyModeFlag !== undefined ? { custodyMode: custodyModeFlag as StorageLocationCustodyMode } : {}),
    ...(providerParams !== undefined ? { providerParams } : {}),
  });
  emitSuccess(format, envelope, (l) =>
    `Registered storage location ${l.id} — ${l.provider}:${l.bucketName} (${l.region}, provider ${l.providerRegion})`,
  );
  return EXIT_SUCCESS;
}

async function cmdGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = requireLocationId(args, "get", format);
  if (id === null) return EXIT_USAGE;
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.storage.locations.get(id);
  emitSuccess(format, envelope, (l) => {
    const lines = [
      `Storage location ${l.id}`,
      `  provider: ${l.provider}`,
      `  bucket: ${l.bucketName}`,
      `  region: ${l.region}`,
      `  providerRegion: ${l.providerRegion}`,
      `  credentialRef: ${l.credentialRef}`,
      `  custody: ${l.custodyMode}`,
    ];
    if (l.endpointOverride !== null) lines.push(`  endpoint: ${l.endpointOverride}`);
    for (const [k, v] of Object.entries(l.providerParams)) lines.push(`  ${k}: ${v}`);
    lines.push(`  retired: ${l.retiredAt ?? "no"}`);
    return lines.join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdUpdate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = requireLocationId(args, "update", format);
  if (id === null) return EXIT_USAGE;

  const custodyModeFlag = args.flags["custody-mode"];
  const missing: string[] = [];
  if (custodyModeFlag !== undefined && !isOneOf(CUSTODY_VALUES, custodyModeFlag)) missing.push(`--custody-mode (${CUSTODY_VALUES.join("|")})`);
  if (args.flags["endpoint-override"] !== undefined && args.flags["clear-endpoint-override"] !== undefined) {
    missing.push("--endpoint-override and --clear-endpoint-override are mutually exclusive");
  }
  // The provider is not changeable, so an update cannot tell which provider's rules apply: only the
  // "ids are non-empty" structure is checked client-side; the mint is the source of truth.
  const providerParams = providerParamsFromUpdateFlags(args);

  const patch: Record<string, unknown> = {};
  const set = (flag: string, key: string) => { const v = args.flags[flag]; if (v !== undefined) patch[key] = v; };
  set("bucket-name", "bucketName");
  set("region", "region");
  set("provider-region", "providerRegion");
  set("credential-ref", "credentialRef");
  if (args.flags["endpoint-override"] !== undefined) patch["endpointOverride"] = args.flags["endpoint-override"];
  if (args.flags["clear-endpoint-override"] !== undefined) patch["endpointOverride"] = null;
  if (custodyModeFlag !== undefined) patch["custodyMode"] = custodyModeFlag;
  if (providerParams !== undefined) patch["providerParams"] = providerParams;

  if (Object.keys(patch).length === 0) missing.push("at least one field to change");
  if (missing.length > 0) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `k9o storage locations update: ${missing.join(", ")}`,
      context: { missing },
      recommendation: "k9o storage --help lists the UPDATE FLAGS.",
    }));
    return EXIT_USAGE;
  }

  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.storage.locations.update(id, patch);
  emitSuccess(format, envelope, (l) => `Updated storage location ${l.id} — ${l.provider}:${l.bucketName} (${l.region}, provider ${l.providerRegion})`);
  return EXIT_SUCCESS;
}

export function providerParamsFromUpdateFlags(args: ParsedArgs): StorageLocationProviderParams | undefined {
  const params: StorageLocationProviderParams = {};
  const accountId = args.flags["account-id"];
  const parentAccessKeyId = args.flags["parent-access-key-id"];
  const bucketId = args.flags["bucket-id"];
  if (accountId !== undefined) params["accountId"] = accountId;
  if (parentAccessKeyId !== undefined) params["parentAccessKeyId"] = parentAccessKeyId;
  if (bucketId !== undefined) params["bucketId"] = bucketId;
  return Object.keys(params).length > 0 ? params : undefined;
}

async function cmdRetire(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = requireLocationId(args, "retire", format);
  if (id === null) return EXIT_USAGE;
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.storage.locations.retire(id);
  emitSuccess(format, envelope, (r) => `Retired storage location ${r.id}`);
  return EXIT_SUCCESS;
}

async function cmdTest(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = requireLocationId(args, "test", format);
  if (id === null) return EXIT_USAGE;
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.storage.locations.test(id);
  emitSuccess(format, envelope, (t) =>
    `Dry run for ${t.locationId} — ${t.provider}:${t.bucketName} (${t.region}, provider ${t.providerRegion}); the live probe waits on ${t.dependencyOn}`,
  );
  return EXIT_SUCCESS;
}
