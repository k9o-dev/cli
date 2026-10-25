/**
 * `k9o me` subcommands (operator-self
 * `/me/*` cross-org canonical). Wraps `@k9o/core` `client.me.*`.
 *
 *   - k9o me profile get/update
 *   - k9o me sessions list/revoke/revoke-all
 *   - k9o me api-tokens list/create/delete
 *   - k9o me notifications list/mark-read/mark-all-read
 *   - k9o me audit-log query
 *   - k9o me data-export request/status
 */

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

function printMeHelp(): void {
  process.stdout.write(`
k9o me — your own operator profile, sessions, and tokens (cross-org)

USAGE
  k9o me <group> <verb> [args...] [flags...]

GROUPS
  profile        get|update
  sessions       list|revoke|revoke-all
  api-tokens     list|create|delete
  notifications  list|mark-read|mark-all-read
  audit-log      query               Your own cross-org audit trail
  data-export    request|status      GDPR-style data-export requests
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
    if (group === "notifications") return await dispatchMeNotifications(args);
    if (group === "audit-log") return await meAuditLogQuery(args);
    if (group === "data-export") return await dispatchMeDataExport(args);
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown me subcommand "${group}"`, context: { group }, recommendation: "Valid: profile | sessions | api-tokens | notifications | audit-log | data-export" }));
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
    emitSuccess(format, env, (p) => `${p.email} (${p.id})\n  displayName: ${p.displayName ?? "(unset)"}\n  created: ${p.createdAt}\n  lastActive: ${p.lastActiveAt ?? "(never)"}`);
    return EXIT_SUCCESS;
  }
  if (sub === "update") {
    if (args.flags["display-name"] === undefined && args.flags["clear-display-name"] !== "true") {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o me profile update requires --display-name <name> or --clear-display-name", context: {} }));
      return EXIT_USAGE;
    }
    const displayName = args.flags["clear-display-name"] === "true" ? null : args.flags["display-name"]!;
    const env = await client.me.profile.update({ displayName });
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
    const env = await client.me.sessions.list();
    emitSuccess(format, env, (sessions) => {
      if (sessions.length === 0) return "No active sessions.";
      return ["Active sessions:", ...sessions.map((s) => `  ${s.id.padEnd(20)}  ${s.current ? "*" : " "}  lastSeen=${s.lastSeenAt}  ${s.userAgent ?? "-"}`)].join("\n");
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
    emitSuccess(format, env, (r) => `Revoked ${r.revoked} session(s) (current session preserved).`);
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
      return ["API tokens:", ...tokens.map((t) => `  ${t.id.padEnd(20)}  ${t.name.padEnd(30)}  …${t.suffix}  scope=${t.scope}  expires=${t.expiresAt ?? "never"}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "create") {
    const name = args.flags["name"] ?? args.positional[3];
    if (name === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o me api-tokens create requires --name (or positional)", context: {}, recommendation: "k9o me api-tokens create ci-deploy --expires-in-days 90" }));
      return EXIT_USAGE;
    }
    const env = await client.me.apiTokens.create({
      name,
      expiresInDays: args.flags["expires-in-days"] !== undefined ? parseInt(args.flags["expires-in-days"]!, 10) : undefined,
      scope: args.flags["scope"],
    });
    emitSuccess(format, env, (t) => `Created token "${t.name}" (${t.id}).\n  Token: ${t.token}\n  ** Save this token now — it will not be shown again. **`);
    return EXIT_SUCCESS;
  }
  if (sub === "delete") {
    const tokenId = args.positional[3];
    if (tokenId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o me api-tokens delete requires <tokenId>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.me.apiTokens.delete(tokenId);
    emitSuccess(format, env, () => `Deleted token ${tokenId}.`);
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown me api-tokens subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: list | create | delete" }));
  return EXIT_USAGE;
}

async function dispatchMeNotifications(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    const env = await client.me.notifications.list({
      unreadOnly: args.flags["unread-only"] === "true",
      limit: args.flags["limit"] !== undefined ? parseInt(args.flags["limit"]!, 10) : undefined,
    });
    emitSuccess(format, env, (rows) => {
      if (rows.length === 0) return "No notifications.";
      return [`${rows.length} notification(s):`, ...rows.map((n) => `  ${n.id.padEnd(20)}  ${n.readAt === null ? "•" : " "}  ${n.createdAt}  ${n.type}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "mark-read") {
    const id = args.positional[3];
    if (id === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o me notifications mark-read requires <notificationId>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.me.notifications.markRead(id);
    emitSuccess(format, env, () => `Marked notification ${id} as read.`);
    return EXIT_SUCCESS;
  }
  if (sub === "mark-all-read") {
    const env = await client.me.notifications.markAllRead();
    emitSuccess(format, env, (r) => `Marked ${r.marked} notification(s) as read.`);
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown me notifications subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: list | mark-read | mark-all-read" }));
  return EXIT_USAGE;
}

async function meAuditLogQuery(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const env = await client.me.auditLog.query({
    since: args.flags["since"],
    until: args.flags["until"],
    type: args.flags["type"],
    limit: args.flags["limit"] !== undefined ? parseInt(args.flags["limit"]!, 10) : undefined,
  });
  emitSuccess(format, env, (events) => {
    if (events.length === 0) return "No matching operator-self audit events.";
    return [`${events.length} event(s):`, ...events.map((e) => `  ${e.occurredAt}  ${e.type}`)].join("\n");
  });
  return EXIT_SUCCESS;
}

async function dispatchMeDataExport(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "request") {
    const env = await client.me.dataExport.request({ format: (args.flags["format"] ?? "json") as "json" | "csv" });
    emitSuccess(format, env, (r) => `Data export queued. Job: ${r.jobId} (status: ${r.status}). Poll with \`k9o me data-export status ${r.jobId}\`.`);
    return EXIT_SUCCESS;
  }
  if (sub === "status") {
    const jobId = args.positional[3];
    if (jobId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o me data-export status requires <jobId>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.me.dataExport.status(jobId);
    emitSuccess(format, env, (r) => r.status === "ready" ? `Job ${r.jobId} READY. Download: ${r.downloadUrl}` : `Job ${r.jobId}: ${r.status}`);
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown me data-export subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: request | status" }));
  return EXIT_USAGE;
}
