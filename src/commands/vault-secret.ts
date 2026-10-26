/**
 * `k9o vault-secret` subcommands — the vault-secrets family: list / get / create /
 * reveal / update / rotate / move / delete. Thin wrapper over `client.kibo.vault.secrets.*`
 * (`packages/kibo/src/vault.ts`) — see that file for the live-verified contract (region requirement,
 * base64 wire encoding).
 *
 * `reveal` combines `revealChallenge` + `reveal` into one command — the two-step dance is an
 * implementation detail the CLI caller shouldn't have to manage by hand.
 */

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

function printVaultSecretHelp(): void {
  process.stdout.write(`
k9o vault-secret — the vault-secrets family (list/get/create/reveal/update/rotate/move/delete)

USAGE
  k9o vault-secret <subcommand> [args...] [flags...]

SUBCOMMANDS
  list [--prefix] [--cursor] [--limit]        List secrets (metadata only)
  get <name> --region <region>                Read a secret's metadata
  create <name> --region <region>             Seal a new secret
  reveal <name> --region <region>             Mint a challenge + reveal the plaintext in one call
  update <name> --region <region>             Set a new value (bumps version)
  rotate <name> --region <region>             Re-wrap under a fresh key (content unchanged)
  move <name> --new-path <path> --region <region>   Rename a secret's hierarchical path
  delete <name> --region <region>             Retire a secret

Every operation on a named secret (everything but \`list\`) requires --region; the gateway fail-closes
without it.

CREATE/UPDATE FLAGS
  --value <value>       The plaintext to seal (or prompted if omitted; never both flag+prompt)
  --visibility <kind>   private | shared (create only, default: private)
  --metadata k=v,k2=v2  Comma-separated non-secret labels
`.trim() + "\n");
}

export async function dispatchVaultSecret(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printVaultSecretHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdList(args);
    if (sub === "get") return await cmdGet(args);
    if (sub === "create") return await cmdCreate(args);
    if (sub === "reveal") return await cmdReveal(args);
    if (sub === "update") return await cmdUpdate(args);
    if (sub === "rotate") return await cmdRotate(args);
    if (sub === "move") return await cmdMove(args);
    if (sub === "delete") return await cmdDelete(args);
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown vault-secret subcommand "${sub}"`,
      context: { sub },
      recommendation: "Valid: list | get | create | reveal | update | rotate | move | delete",
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

function requireName(args: ParsedArgs, format: ReturnType<typeof resolveOutputFormat>): string | null {
  const name = args.flags["name"] ?? args.positional[2];
  if (name === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o vault-secret requires <name> (positional or --name)",
      context: {},
      recommendation: null,
    }));
    return null;
  }
  return name;
}

function requireRegion(args: ParsedArgs, format: ReturnType<typeof resolveOutputFormat>): string | null {
  const region = args.flags["region"];
  if (region === undefined || region.length === 0) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "this subcommand requires --region <region>",
      context: {},
      recommendation: null,
    }));
    return null;
  }
  return region;
}

function parseMetadataFlag(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const metadata: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    metadata[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return metadata;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args, { requireProject: true });
  const prefixFlag = args.flags["prefix"];
  const cursorFlag = args.flags["cursor"];
  const limitFlag = args.flags["limit"];
  const envelope = await client.kibo.vault.secrets.list({
    ...(prefixFlag !== undefined ? { prefix: prefixFlag } : {}),
    ...(cursorFlag !== undefined ? { cursor: cursorFlag } : {}),
    ...(limitFlag !== undefined ? { limit: Number(limitFlag) } : {}),
  });
  emitSuccess(format, envelope, (d) => {
    if (d.secrets.length === 0) return "No secrets.";
    const rows = d.secrets.map((s) => `  ${s.name.padEnd(40)}  v${s.version}  ${s.id}`);
    return ["Secrets:", ...rows].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = requireName(args, format);
  if (name === null) return EXIT_USAGE;
  const region = requireRegion(args, format);
  if (region === null) return EXIT_USAGE;
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.kibo.vault.secrets.get(name, { region });
  emitSuccess(format, envelope, (s) =>
    `${s.name} (${s.id})\n  version: ${s.version}\n  kid: ${s.kid}\n  visibility: ${s.visibility.kind}\n  updated: ${s.updatedAt}`,
  );
  return EXIT_SUCCESS;
}

async function cmdCreate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = requireName(args, format);
  if (name === null) return EXIT_USAGE;
  const region = requireRegion(args, format);
  if (region === null) return EXIT_USAGE;
  const value = args.flags["value"] ?? await readSecretFromStdin("value: ");
  const visibilityFlag = args.flags["visibility"] ?? "private";
  if (visibilityFlag !== "private" && visibilityFlag !== "shared") {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "--visibility must be private or shared", context: {}, recommendation: null }));
    return EXIT_USAGE;
  }
  const metadata = parseMetadataFlag(args.flags["metadata"]);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.kibo.vault.secrets.create({
    name, value, region,
    visibility: { kind: visibilityFlag },
    ...(metadata !== undefined ? { metadata } : {}),
  });
  emitSuccess(format, envelope, (s) => `Sealed ${s.name} (${s.id}), version ${s.version}`);
  return EXIT_SUCCESS;
}

async function cmdReveal(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = requireName(args, format);
  if (name === null) return EXIT_USAGE;
  const region = requireRegion(args, format);
  if (region === null) return EXIT_USAGE;
  const { client } = clientFromProfile(args, { requireProject: true });
  const chal = await client.kibo.vault.secrets.revealChallenge(name, { region });
  const envelope = await client.kibo.vault.secrets.reveal(name, { region, challenge: chal.data.challenge });
  emitSuccess(format, envelope, (r) => r.value);
  return EXIT_SUCCESS;
}

async function cmdUpdate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = requireName(args, format);
  if (name === null) return EXIT_USAGE;
  const region = requireRegion(args, format);
  if (region === null) return EXIT_USAGE;
  const value = args.flags["value"] ?? await readSecretFromStdin("new value: ");
  const metadata = parseMetadataFlag(args.flags["metadata"]);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.kibo.vault.secrets.update(name, { region, value, ...(metadata !== undefined ? { metadata } : {}) });
  emitSuccess(format, envelope, (s) => `Updated ${s.name} (${s.id}) to version ${s.version}`);
  return EXIT_SUCCESS;
}

async function cmdRotate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = requireName(args, format);
  if (name === null) return EXIT_USAGE;
  const region = requireRegion(args, format);
  if (region === null) return EXIT_USAGE;
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.kibo.vault.secrets.rotate(name, { region });
  emitSuccess(format, envelope, (s) => `Rotated ${s.name} (${s.id}) to version ${s.version} at ${s.rotatedAt}`);
  return EXIT_SUCCESS;
}

async function cmdMove(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = requireName(args, format);
  if (name === null) return EXIT_USAGE;
  const region = requireRegion(args, format);
  if (region === null) return EXIT_USAGE;
  const newPath = args.flags["new-path"];
  if (newPath === undefined) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "move requires --new-path <path>", context: {}, recommendation: null }));
    return EXIT_USAGE;
  }
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.kibo.vault.secrets.move(name, { region, newPath });
  emitSuccess(format, envelope, (s) => `Moved to ${s.name} (${s.id})`);
  return EXIT_SUCCESS;
}

async function cmdDelete(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = requireName(args, format);
  if (name === null) return EXIT_USAGE;
  const region = requireRegion(args, format);
  if (region === null) return EXIT_USAGE;
  const { client } = clientFromProfile(args, { requireProject: true });
  await client.kibo.vault.secrets.delete(name, { region });
  emitSuccess(format, { data: { name, deleted: true }, meta: {} }, (d) => `Retired ${d.name}`);
  return EXIT_SUCCESS;
}
