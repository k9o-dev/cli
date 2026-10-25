/**
 * `k9o org` subcommands. Wraps `@k9o/core` `client.org.*` namespaces.
 *
 * Subcommand groups (mirrors SDK shape):
 *   - k9o org get                                — read the bound org
 *   - k9o org members list/invite/get/remove
 *   - k9o org groups list/create/get/delete
 *   - k9o org audit tail/query
 *   - k9o org smtp get/set/test/unset
 *   - k9o org roles list/grant/revoke            — wraps client.org.gate.roles
 *   - k9o org idp list/create/configure/delete   — wraps client.org.gate.idpProviders
 */

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

function printOrgHelp(): void {
  process.stdout.write(`
k9o org — org-level resources

USAGE
  k9o org <group> <verb> [args...] [flags...]

GROUPS
  get                            Read the bound org
  members  list|invite|get|remove
  groups   list|create|get|delete
  audit    tail|query            Org-plane audit (distinct from project-plane)
  smtp     get|set|test|unset    Org SMTP config
  roles    list|grant|revoke     Org-level role grants
  idp      list|configure|delete Org operator identity-provider config
`.trim() + "\n");
}

export async function dispatchOrg(args: ParsedArgs): Promise<number> {
  const group = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (group === undefined || args.flags["help"] === "true") {
    printOrgHelp();
    return group === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (group === "get") return await orgGet(args);
    if (group === "members") return await dispatchOrgMembers(args);
    if (group === "groups") return await dispatchOrgGroups(args);
    if (group === "audit") return await dispatchOrgAudit(args);
    if (group === "smtp") return await dispatchOrgSmtp(args);
    if (group === "roles") return await dispatchOrgRoles(args);
    if (group === "idp") return await dispatchOrgIdp(args);
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown org subcommand "${group}"`,
      context: { group },
      recommendation: "Valid: get | members | groups | audit | smtp | roles | idp",
    }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

// ----------------------------------------------------------------------
// k9o org get
// ----------------------------------------------------------------------

async function orgGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const env = await client.org.get();
  emitSuccess(format, env, (o) =>
    `Org ${o.slug} (${o.id})\n  name: ${o.name}\n  status: ${o.status}\n  created: ${o.createdAt}`,
  );
  return EXIT_SUCCESS;
}

// ----------------------------------------------------------------------
// k9o org members
// ----------------------------------------------------------------------

async function dispatchOrgMembers(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    const status = args.flags["status"] as "active" | "invited" | "suspended" | undefined;
    const env = await client.org.members.list({ status });
    emitSuccess(format, env, (rows) => {
      if (rows.length === 0) return "No org members.";
      return ["Org members:", ...rows.map((m) => `  ${m.email.padEnd(40)}  ${m.role.padEnd(20)}  ${m.status.padEnd(10)}  ${m.userId}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "invite") {
    const email = args.flags["email"] ?? args.positional[3];
    const role = (args.flags["role"] ?? "ORG_MEMBER") as "ORG_OWNER" | "ORG_ADMIN" | "ORG_BILLING_ADMIN" | "ORG_MEMBER";
    if (email === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org members invite requires --email", context: {}, recommendation: "k9o org members invite --email new@acme.com --role ORG_MEMBER" }));
      return EXIT_USAGE;
    }
    const env = await client.org.members.invite({ email, role });
    emitSuccess(format, env, (m) => `Invited ${m.email} as ${m.role} (${m.userId}; status=${m.status}).`);
    return EXIT_SUCCESS;
  }
  if (sub === "get") {
    const userId = args.positional[3];
    if (userId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org members get requires <userId>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.org.members.get(userId);
    emitSuccess(format, env, (m) => `Member ${m.email} (${m.userId})\n  role: ${m.role}\n  status: ${m.status}\n  joined: ${m.joinedAt}`);
    return EXIT_SUCCESS;
  }
  if (sub === "remove") {
    const userId = args.positional[3];
    if (userId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org members remove requires <userId>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.org.members.remove(userId);
    emitSuccess(format, env, () => `Removed member ${userId} from org.`);
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown org members subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: list | invite | get | remove" }));
  return EXIT_USAGE;
}

// ----------------------------------------------------------------------
// k9o org groups
// ----------------------------------------------------------------------

async function dispatchOrgGroups(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    const env = await client.org.groups.list();
    emitSuccess(format, env, (rows) => {
      if (rows.length === 0) return "No org groups.";
      return ["Org groups:", ...rows.map((g) => `  ${g.id.padEnd(20)}  ${g.name.padEnd(40)}  ${g.memberCount} members`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "create") {
    const name = args.flags["name"] ?? args.positional[3];
    if (name === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org groups create requires --name (or positional)", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.org.groups.create({ name });
    emitSuccess(format, env, (g) => `Created group ${g.name} (${g.id}).`);
    return EXIT_SUCCESS;
  }
  if (sub === "get") {
    const groupId = args.positional[3];
    if (groupId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org groups get requires <groupId>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.org.groups.get(groupId);
    emitSuccess(format, env, (g) => `Group ${g.name} (${g.id})\n  members: ${g.memberCount}\n  created: ${g.createdAt}`);
    return EXIT_SUCCESS;
  }
  if (sub === "delete") {
    const groupId = args.positional[3];
    if (groupId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org groups delete requires <groupId>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.org.groups.delete(groupId);
    emitSuccess(format, env, () => `Deleted group ${groupId}.`);
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown org groups subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: list | create | get | delete" }));
  return EXIT_USAGE;
}

// ----------------------------------------------------------------------
// k9o org audit (org-plane; distinct from project-plane k9o audit)
// ----------------------------------------------------------------------

async function dispatchOrgAudit(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "tail") {
    const sinceMinutes = args.flags["since-minutes"] !== undefined ? parseInt(args.flags["since-minutes"]!, 10) : 5;
    const limit = args.flags["limit"] !== undefined ? parseInt(args.flags["limit"]!, 10) : 100;
    const env = await client.org.auditLog.tail({ sinceMinutes, limit });
    emitSuccess(format, env, (events) => {
      if (events.length === 0) return `No org audit events in the last ${sinceMinutes} minute(s).`;
      return [`${events.length} org event(s):`, ...events.map((e) => `  ${e.occurredAt}  ${e.type.padEnd(40)}  actor=${e.actorId ?? "-"}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "query") {
    const opts = {
      since: args.flags["since"],
      until: args.flags["until"],
      type: args.flags["type"],
      actorId: args.flags["actor"],
      limit: args.flags["limit"] !== undefined ? parseInt(args.flags["limit"]!, 10) : undefined,
      cursor: args.flags["cursor"],
    };
    const env = await client.org.auditLog.query(opts);
    emitSuccess(format, env, (events) => {
      if (events.length === 0) return "No matching org audit events.";
      return [`${events.length} event(s):`, ...events.map((e) => `  ${e.occurredAt}  ${e.type.padEnd(40)}  actor=${e.actorId ?? "-"}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown org audit subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: tail | query" }));
  return EXIT_USAGE;
}

// ----------------------------------------------------------------------
// k9o org smtp
// ----------------------------------------------------------------------

async function dispatchOrgSmtp(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "get") {
    const env = await client.org.smtp.get();
    emitSuccess(format, env, (c) => c === null ? "No org-level SMTP configured (falls back to platform default per 3-tier cascade)." : `SMTP: ${c.username}@${c.host}:${c.port} (encryption=${c.encryption}; from=${c.fromName} <${c.fromEmail}>)`);
    return EXIT_SUCCESS;
  }
  if (sub === "set") {
    const required = ["host", "port", "username", "password", "from-email"];
    const missing = required.filter((f) => args.flags[f] === undefined);
    if (missing.length > 0) {
      emitError(format, new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `k9o org smtp set missing required flags: ${missing.join(", ")}`,
        context: { missing },
        recommendation: "k9o org smtp set --host smtp.example.com --port 587 --username alice --password '***' --from-email noreply@acme.com --from-name 'Acme' --encryption starttls",
      }));
      return EXIT_USAGE;
    }
    const env = await client.org.smtp.set({
      host: args.flags["host"]!,
      port: parseInt(args.flags["port"]!, 10),
      username: args.flags["username"]!,
      password: args.flags["password"]!,
      fromEmail: args.flags["from-email"]!,
      fromName: args.flags["from-name"] ?? "",
      encryption: (args.flags["encryption"] ?? "starttls") as "none" | "starttls" | "tls",
      replyToEmail: args.flags["reply-to-email"],
    });
    emitSuccess(format, env, (c) => `SMTP set to ${c.username}@${c.host}:${c.port}. Run \`k9o org smtp test --to <email>\` to verify.`);
    return EXIT_SUCCESS;
  }
  if (sub === "test") {
    const to = args.flags["to"];
    if (to === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org smtp test requires --to <email>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.org.smtp.test({ to, fromOverride: args.flags["from-override"] });
    emitSuccess(format, env, (r) => r.ok ? `Test email sent to ${to} (${r.attemptedAt})\n  ${r.diagnostic}` : `Test email FAILED:\n  ${r.diagnostic}`);
    return EXIT_SUCCESS;
  }
  if (sub === "unset") {
    const env = await client.org.smtp.unset();
    emitSuccess(format, env, () => "Cleared org-level SMTP. Falls back to platform default per 3-tier cascade.");
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown org smtp subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: get | set | test | unset" }));
  return EXIT_USAGE;
}

// ----------------------------------------------------------------------
// k9o org roles (wraps client.org.gate.roles)
// ----------------------------------------------------------------------

async function dispatchOrgRoles(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    const env = await client.org.gate.roles.list({
      userId: args.flags["user-id"],
      role: args.flags["role"] as "ORG_ADMIN" | "ORG_BILLING_ADMIN" | undefined,
      includeRevoked: args.flags["include-revoked"] === "true",
    });
    emitSuccess(format, env, (grants) => {
      if (grants.length === 0) return "No org role grants.";
      return ["Org role grants:", ...grants.map((g) => `  ${g.id.padEnd(20)}  ${g.userId.padEnd(20)}  ${g.role.padEnd(20)}  granted=${g.grantedAt}${g.revokedAt !== null ? ` revoked=${g.revokedAt}` : ""}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "grant") {
    const userId = args.flags["user-id"] ?? args.positional[3];
    const role = args.flags["role"] as "ORG_ADMIN" | "ORG_BILLING_ADMIN" | undefined;
    if (userId === undefined || role === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org roles grant requires --user-id (or positional) and --role (ORG_ADMIN | ORG_BILLING_ADMIN)", context: {}, recommendation: "k9o org roles grant u_abc --role ORG_ADMIN" }));
      return EXIT_USAGE;
    }
    const env = await client.org.gate.roles.grant({ userId, role });
    emitSuccess(format, env, (g) => `Granted ${g.role} to ${g.userId} (grant=${g.id}; by=${g.grantedBy}).`);
    return EXIT_SUCCESS;
  }
  if (sub === "revoke") {
    const grantId = args.positional[3];
    if (grantId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org roles revoke requires <grantId> (positional)", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.org.gate.roles.revoke(grantId);
    emitSuccess(format, env, (g) => `Revoked grant ${g.id} (was ${g.role} for ${g.userId}; revoked at ${g.revokedAt}).`);
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown org roles subcommand "${sub ?? "(none)"}"`, context: { sub }, recommendation: "Valid: list | grant | revoke" }));
  return EXIT_USAGE;
}

// ----------------------------------------------------------------------
// k9o org idp (wraps client.org.gate.idpProviders)
// ----------------------------------------------------------------------

async function dispatchOrgIdp(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    const env = await client.org.gate.idpProviders.list();
    emitSuccess(format, env, (rows) => {
      if (rows.length === 0) return "No org IdP providers configured.";
      return ["Org IdP providers:", ...rows.map((p) => `  ${p.id.padEnd(20)}  ${p.kind.padEnd(20)}  ${p.enabled ? "enabled" : "disabled"}  ${p.name}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "configure") {
    const idpId = args.positional[3];
    if (idpId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org idp configure requires <idpId> (positional) + at least one --name/--enabled/--config flag", context: {} }));
      return EXIT_USAGE;
    }
    const patch: { name?: string; enabled?: boolean; config?: Record<string, unknown> } = {};
    if (args.flags["name"] !== undefined) patch.name = args.flags["name"];
    if (args.flags["enable"] === "true") patch.enabled = true;
    if (args.flags["disable"] === "true") patch.enabled = false;
    if (args.flags["config"] !== undefined) {
      try {
        patch.config = JSON.parse(args.flags["config"]);
      } catch {
        emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "--config value is not valid JSON", context: {} }));
        return EXIT_USAGE;
      }
    }
    const env = await client.org.gate.idpProviders.configure(idpId, patch);
    emitSuccess(format, env, (p) => `Configured IdP ${p.name} (${p.id}); enabled=${p.enabled}.`);
    return EXIT_SUCCESS;
  }
  if (sub === "delete") {
    const idpId = args.positional[3];
    if (idpId === undefined) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o org idp delete requires <idpId>", context: {} }));
      return EXIT_USAGE;
    }
    const env = await client.org.gate.idpProviders.delete(idpId);
    emitSuccess(format, env, () => `Deleted IdP provider ${idpId}.`);
    return EXIT_SUCCESS;
  }
  emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown org idp subcommand "${sub ?? "(none)"}". (create deferred — requires per-IdP-vendor config schema knowledge; use \`k9o org idp configure\` after platform-side scaffold.)`, context: { sub }, recommendation: "Valid: list | configure | delete" }));
  return EXIT_USAGE;
}
