/**
 * `k9o me` subcommands (operator-self `/me/*`, cross-org). Wraps `@k9o/core` `client.me.*`.
 *
 *   - k9o me profile get/update
 *   - k9o me sessions list/revoke/revoke-all
 *   - k9o me api-tokens list/create/delete
 */

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { wire, type WireSession } from "../wire.ts";

function printMeHelp(): void {
  process.stdout.write(`
k9o me — your own operator profile, sessions, and tokens (cross-org)

USAGE
  k9o me <group> <verb> [args...] [flags...]

GROUPS
  profile        get|update          update: --display-name <name>
  sessions       list|revoke|revoke-all   revoke-all keeps this device signed in
  api-tokens     list|create|delete
                 create: <label> [--operations read,write,admin] [--projects <slug,...>]
                         [--resource-classes <a,b>] [--cidrs <cidr,...>] [--ttl-days <n>]
`.trim() + "\n");
}

export async function dispatchMe(args: ParsedArgs): Promise<number> {
  const group = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (group === undefined || args.flags["help"] === "true") {
    printMeHelp();
    return group === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (group === "profile") return await dispatchMeProfile(args);
    if (group === "sessions") return await dispatchMeSessions(args);
    if (group === "api-tokens") return await dispatchMeApiTokens(args);
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown me subcommand "${group}"`, context: { group }, recommendation: "Valid: profile | sessions | api-tokens" }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

async function dispatchMeProfile(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "get") {
    const env = await client.me.profile.get();
    emitSuccess(format, env, (p) => `${p.email} (${p.id})\n  displayName: ${p.displayName ?? "(unset)"}\n  mfa enabled: ${(p as unknown as { mfaEnabled?: boolean }).mfaEnabled === true ? "yes" : "no"}\n  created: ${p.createdAt}`);
    return EXIT_SUCCESS;
  }
  if (sub === "update") {
    if (args.flags["display-name"] === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o me profile update requires --display-name <name>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.me.profile.update({ displayName: args.flags["display-name"] });
    emitSuccess(format, env, (p) => `Updated profile. displayName=${p.displayName ?? "(unset)"}`);
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown me profile subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: get | update" }));
  return EXIT_USAGE;
}

async function dispatchMeSessions(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    const env = wire<ReadonlyArray<WireSession>>(await client.me.sessions.list());
    emitSuccess(format, env, (sessions) => {
      if (sessions.length === 0) return "No active sessions.";
      return ["Active sessions (* = this one):", ...sessions.map((s) => `  ${s.id.padEnd(20)}  ${s.isCurrentSession ? "*" : " "}  issued=${s.issuedAt}  expires=${s.expiresAt}  ${s.ipAddress ?? "-"}  ${s.userAgent ?? "-"}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "revoke") {
    const sessionId = args.positional[3];
    if (sessionId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o me sessions revoke requires <sessionId>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.me.sessions.revoke(sessionId);
    emitSuccess(format, env, () => `Revoked session ${sessionId}.`);
    return EXIT_SUCCESS;
  }
  if (sub === "revoke-all") {
    const env = await client.me.sessions.revokeAll();
    emitSuccess(format, env, (r) => `Revoked ${r.revoked} other session(s); this one stays signed in.`);
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown me sessions subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: list | revoke | revoke-all" }));
  return EXIT_USAGE;
}

async function dispatchMeApiTokens(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    const env = await client.me.apiTokens.list();
    emitSuccess(format, env, (tokens) => {
      if (tokens.length === 0) return "No API tokens.";
      return ["API tokens:", ...tokens.map((t) => `  ${t.id.padEnd(20)}  ${t.label.padEnd(30)}  ${t.status.padEnd(8)}  expires=${t.expiresAt}  last used=${t.lastUsedAt ?? "never"}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "create") {
    const label = args.flags["label"] ?? args.flags["name"] ?? args.positional[3];
    if (label === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o me api-tokens create requires a label (positional or --label)", context: {}, recommendation: "k9o me api-tokens create ci-deploy --operations read,write --ttl-days 90" }));
      return EXIT_USAGE;
    }
    const list = (flag: string): string[] | undefined =>
      args.flags[flag] !== undefined ? args.flags[flag]!.split(",").map((x) => x.trim()).filter((x) => x.length > 0) : undefined;
    const operations = list("operations");
    const allowed = ["read", "write", "admin"];
    if (operations !== undefined && operations.some((o) => !allowed.includes(o))) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `invalid --operations "${args.flags["operations"]}"`, context: {}, recommendation: `Valid: ${allowed.join(" | ")} (comma-separated)` }));
      return EXIT_USAGE;
    }
    const projects = list("projects");
    const resourceClasses = list("resource-classes");
    const cidrs = list("cidrs");
    const ttlDays = args.flags["ttl-days"] ?? args.flags["expires-in-days"];
    const env = await client.me.apiTokens.create({
      label,
      scopeManifest: {
        ...(operations !== undefined ? { operations: operations as Array<"read" | "write" | "admin"> } : {}),
        ...(projects !== undefined ? { projects } : {}),
        ...(resourceClasses !== undefined ? { resourceClasses } : {}),
        ...(cidrs !== undefined ? { cidrs } : {}),
      },
      ...(ttlDays !== undefined ? { ttlSeconds: parseInt(ttlDays, 10) * 86_400 } : {}),
    });
    emitSuccess(format, env, (t) => `Created token "${t.label}" (${t.id}); expires ${t.expiresAt}.\n  Token: ${t.plaintext}\n  ** Save this token now — it will not be shown again. **`);
    return EXIT_SUCCESS;
  }
  if (sub === "delete") {
    const tokenId = args.positional[3];
    if (tokenId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o me api-tokens delete requires <tokenId>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.me.apiTokens.delete(tokenId);
    emitSuccess(format, env, () => `Revoked token ${tokenId}.`);
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown me api-tokens subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: list | create | delete" }));
  return EXIT_USAGE;
}
