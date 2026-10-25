/**
 * `k9o byos-cred` subcommands — the B2 seal-plane PRE-CREATE client flow across the 5 CORE-mintable providers.
 * Pre-creates a customer cloud credential as a vault
 * secret under the customer's OWN auth and prints the `kibo://byos-creds/<secId>` reference; it does
 * NOT register the reference as a storage location — that's the separate `storage locations create` command.
 *
 * Transport: the credential travels over TLS through the platform API's
 * member-plane vault forward to kibo, which seals it. The gateway therefore DOES see it in memory for
 * that one request; only the BINDING routes are reference-only (they never take a raw credential).
 *
 * `azure_blob` has no envelope shape in the provisioning spec yet — not supported here.
 *
 * Wire to `client.kibo.vault.secrets.create` per `packages/kibo/src/vault.ts`.
 */

import { KError, encodeByosCredential, byosCredentialRef, byosCredVaultName, BYOS_PROVIDER_SCHEME } from "@k9o/core";
import type { ByosCredProvider } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

const CRED_PROVIDER_VALUES = ["s3", "s3_compatible", "minio", "gcs", "b2", "r2"] as const;

function printByosCredHelp(): void {
  process.stdout.write(`
k9o byos-cred — pre-create a BYOS (Bring-Your-Own-Store) cloud credential

USAGE
  k9o byos-cred <subcommand> [args...] [flags...]

SUBCOMMANDS
  create <name>                Pre-create a credential secret, print its credentialRef

k9o byos-cred create stores a customer cloud credential as a vault secret under YOUR
OWN auth and prints a kibo://byos-creds/<secId> reference. The credential is sent over
TLS through the platform API straight to the vault, which seals it; the platform never
stores it outside the vault and never returns it. Pass the reference as --credential-ref
to \`k9o storage locations create\` to register it as a storage location (that command takes only the reference).

<name> is always stored under the reserved byos-creds/ vault namespace — passing
"s3-prod" or "byos-creds/s3-prod" both land at byos-creds/s3-prod. This is
enforced unconditionally (not a naming convention you can opt out of): it is the
structural signal the CORE's BYOS reveal endpoint uses to tell this secret is a
BYOS credential, distinct from an ordinary install-scoped one.

  --provider <p>                 ${CRED_PROVIDER_VALUES.join(" | ")} (azure_blob not yet supported)
  --region <region>               Required for every provider (or K9O_BYOS_REGION): the platform region,
                                   a short code such as de01, that the vault write itself uses.
  --provider-region <name>        Required for s3 / s3_compatible / minio: the provider's STS and SigV4
                                   signing region (us-east-1). A provider region, never a platform one.

PER-PROVIDER FLAGS (s3 / s3_compatible / minio — aws_sigv4/sts envelope)
  --access-key-id <id>            (or K9O_BYOS_ACCESS_KEY_ID; prompted if omitted)
  --secret-access-key <key>       (or K9O_BYOS_SECRET_ACCESS_KEY; prompted if omitted)

PER-PROVIDER FLAGS (gcs — gcp_workload_identity envelope)
  --private-key-pem <pem>         Service account PKCS8 private key (or K9O_BYOS_PRIVATE_KEY_PEM)
  --client-id <email>             Service account email

PER-PROVIDER FLAGS (b2 — http_basic envelope)
  --key-id <id>                   B2 master key's keyId (sealed as username)
  --app-key <key>                 B2 master key's appKey (sealed as password; or K9O_BYOS_APP_KEY)

PER-PROVIDER FLAGS (r2 — bearer envelope)
  --api-token <token>              Cloudflare API token (or K9O_BYOS_API_TOKEN)

For s3/s3_compatible/minio, a temporary/session credential is rejected — a sealed
reference must stay valid indefinitely, so a session token would silently break
it once it expires.

Least-privilege PROVISIONING (per-provider — narrower shrinks a CORE-compromise
blast radius, since the confined cred stays resident in the CORE):
  s3/minio   IAM key needs only STS + bucket read (the session policy scopes down)
  gcs        service account with only the storage-object read role on the bucket
  b2         a bucket-RESTRICTED writeKeys master (B2 supports bucket-scoped keys)
  r2         Cloudflare API token scoped to R2 temp-credential creation on that bucket
`.trim() + "\n");
}

export async function dispatchByosCred(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printByosCredHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "create") return await cmdByosCredCreate(args);
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown byos-cred subcommand "${sub}"`,
      context: { sub },
      recommendation: "Valid: create",
    }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

async function readSecretFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const buf = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        process.stdin.pause();
        resolve(data.split("\n")[0]!);
      }
    });
  });
  return buf.trim();
}

function isCredProvider(v: string | undefined): v is ByosCredProvider {
  return v !== undefined && (CRED_PROVIDER_VALUES as readonly string[]).includes(v);
}

function usageError(message: string, recommendation: string): KError {
  return new KError({ code: "K9O_INVALID_FIELD_VALUE", message, context: {}, recommendation });
}

/** The aws_sigv4 credential's inputs. The signing region is the PROVIDER's (`--provider-region`), read here and
 *  nowhere else, so it can never be the platform `--region` of the vault write. Exported for tests. */
export async function collectSigV4Value(args: ParsedArgs, provider: string): Promise<{ accessKeyId: string; secretAccessKey: string; providerRegion: string } | KError> {
  const providerRegion = args.flags["provider-region"];
  if (providerRegion === undefined || providerRegion.length === 0) {
    return usageError(
      `k9o byos-cred create --provider ${provider} requires --provider-region <name> (the provider's STS and SigV4 signing region)`,
      "k9o byos-cred create byos/s3-prod --provider s3 --region de01 --provider-region us-east-1 ...",
    );
  }
  if (args.flags["session-token"] !== undefined) {
    return new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message:
        "a BYOS credential must be a long-lived cloud key — a session token (temporary credential) is not accepted, since it would expire and silently invalidate the credentialRef once sealed",
      context: { field: "session-token" },
      recommendation: "Create a long-lived, bucket-scoped IAM access key for this credential instead of a temporary/STS one.",
    });
  }
  const accessKeyId = args.flags["access-key-id"] ?? process.env["K9O_BYOS_ACCESS_KEY_ID"]
    ?? await readSecretFromStdin("cloud access key id: ");
  const secretAccessKey = args.flags["secret-access-key"] ?? process.env["K9O_BYOS_SECRET_ACCESS_KEY"]
    ?? await readSecretFromStdin("cloud secret access key: ");
  if (accessKeyId.length === 0 || secretAccessKey.length === 0) {
    return usageError(
      "an access key id and a secret access key are required",
      "k9o byos-cred create byos/s3-prod --provider s3 --access-key-id <id> --secret-access-key <key> --region de01 --provider-region us-east-1",
    );
  }
  return { accessKeyId, secretAccessKey, providerRegion };
}

async function cmdByosCredCreate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = args.flags["name"] ?? args.positional[2];
  if (name === undefined) {
    emitError(format, usageError("k9o byos-cred create requires --name <path> (positional or flag)", "k9o byos-cred create byos/s3-prod --provider s3 ..."));
    return EXIT_USAGE;
  }

  const providerFlag = args.flags["provider"];
  if (!isCredProvider(providerFlag)) {
    emitError(format, usageError(
      `k9o byos-cred create requires --provider (${CRED_PROVIDER_VALUES.join("|")})`,
      "k9o byos-cred --help for per-provider flags. azure_blob is not yet supported (no envelope shape).",
    ));
    return EXIT_USAGE;
  }
  const provider = providerFlag;

  const region = args.flags["region"] ?? process.env["K9O_BYOS_REGION"];
  if (region === undefined || region.length === 0) {
    emitError(format, usageError(
      "k9o byos-cred create requires --region <region> (the platform region for the vault write, a short code such as de01)",
      "k9o byos-cred create byos/s3-prod --provider s3 --region de01 --provider-region us-east-1 ...",
    ));
    return EXIT_USAGE;
  }

  let value: string;
  if (provider === "s3" || provider === "s3_compatible" || provider === "minio") {
    const cred = await collectSigV4Value(args, provider);
    if (cred instanceof KError) { emitError(format, cred); return EXIT_USAGE; }
    if (format !== "json") {
      process.stdout.write(
        "note: use a bucket-scoped, least-privilege IAM key (only STS + bucket read) — its blast radius\n" +
        "is the gateway-transient token minted from it.\n",
      );
    }
    value = encodeByosCredential({ provider, ...cred });
  } else if (provider === "gcs") {
    const privateKeyPem = args.flags["private-key-pem"] ?? process.env["K9O_BYOS_PRIVATE_KEY_PEM"]
      ?? await readSecretFromStdin("service account private key (PEM): ");
    const clientId = args.flags["client-id"];
    if (privateKeyPem.length === 0 || clientId === undefined || clientId.length === 0) {
      emitError(format, usageError("gcs requires --private-key-pem and --client-id", "k9o byos-cred create byos/gcs-prod --provider gcs --private-key-pem-file ... --client-id sa@project.iam.gserviceaccount.com"));
      return EXIT_USAGE;
    }
    if (format !== "json") {
      process.stdout.write("note: use a service account with only the storage-object read role on the bucket.\n");
    }
    value = encodeByosCredential({ provider: "gcs", privateKeyPem, clientId });
  } else if (provider === "b2") {
    const keyId = args.flags["key-id"] ?? await readSecretFromStdin("B2 master key id: ");
    const appKey = args.flags["app-key"] ?? process.env["K9O_BYOS_APP_KEY"] ?? await readSecretFromStdin("B2 master app key: ");
    if (keyId.length === 0 || appKey.length === 0) {
      emitError(format, usageError("b2 requires --key-id and --app-key", "k9o byos-cred create byos/b2-prod --provider b2 --key-id ... --app-key ..."));
      return EXIT_USAGE;
    }
    if (format !== "json") {
      process.stdout.write("note: use a bucket-RESTRICTED writeKeys master (B2 supports bucket-scoped keys).\n");
    }
    value = encodeByosCredential({ provider: "b2", keyId, appKey });
  } else {
    const apiToken = args.flags["api-token"] ?? process.env["K9O_BYOS_API_TOKEN"] ?? await readSecretFromStdin("Cloudflare API token: ");
    if (apiToken.length === 0) {
      emitError(format, usageError("r2 requires --api-token", "k9o byos-cred create byos/r2-prod --provider r2 --api-token ..."));
      return EXIT_USAGE;
    }
    if (format !== "json") {
      process.stdout.write("note: scope the API token to R2 temp-credential creation on this account/bucket, not a global token.\n");
    }
    value = encodeByosCredential({ provider: "r2", apiToken });
  }

  // Always stored under the reserved byos-creds/ vault namespace — a structural signal the reveal
  // endpoint's class gate can check authoritatively; not opt-in.
  const vaultName = byosCredVaultName(name);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.kibo.vault.secrets.create({ name: vaultName, value, region, visibility: { kind: "private" } });
  const credentialRef = byosCredentialRef(envelope.data.id);

  emitSuccess(
    format,
    { data: { ...envelope.data, credentialRef, scheme: BYOS_PROVIDER_SCHEME[provider] }, meta: envelope.meta },
    (d) =>
      `Sealed BYOS credential as secret ${d.name} (${d.id}) — scheme=${d.scheme}\n` +
      `credentialRef: ${d.credentialRef}\n` +
      `Pass this to \`k9o storage locations create --credential-ref ${d.credentialRef} ...\` to register it.`,
  );
  return EXIT_SUCCESS;
}
