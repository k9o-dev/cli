/**
 * `k9o org` subcommands. Wraps `@k9o/core` `client.org.*` namespaces.
 *
 *   - k9o org get                                — read the bound org
 *   - k9o org members list/invite/remove
 *   - k9o org groups list/get                    — identity-provider groups, read-only
 *   - k9o org audit query                        — org-plane audit (filters: --type, --limit)
 *   - k9o org smtp set/test/unset
 *   - k9o org roles list/grant/revoke            — wraps client.org.gate.roles
 *   - k9o org idp list/create/configure/delete   — wraps client.org.gate.idpProviders
 */

import { KError, type CreateOrgIdpInput } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { wire, type WireOrg, type WireMember, type WireInviteResult, type WireOrgAuditEvent, type WireSmtpTestResult } from "../wire.ts";

function printOrgHelp(): void {
  process.stdout.write(`
k9o org — org-level resources

USAGE
  k9o org <group> <verb> [args...] [flags...]

GROUPS
  get                            Read the bound org
  members  list|invite|remove    list: --status active|suspended, --state invited|active|suspended, --role <role>
                                 invite: --email <email> [--role ORG_MEMBER|ORG_ADMIN|ORG_BILLING_ADMIN|ORG_OWNER]
  groups   list|get              Identity-provider groups (read-only)
  audit    query                 Org-plane audit, newest first (--type <event type>, --limit <n>)
  smtp     set|test|unset        Org SMTP config
                                 set: --host --port --username --password-ref --from-address [--from-name]
                                 test: --to <email> [--subject <text>]
  roles    list|grant|revoke     Org-level role grants
                                 grant: <userId> --role ORG_ADMIN|ORG_BILLING_ADMIN|ORG_AUDITOR|ORG_MEMBER|ORG_OWNER [--reason <text>]
  idp      list|create|configure|delete   Org operator identity providers
                                 create: --provider <kind> --display-name --client-id --client-secret-ref
                                         --tier-gating free_tier_ok|ridge_plus [--redirect-uri] [--metadata-url]
                                         [--attribute-map <json>] [--disabled]
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
  const env = wire<WireOrg>(await client.org.get());
  emitSuccess(format, env, (o) =>
    `Org ${o.slug ?? "(no slug)"} (${o.id})\n  name: ${o.displayName}\n  billing tier: ${o.billingTier ?? "-"}\n  your role: ${o.role ?? "-"}\n  created: ${o.createdAt}`,
  );
  return EXIT_SUCCESS;
}

function usageError(format: ReturnType<typeof resolveOutputFormat>, message: string, recommendation?: string): number {
  emitError(format, new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message,
    context: {},
    ...(recommendation !== undefined ? { recommendation } : {}),
  }));
  return EXIT_USAGE;
}

// ----------------------------------------------------------------------
// k9o org members
// ----------------------------------------------------------------------

type OrgRole = "ORG_OWNER" | "ORG_ADMIN" | "ORG_BILLING_ADMIN" | "ORG_MEMBER";
const MEMBER_ROLES: ReadonlyArray<OrgRole> = ["ORG_OWNER", "ORG_ADMIN", "ORG_BILLING_ADMIN", "ORG_MEMBER"];

async function dispatchOrgMembers(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    // `invited` is a derived state, not a stored status; the route filters it through `state`.
    const status = args.flags["status"];
    const state = args.flags["state"] ?? (status === "invited" ? "invited" : undefined);
    const env = wire<ReadonlyArray<WireMember>>(await client.org.members.list({
      ...(status === "active" || status === "suspended" ? { status } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(args.flags["role"] !== undefined ? { role: args.flags["role"] as OrgRole } : {}),
    }));
    emitSuccess(format, env, (rows) => {
      if (rows.length === 0) return "No org members.";
      return ["Org members:", ...rows.map((m) => `  ${m.email.padEnd(40)}  ${m.role.padEnd(20)}  ${m.state.padEnd(10)}  ${m.userId}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "invite") {
    const email = args.flags["email"] ?? args.positional[3];
    const role = (args.flags["role"] ?? "ORG_MEMBER") as OrgRole;
    if (email === undefined) {
      return usageError(format, "k9o org members invite requires --email", "k9o org members invite --email new@acme.com --role ORG_MEMBER");
    }
    if (!MEMBER_ROLES.includes(role)) {
      return usageError(format, `invalid --role "${role}"`, `Valid: ${MEMBER_ROLES.join(" | ")}`);
    }
    const env = wire<WireInviteResult>(await client.org.members.invite({ email, role }));
    emitSuccess(format, env, (m) =>
      m.invitation !== undefined
        ? `Invited ${m.invitation.email} as ${m.invitation.role}; the invitation expires ${m.invitation.expiresAt}.`
        : `Added ${m.email} as ${m.role} (${m.userId}; state=${m.state}).`,
    );
    return EXIT_SUCCESS;
  }
  if (sub === "remove") {
    const userId = args.positional[3];
    if (userId === undefined) {
      return usageError(format, "k9o org members remove requires <userId>");
    }
    const env = await client.org.members.remove(userId);
    emitSuccess(format, env, () => `Removed member ${userId} from org.`);
    return EXIT_SUCCESS;
  }
  return usageError(format, `unknown org members subcommand "${sub ?? "(none)"}"`, "Valid: list | invite | remove");
}

// ----------------------------------------------------------------------
// k9o org groups (identity-provider groups; read-only)
// ----------------------------------------------------------------------

type WireGroup = { id: string; name: string; description: string | null; source: string; createdAt: string };

async function dispatchOrgGroups(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    const env = wire<ReadonlyArray<WireGroup>>(await client.org.groups.list(
      args.flags["user-id"] !== undefined ? { userId: args.flags["user-id"] } : undefined,
    ));
    emitSuccess(format, env, (rows) => {
      if (rows.length === 0) return "No org groups.";
      return ["Org groups:", ...rows.map((g) => `  ${g.id.padEnd(40)}  ${g.name.padEnd(40)}  ${g.source}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "get") {
    const groupId = args.positional[3];
    if (groupId === undefined) {
      return usageError(format, "k9o org groups get requires <groupId>");
    }
    const env = wire<WireGroup>(await client.org.groups.get(groupId));
    emitSuccess(format, env, (g) => `Group ${g.name} (${g.id})\n  source: ${g.source}\n  created: ${g.createdAt}`);
    return EXIT_SUCCESS;
  }
  return usageError(format, `unknown org groups subcommand "${sub ?? "(none)"}"`, "Valid: list | get");
}

// ----------------------------------------------------------------------
// k9o org audit (org-plane; distinct from project-plane k9o audit)
// ----------------------------------------------------------------------

async function dispatchOrgAudit(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];

  if (sub === "query") {
    // The org audit route filters by event type and limit only (newest first, at most 500).
    for (const gone of ["since", "until", "actor", "cursor"]) {
      if (args.flags[gone] !== undefined) {
        return usageError(format, `--${gone} is not supported by org audit: the route filters by --type and --limit only`);
      }
    }
    const { client } = clientFromProfile(args);
    const env = wire<ReadonlyArray<WireOrgAuditEvent>>(await client.org.auditLog.query({
      type: args.flags["type"],
      limit: args.flags["limit"] !== undefined ? parseInt(args.flags["limit"]!, 10) : undefined,
    }));
    emitSuccess(format, env, (events) => {
      if (events.length === 0) return "No matching org audit events.";
      return [`${events.length} event(s), newest first:`, ...events.map((e) => `  ${e.createdAt}  ${e.type.padEnd(40)}  actor=${e.actorId ?? "-"}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  return usageError(format, `unknown org audit subcommand "${sub ?? "(none)"}"`, "Valid: query");
}

// ----------------------------------------------------------------------
// k9o org smtp
// ----------------------------------------------------------------------

async function dispatchOrgSmtp(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "set") {
    if (args.flags["password"] !== undefined) {
      return usageError(format, "org SMTP takes a reference to a stored secret, not the password: use --password-ref", "k9o org smtp set --host smtp.example.com --port 587 --username alice --password-ref <secret ref> --from-address noreply@acme.com");
    }
    const required = ["host", "port", "username", "password-ref", "from-address"];
    const missing = required.filter((f) => args.flags[f] === undefined);
    if (missing.length > 0) {
      return usageError(
        format,
        `k9o org smtp set missing required flags: ${missing.join(", ")}`,
        "k9o org smtp set --host smtp.example.com --port 587 --username alice --password-ref <secret ref> --from-address noreply@acme.com [--from-name 'Acme']",
      );
    }
    const port = parseInt(args.flags["port"]!, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return usageError(format, `invalid --port "${args.flags["port"]}"`, "Use a port between 1 and 65535.");
    }
    const host = args.flags["host"]!;
    const username = args.flags["username"]!;
    // The route answers with the updated org, not the SMTP block, so report from the input.
    const env = await client.org.smtp.set({
      host,
      port,
      username,
      passwordRef: args.flags["password-ref"]!,
      fromAddress: args.flags["from-address"]!,
      ...(args.flags["from-name"] !== undefined ? { fromName: args.flags["from-name"] } : {}),
    });
    emitSuccess(format, env, () => `SMTP set to ${username}@${host}:${port}. Run \`k9o org smtp test --to <email>\` to verify.`);
    return EXIT_SUCCESS;
  }
  if (sub === "test") {
    const to = args.flags["to"];
    if (to === undefined) {
      return usageError(format, "k9o org smtp test requires --to <email>");
    }
    const env = wire<WireSmtpTestResult>(await client.org.smtp.test({
      to,
      ...(args.flags["subject"] !== undefined ? { subject: args.flags["subject"] } : {}),
    }));
    emitSuccess(format, env, (r) =>
      r.accepted
        ? `Test email accepted for ${r.to} (SMTP resolved from: ${r.resolvedTier}).${r.dryRun ? "\n  Dry run: the gateway validated the configuration but did not send a message." : ""}`
        : `Test email was not accepted for ${r.to}.`,
    );
    return EXIT_SUCCESS;
  }
  if (sub === "unset") {
    const env = await client.org.smtp.unset();
    emitSuccess(format, env, () => "Cleared org-level SMTP. Mail falls back to the platform default.");
    return EXIT_SUCCESS;
  }
  return usageError(format, `unknown org smtp subcommand "${sub ?? "(none)"}"`, "Valid: set | test | unset");
}

// ----------------------------------------------------------------------
// k9o org roles (wraps client.org.gate.roles)
// ----------------------------------------------------------------------

type GrantRole = "ORG_OWNER" | "ORG_ADMIN" | "ORG_BILLING_ADMIN" | "ORG_AUDITOR" | "ORG_MEMBER";
const GRANT_ROLES: ReadonlyArray<GrantRole> = ["ORG_OWNER", "ORG_ADMIN", "ORG_BILLING_ADMIN", "ORG_AUDITOR", "ORG_MEMBER"];

async function dispatchOrgRoles(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    const env = await client.org.gate.roles.list();
    emitSuccess(format, env, (grants) => {
      if (grants.length === 0) return "No org role grants.";
      return ["Org role grants:", ...grants.map((g) => `  ${g.id.padEnd(20)}  ${g.userId.padEnd(20)}  ${g.role.padEnd(20)}  granted=${g.grantedAt}${g.revokedAt !== null ? ` revoked=${g.revokedAt}` : ""}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "grant") {
    const userId = args.flags["user-id"] ?? args.positional[3];
    const role = args.flags["role"] as GrantRole | undefined;
    if (userId === undefined || role === undefined) {
      return usageError(format, `k9o org roles grant requires <userId> (or --user-id) and --role (${GRANT_ROLES.join(" | ")})`, "k9o org roles grant u_abc --role ORG_ADMIN");
    }
    if (!GRANT_ROLES.includes(role)) {
      return usageError(format, `invalid --role "${role}"`, `Valid: ${GRANT_ROLES.join(" | ")}`);
    }
    const env = await client.org.gate.roles.grant({
      userId,
      role,
      ...(args.flags["reason"] !== undefined ? { decisionReason: args.flags["reason"] } : {}),
    });
    emitSuccess(format, env, (g) => `Granted ${g.role} to ${g.userId} (grant=${g.id}; by=${g.grantedBy}).`);
    return EXIT_SUCCESS;
  }
  if (sub === "revoke") {
    const grantId = args.positional[3];
    if (grantId === undefined) {
      return usageError(format, "k9o org roles revoke requires <grantId> (positional)");
    }
    const env = await client.org.gate.roles.revoke(grantId, args.flags["reason"] !== undefined ? { decisionReason: args.flags["reason"] } : undefined);
    emitSuccess(format, env, (g) => `Revoked grant ${g.id} (was ${g.role} for ${g.userId}; revoked at ${g.revokedAt}).`);
    return EXIT_SUCCESS;
  }
  return usageError(format, `unknown org roles subcommand "${sub ?? "(none)"}"`, "Valid: list | grant | revoke");
}

// ----------------------------------------------------------------------
// k9o org idp (wraps client.org.gate.idpProviders)
// ----------------------------------------------------------------------

function parseJsonFlag(format: ReturnType<typeof resolveOutputFormat>, flag: string, raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; code: number } {
  try {
    const v = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
  } catch {
    // fall through to the usage error
  }
  return { ok: false, code: usageError(format, `--${flag} must be a JSON object`) };
}

async function dispatchOrgIdp(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const sub = args.positional[2];
  const { client } = clientFromProfile(args);

  if (sub === "list") {
    const env = await client.org.gate.idpProviders.list();
    emitSuccess(format, env, (rows) => {
      if (rows.length === 0) return "No org IdP providers configured.";
      return ["Org IdP providers:", ...rows.map((p) => `  ${p.id.padEnd(20)}  ${p.idpProvider.padEnd(18)}  ${p.enabled ? "enabled " : "disabled"}  ${p.displayName}`)].join("\n");
    });
    return EXIT_SUCCESS;
  }
  if (sub === "create") {
    const required = ["provider", "display-name", "client-id", "client-secret-ref", "tier-gating"];
    const missing = required.filter((f) => args.flags[f] === undefined);
    if (missing.length > 0) {
      return usageError(
        format,
        `k9o org idp create missing required flags: ${missing.join(", ")}`,
        "k9o org idp create --provider oidc --display-name 'Acme SSO' --client-id <id> --client-secret-ref <secret ref> --tier-gating free_tier_ok",
      );
    }
    const tierGating = args.flags["tier-gating"]!;
    if (tierGating !== "free_tier_ok" && tierGating !== "ridge_plus") {
      return usageError(format, `invalid --tier-gating "${tierGating}"`, "Valid: free_tier_ok | ridge_plus");
    }
    let attributeMap: Record<string, unknown> | undefined;
    if (args.flags["attribute-map"] !== undefined) {
      const parsed = parseJsonFlag(format, "attribute-map", args.flags["attribute-map"]);
      if (!parsed.ok) return parsed.code;
      attributeMap = parsed.value;
    }
    const env = await client.org.gate.idpProviders.create({
      idpProvider: args.flags["provider"] as CreateOrgIdpInput["idpProvider"],
      displayName: args.flags["display-name"]!,
      clientId: args.flags["client-id"]!,
      clientSecretRef: args.flags["client-secret-ref"]!,
      tierGating,
      ...(args.flags["redirect-uri"] !== undefined ? { redirectUri: args.flags["redirect-uri"] } : {}),
      ...(args.flags["metadata-url"] !== undefined ? { metadataUrl: args.flags["metadata-url"] } : {}),
      ...(attributeMap !== undefined ? { attributeMap } : {}),
      ...(args.flags["disabled"] === "true" ? { enabled: false } : {}),
    });
    emitSuccess(format, env, (p) => `Created IdP ${p.displayName} (${p.id}; ${p.idpProvider}); enabled=${p.enabled}.`);
    return EXIT_SUCCESS;
  }
  if (sub === "configure") {
    const idpId = args.positional[3];
    if (idpId === undefined) {
      return usageError(format, "k9o org idp configure requires <idpId> (positional) + at least one of --display-name, --client-id, --client-secret-ref, --redirect-uri, --metadata-url, --attribute-map, --enable, --disable");
    }
    const patch: {
      displayName?: string; clientId?: string; clientSecretRef?: string; redirectUri?: string;
      metadataUrl?: string; attributeMap?: Record<string, unknown>; enabled?: boolean;
    } = {};
    if (args.flags["display-name"] !== undefined) patch.displayName = args.flags["display-name"];
    if (args.flags["client-id"] !== undefined) patch.clientId = args.flags["client-id"];
    if (args.flags["client-secret-ref"] !== undefined) patch.clientSecretRef = args.flags["client-secret-ref"];
    if (args.flags["redirect-uri"] !== undefined) patch.redirectUri = args.flags["redirect-uri"];
    if (args.flags["metadata-url"] !== undefined) patch.metadataUrl = args.flags["metadata-url"];
    if (args.flags["enable"] === "true") patch.enabled = true;
    if (args.flags["disable"] === "true") patch.enabled = false;
    if (args.flags["attribute-map"] !== undefined) {
      const parsed = parseJsonFlag(format, "attribute-map", args.flags["attribute-map"]);
      if (!parsed.ok) return parsed.code;
      patch.attributeMap = parsed.value;
    }
    if (Object.keys(patch).length === 0) {
      return usageError(format, "k9o org idp configure needs at least one field to change", "k9o org idp configure oic_abc --disable");
    }
    const env = await client.org.gate.idpProviders.configure(idpId, patch);
    emitSuccess(format, env, (p) => `Configured IdP ${p.displayName} (${p.id}); enabled=${p.enabled}.`);
    return EXIT_SUCCESS;
  }
  if (sub === "delete") {
    const idpId = args.positional[3];
    if (idpId === undefined) {
      return usageError(format, "k9o org idp delete requires <idpId>");
    }
    const env = await client.org.gate.idpProviders.delete(idpId);
    emitSuccess(format, env, () => `Deleted IdP provider ${idpId}.`);
    return EXIT_SUCCESS;
  }
  return usageError(format, `unknown org idp subcommand "${sub ?? "(none)"}"`, "Valid: list | create | configure | delete");
}
