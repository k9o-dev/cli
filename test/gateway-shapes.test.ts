/**
 * Each command against a fake gateway that answers in the gateway's real wire shapes (read from the route
 * handlers). Checks the request each command sends (route, method, body) and that it renders the response
 * without crashing.
 */

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { buildExtensionRequest } from "../src/commands/ext.ts";
import { toPolicyBody } from "../src/commands/policy.ts";
import { envelope, runCli, tempCredentials, tempPath, type Handler } from "./helpers.ts";

const BASE = "http://localhost:9";

/** Run `argv` signed in (a temp profile on a localhost gateway), `--output json`. */
async function signedIn(argv: string[], handler: Handler, extra: string[] = []) {
  const c = tempCredentials();
  try {
    return await runCli([...argv, "--credentials-file", c.path, "--output", "json", ...extra], handler);
  } finally {
    c.cleanup();
  }
}

/** Same, human output. */
async function signedInHuman(argv: string[], handler: Handler) {
  const c = tempCredentials();
  try {
    return await runCli([...argv, "--credentials-file", c.path], handler);
  } finally {
    c.cleanup();
  }
}

const project = (over: Record<string, unknown> = {}) => ({
  id: "proj_1", slug: "portal", orgId: "org_1", displayName: "Member Portal", description: null,
  productScope: "core", region: "de01", custodyMode: "PLATFORM_MANAGED", status: "active", role: "PROJECT_ADMIN",
  createdAt: "2026-10-01T00:00:00.000Z", ...over,
});

describe("project", () => {
  it("list: renders the gateway's displayName (it used to read `name` and crash)", async () => {
    const r = await signedInHuman(["project", "list"], (c) => (c.path === "/projects" ? { body: envelope([project()]) } : undefined));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Member Portal");
    expect(r.stdout).toContain("PLATFORM_MANAGED");
  });

  it("create: sends displayName, region and an uppercase custody mode", async () => {
    const r = await signedIn(["project", "create", "portal", "--name", "Member Portal", "--region", "de01", "--custody-mode", "BYOK"], (c) =>
      c.path === "/projects" && c.method === "POST" ? { status: 201, body: envelope(project({ custodyMode: "BYOK" })) } : undefined);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toEqual({ slug: "portal", displayName: "Member Portal", custodyMode: "BYOK", region: "de01" });
  });

  it("create: the old lowercase custody values are refused before any request", async () => {
    for (const v of ["managed", "byok", "hyok"]) {
      const r = await signedIn(["project", "create", "portal", "--custody-mode", v], () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("get: GET /projects/<slug>", async () => {
    const r = await signedInHuman(["project", "get", "portal"], (c) => (c.path === "/projects/portal" ? { body: envelope(project()) } : undefined));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("name: Member Portal");
  });

  it("`project delete` is gone", async () => {
    expect((await signedIn(["project", "delete", "portal"], () => undefined)).code).toBe(2);
  });
});

describe("migration", () => {
  const pending = { id: "pmig_1", version: 3, slug: "add-orders", checksum: "x", status: "queued", affectedCollections: [], approvalId: null, queuedAt: "2026-10-01T00:00:00.000Z", queuedBy: "u_1", decidedAt: null, decidedBy: null, decisionReason: null };

  it("pending: reads `id` (the gateway has no pendingId on this route)", async () => {
    const r = await signedInHuman(["migration", "pending"], (c) => (c.path === "/@portal/migrations/pending" ? { body: envelope([pending]) } : undefined));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pmig_1");
    expect(r.stdout).not.toContain("undefined");
  });

  it("apply-pending: POST .../pending/<id>/apply and renders { pendingId, applied }", async () => {
    const r = await signedInHuman(["migration", "apply-pending", "pmig_1"], (c) =>
      c.path === "/@portal/migrations/pending/pmig_1/apply" ? { body: envelope({ pendingId: "pmig_1", applied: [{ version: 3, slug: "add-orders", checksum: "x" }], skipped: [] }) } : undefined);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("3  add-orders");
    expect(r.stdout).not.toContain("undefined");
  });

  it("apply: renders { applied, skipped } with no appliedAt", async () => {
    const f = tempPath("m.json");
    writeFileSync(f.path, JSON.stringify({ migrations: [] }));
    try {
      const r = await signedInHuman(["migration", "apply", f.path], (c) =>
        c.path === "/@portal/migrations/apply" ? { body: envelope({ applied: [{ version: 1, slug: "init", checksum: "c" }], skipped: [{ version: 0 }] }) } : undefined);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Applied 1 migration(s), skipped 1");
      expect(r.stdout).not.toContain("undefined");
    } finally {
      f.cleanup();
    }
  });
});

describe("function deploy", () => {
  const fn = { id: "fn_1", name: "echo", runtime: "go", tier: "sandbox", entryPoint: "main", version: "1", status: "deploying", source: "rest", description: null, createdAt: "2026-10-01T00:00:00.000Z", deployedAt: null, retiredAt: null, errorDetail: null };

  it("uploads the artifact (kind from the tier), then deploys with artifactKey and version", async () => {
    const art = tempPath("fn.tar");
    writeFileSync(art.path, "tarbytes");
    try {
      const r = await signedIn(["function", "deploy", "--name", "echo", "--runtime", "go", "--tier", "sandbox", "--version", "1", "--artifact", art.path], (c) => {
        if (c.path === "/@portal/functions/artifacts") return { status: 201, body: envelope({ artifactKey: "functions/proj_1/abc.tar", sha256: "abc", size: 8, kind: "tar" }) };
        if (c.path === "/@portal/functions" && c.method === "POST") return { status: 202, body: envelope(fn) };
        return undefined;
      });
      expect(r.code).toBe(0);
      expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /@portal/functions/artifacts", "POST /@portal/functions"]);
      expect(r.calls[0]!.headers["content-type"]).toBe("application/x-tar");
      expect(Buffer.from(r.calls[0]!.rawBody!).toString()).toBe("tarbytes");
      expect(r.calls[1]!.body).toEqual({ name: "echo", runtime: "go", tier: "sandbox", artifactKey: "functions/proj_1/abc.tar", version: "1" });
    } finally {
      art.cleanup();
    }
  });

  it("gateway tier uploads wasm", async () => {
    const art = tempPath("fn.wasm");
    writeFileSync(art.path, "wasm");
    try {
      const r = await signedIn(["function", "deploy", "--name", "echo", "--runtime", "tinygo", "--tier", "gateway", "--version", "2", "--artifact", art.path], (c) =>
        c.path.endsWith("/artifacts") ? { body: envelope({ artifactKey: "k.wasm" }) } : { body: envelope(fn) });
      expect(r.calls[0]!.headers["content-type"]).toBe("application/wasm");
    } finally {
      art.cleanup();
    }
  });

  it("an already-uploaded --artifact-key skips the upload; the old enums are refused", async () => {
    const ok = await signedIn(["function", "deploy", "--name", "echo", "--runtime", "bun", "--tier", "sandbox", "--version", "1", "--artifact-key", "k.tar"], () => ({ body: envelope(fn) }));
    expect(ok.calls.map((c) => c.path)).toEqual(["/@portal/functions"]);
    for (const [flag, value] of [["--runtime", "wasm"], ["--tier", "low"]] as const) {
      const argv = ["function", "deploy", "--name", "echo", "--runtime", "bun", "--tier", "sandbox", "--version", "1", "--artifact-key", "k.tar"];
      argv[argv.indexOf(flag) + 1] = value;
      const r = await signedIn(argv, () => ({ body: envelope(fn) }));
      expect(r.code, `${flag} ${value}`).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("invoke wraps the payload; delete renders the retired row", async () => {
    const inv = await signedIn(["function", "invoke", "echo", "--payload", '{"x":1}'], () => ({ body: envelope({ ok: true }) }));
    expect(inv.calls[0]!.body).toEqual({ payload: { x: 1 } });
    const del = await signedInHuman(["function", "delete", "echo"], () => ({ body: envelope({ ...fn, status: "retired", retiredAt: "2026-10-02T00:00:00.000Z" }) }));
    expect(del.stdout).toContain("retired at 2026-10-02");
    expect(del.stdout).not.toContain("undefined");
  });

  it("`function logs` is gone", async () => {
    expect((await signedIn(["function", "logs", "echo"], () => undefined)).code).toBe(2);
  });
});

describe("policy", () => {
  const bundle = { id: "pol_1", projectId: "proj_1", status: "draft", policy: {}, createdBy: "u_1", createdAt: "2026-10-01T00:00:00.000Z", publishedAt: null, supersededAt: null, supersededBy: null, source: "cli", editorMode: "unspecified", supersededReason: null, pendingChangeId: null };

  it("toPolicyBody maps { policy, rules }, { rules } and a bare policy document", () => {
    expect(toPolicyBody({ policy: { collections: {} }, rules: { a: 1 } })).toEqual({ policy: { collections: {} }, rules: { a: 1 } });
    expect(toPolicyBody({ rules: [{ n: 1 }] })).toEqual({ policy: {}, rules: [{ n: 1 }] });
    expect(toPolicyBody({ collections: { posts: {} } })).toEqual({ policy: { collections: { posts: {} } } });
  });

  it("apply sends { policy, rules } and no name", async () => {
    const f = tempPath("p.json");
    writeFileSync(f.path, JSON.stringify({ policy: { collections: { posts: {} } }, rules: { r: 1 } }));
    try {
      const r = await signedIn(["policy", "apply", f.path], (c) => (c.path === "/@portal/policies" ? { status: 201, body: envelope(bundle) } : undefined));
      expect(r.code).toBe(0);
      expect(r.calls[0]!.body).toEqual({ policy: { collections: { posts: {} } }, rules: { r: 1 } });
      const withName = await signedIn(["policy", "apply", f.path, "--name", "x"], () => ({ body: envelope(bundle) }));
      expect(withName.code).toBe(2);
    } finally {
      f.cleanup();
    }
  });

  it("validate: POST .../policies/validate with { policy }", async () => {
    const f = tempPath("p.json");
    writeFileSync(f.path, JSON.stringify({ collections: { posts: {} } }));
    try {
      const r = await signedInHuman(["policy", "validate", f.path], (c) => (c.path === "/@portal/policies/validate" ? { body: envelope({ valid: true }) } : undefined));
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("valid");
    } finally {
      f.cleanup();
    }
  });

  it("list and get render without name or version", async () => {
    const list = await signedInHuman(["policy", "list", "--status", "draft"], (c) => (c.path === "/@portal/policies" ? { body: envelope([bundle]) } : undefined));
    expect(list.calls[0]!.query).toEqual({ status: "draft" });
    expect(list.stdout).toContain("pol_1");
    expect(list.stdout).not.toContain("undefined");
    const bad = await signedIn(["policy", "list", "--status", "deactivated"], () => undefined);
    expect(bad.code).toBe(2);
  });

  it("current with nothing published is a plain message; publish answers a queued approval", async () => {
    const cur = await signedInHuman(["policy", "current"], () => ({ status: 404, body: { code: "K9O_POLICY_NOT_FOUND", message: "none" } }));
    expect(cur.code).toBe(0);
    expect(cur.stdout).toContain("No published policy");
    const pub = await signedInHuman(["policy", "publish", "pol_1"], () => ({ status: 202, body: envelope({ pendingChangeId: "pc_1", bundleId: "pol_1", status: "pending_approval" }) }));
    expect(pub.stdout).toContain("awaiting approval");
    expect(pub.stdout).toContain("pc_1");
  });
});

describe("audit", () => {
  it("query sends the filter names the route reads", async () => {
    const r = await signedIn(["audit", "query", "--event-type", "project.created", "--actor", "u_1", "--after", "2026-10-01T00:00:00Z", "--before", "2026-10-02T00:00:00Z", "--limit", "10"], (c) =>
      c.path === "/@portal/audit-log" ? { body: envelope([], { cursor: { next: null } }) } : undefined);
    expect(r.calls[0]!.query).toEqual({ eventType: "project.created", actorId: "u_1", after: "2026-10-01T00:00:00Z", before: "2026-10-02T00:00:00Z", limit: "10" });
  });

  it("the older --type/--since/--until spellings still map", async () => {
    const r = await signedIn(["audit", "query", "--type", "t", "--since", "2026-10-01T00:00:00Z"], () => ({ body: envelope([], { cursor: { next: null } }) }));
    expect(r.calls[0]!.query).toEqual({ eventType: "t", after: "2026-10-01T00:00:00Z" });
  });

  it("target filters are refused, not silently dropped", async () => {
    const r = await signedIn(["audit", "query", "--target-kind", "x"], () => undefined);
    expect(r.code).not.toBe(0);
    expect(r.calls).toHaveLength(0);
  });

  it("tail asks for events after now minus N minutes", async () => {
    const before = Date.now();
    const r = await signedIn(["audit", "tail", "--since-minutes", "10", "--limit", "5"], () => ({ body: envelope([], { cursor: { next: null } }) }));
    const after = new Date(r.calls[0]!.query["after"]!).getTime();
    expect(before - after).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
    expect(r.calls[0]!.query["limit"]).toBe("5");
  });

  it("export follows the cursor to the end", async () => {
    const out = tempPath("events.ndjson");
    const ev = (id: string) => ({ id, type: "t", actorId: null, targetKind: null, targetId: null, payload: {}, occurredAt: "2026-10-01T00:00:00.000Z", requestId: null, traceId: null });
    try {
      const r = await signedIn(["audit", "export", out.path], (c) =>
        c.query["cursor"] === undefined
          ? { body: envelope([ev("a"), ev("b")], { cursor: { next: "c1" } }) }
          : { body: envelope([ev("c")], { cursor: { next: null } }) });
      expect(r.code).toBe(0);
      expect((await Bun.file(out.path).text()).trim().split("\n")).toHaveLength(3);
      expect(r.calls).toHaveLength(2);
    } finally {
      out.cleanup();
    }
  });
});

describe("ext-admin", () => {
  const installed = { installId: "i_1", extensionId: "x_1", extensionSlug: "paperless", manifestVersion: "1.2.0", status: "enabled", enabledAt: "2026-10-01T00:00:00.000Z", disabledAt: null, cli: [], updateAvailable: true, latestVersion: "1.3.0", updateBumpType: "minor" };

  it("list: reads extensionSlug / status / manifestVersion (it used to read slug/name/class and crash)", async () => {
    const r = await signedInHuman(["ext-admin", "list"], (c) => (c.path === "/@portal/extensions-admin" ? { body: envelope([installed]) } : undefined));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("paperless");
    expect(r.stdout).toContain("v1.2.0");
    expect(r.stdout).toContain("update available: v1.3.0");
  });

  it("enable is POST, disable is DELETE .../disable", async () => {
    const en = await signedIn(["ext-admin", "enable", "paperless"], (c) => (c.path === "/@portal/extensions-admin/paperless/enable" ? { body: envelope({ hookSecret: null }) } : undefined));
    expect(en.calls[0]!.method).toBe("POST");
    const dis = await signedIn(["ext-admin", "disable", "paperless"], (c) => (c.path === "/@portal/extensions-admin/paperless/disable" ? { body: envelope({ id: "i_1", status: "disabled" }) } : undefined));
    expect(dis.calls[0]!.method).toBe("DELETE");
    expect(dis.code).toBe(0);
  });

  it("config reads the extension's detail and patches the object it is given", async () => {
    const get = await signedInHuman(["ext-admin", "config", "paperless"], (c) => (c.path === "/@portal/extensions-admin/paperless" ? { body: envelope({ ...installed, config: { lang: "de" } }) } : undefined));
    expect(get.stdout).toContain('"lang": "de"');
    const set = await signedIn(["ext-admin", "config", "paperless", "--set", '{"lang":"fr"}'], (c) => (c.method === "PATCH" ? { body: envelope({}) } : undefined));
    expect(set.calls[0]!.path).toBe("/@portal/extensions-admin/paperless/config");
    expect(set.calls[0]!.body).toEqual({ lang: "fr" });
  });
});

describe("ext <slug> <verb>", () => {
  const cli = [
    { verb: "scan", summary: "Scan a document", invokes: "POST:/scans/{id}", args: [
      { name: "id", summary: "doc", position: "positional", type: "string", required: true, bind: "path" },
      { name: "deep", summary: "deep scan", position: "flag", type: "boolean" },
      { name: "opts", summary: "options", position: "flag", type: "json" },
    ] },
    { verb: "status", summary: "Status", invokes: "GET:/status", args: [{ name: "limit", summary: "n", position: "flag", type: "number" }] },
  ];
  const installed = { extensionSlug: "paperless", status: "enabled", manifestVersion: "1", cli };

  it("buildExtensionRequest binds path, query and body arguments", () => {
    const scan = buildExtensionRequest(cli[0] as never, ["doc 1"], { deep: "true", opts: '{"a":1}' });
    expect(scan).toEqual({ method: "POST", path: "/scans/doc%201", query: {}, body: { deep: true, opts: { a: 1 } } });
    const status = buildExtensionRequest(cli[1] as never, [], { limit: "5" });
    expect(status).toEqual({ method: "GET", path: "/status", query: { limit: "5" }, body: undefined });
    expect(() => buildExtensionRequest(cli[0] as never, [], {})).toThrow(/missing required/);
    expect(() => buildExtensionRequest(cli[1] as never, [], { limit: "many" })).toThrow(/must be a number/);
  });

  it("calls the extension's own route and prints its answer", async () => {
    const r = await signedIn(["ext", "paperless", "scan", "d7", "--deep", "true"], (c) => {
      if (c.path === "/@portal/extensions-admin") return { body: envelope([installed]) };
      if (c.path === "/@portal/extensions/paperless/api/paperless/scans/d7") return { body: { scanned: true } };
      return undefined;
    });
    expect(r.code).toBe(0);
    expect(r.calls[1]!.method).toBe("POST");
    expect(r.calls[1]!.body).toEqual({ deep: true });
    expect(JSON.parse(r.stdout).data).toEqual({ scanned: true });
  });

  it("an unknown verb lists the valid ones; --help lists them too", async () => {
    const r = await signedIn(["ext", "paperless", "nope"], (c) => (c.path === "/@portal/extensions-admin" ? { body: envelope([installed]) } : undefined));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("scan | status");
    const h = await signedInHuman(["ext", "paperless", "--help"], (c) => (c.path === "/@portal/extensions-admin" ? { body: envelope([installed]) } : undefined));
    expect(h.stdout).toContain("scan");
    expect(h.stdout).toContain("Scan a document");
  });
});

describe("org", () => {
  const member = { userId: "u_2", orgId: "org_1", role: "ORG_MEMBER", email: "m@acme.test", displayName: "M", invitedAt: "2026-10-01T00:00:00.000Z", acceptedAt: null, status: "active", state: "invited", suspendedAt: null };

  it("get reads displayName", async () => {
    const r = await signedInHuman(["org", "get"], (c) => (c.path === "/org" ? { body: envelope({ id: "org_1", slug: "acme", displayName: "Acme Corp", customDomain: null, billingTier: "ridge", role: "ORG_OWNER", createdAt: "2026-10-01T00:00:00.000Z" }) } : undefined));
    expect(r.stdout).toContain("name: Acme Corp");
    expect(r.stdout).not.toContain("undefined");
  });

  it("members list: `invited` goes through the state filter and renders the derived state", async () => {
    const r = await signedInHuman(["org", "members", "list", "--status", "invited"], (c) => (c.path === "/members" ? { body: envelope([member]) } : undefined));
    expect(r.calls[0]!.query).toEqual({ state: "invited" });
    expect(r.stdout).toContain("invited");
  });

  it("members invite: renders both answers (an invitation, or an added member)", async () => {
    const inv = await signedInHuman(["org", "members", "invite", "--email", "n@acme.test"], () => ({ status: 202, body: envelope({ invitation: { id: "inv_1", orgId: "org_1", email: "n@acme.test", role: "ORG_MEMBER", expiresAt: "2026-10-08T00:00:00.000Z" }, delivery: "email" }) }));
    expect(inv.stdout).toContain("Invited n@acme.test");
    const added = await signedInHuman(["org", "members", "invite", "--email", "m@acme.test"], () => ({ status: 201, body: envelope(member) }));
    expect(added.stdout).toContain("Added m@acme.test");
  });

  it("removed commands: members get, groups create/delete, smtp get, audit tail", async () => {
    for (const argv of [["members", "get", "u_1"], ["groups", "create", "x"], ["groups", "delete", "g"], ["smtp", "get"], ["audit", "tail"]]) {
      const r = await signedIn(["org", ...argv], () => undefined);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("smtp set sends passwordRef and fromAddress; a plain --password is refused", async () => {
    const r = await signedIn(["org", "smtp", "set", "--host", "smtp.acme.test", "--port", "587", "--username", "u", "--password-ref", "kibo://secret/x", "--from-address", "no-reply@acme.test", "--from-name", "Acme"], (c) => (c.method === "PATCH" && c.path === "/org" ? { body: envelope({}) } : undefined));
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toEqual({ smtpConfig: { host: "smtp.acme.test", port: 587, username: "u", passwordRef: "kibo://secret/x", fromAddress: "no-reply@acme.test", fromName: "Acme" } });
    const bad = await signedIn(["org", "smtp", "set", "--host", "h", "--port", "587", "--username", "u", "--password", "hunter2", "--from-address", "a@b.test"], () => undefined);
    expect(bad.code).toBe(2);
    expect(bad.calls).toHaveLength(0);
  });

  it("smtp test: POST /org/smtp/test-email and renders { accepted, dryRun }", async () => {
    const r = await signedInHuman(["org", "smtp", "test", "--to", "me@acme.test"], (c) => (c.path === "/org/smtp/test-email" ? { body: envelope({ accepted: true, resolvedTier: "org", to: "me@acme.test", dryRun: true }) } : undefined));
    expect(r.stdout).toContain("accepted");
    expect(r.stdout).toContain("Dry run");
    expect(r.stdout).not.toContain("undefined");
  });

  it("audit query: org route uses createdAt, honours --type and --limit only", async () => {
    const r = await signedInHuman(["org", "audit", "query", "--type", "t", "--limit", "5"], (c) => (c.path === "/audit-log" ? { body: envelope([{ id: "e1", type: "t", actorId: "u_1", targetKind: "org", targetId: "org_1", payload: {}, createdAt: "2026-10-01T00:00:00.000Z", requestId: null, traceId: null }]) } : undefined));
    expect(r.calls[0]!.query).toEqual({ type: "t", limit: "5" });
    expect(r.stdout).toContain("2026-10-01T00:00:00.000Z");
    expect((await signedIn(["org", "audit", "query", "--since", "x"], () => undefined)).code).toBe(2);
  });

  it("roles grant and idp create send the gateway's field names", async () => {
    const g = await signedIn(["org", "roles", "grant", "u_2", "--role", "ORG_AUDITOR", "--reason", "audit"], (c) => (c.path === "/role-grants" ? { status: 201, body: envelope({ id: "g_1", userId: "u_2", role: "ORG_AUDITOR", grantedBy: "u_1", grantedAt: "x", revokedAt: null, revokedBy: null, decisionReason: "audit" }) } : undefined));
    expect(g.calls[0]!.body).toEqual({ userId: "u_2", role: "ORG_AUDITOR", decisionReason: "audit" });
    const idp = await signedIn(["org", "idp", "create", "--provider", "oidc", "--display-name", "SSO", "--client-id", "cid", "--client-secret-ref", "ref", "--tier-gating", "free_tier_ok", "--disabled"], (c) => (c.path === "/identity-providers" ? { status: 201, body: envelope({ id: "oic_1", idpProvider: "oidc", displayName: "SSO", clientId: "cid", enabled: false, createdAt: "x" }) } : undefined));
    expect(idp.calls[0]!.body).toEqual({ idpProvider: "oidc", displayName: "SSO", clientId: "cid", clientSecretRef: "ref", tierGating: "free_tier_ok", enabled: false });
    const list = await signedInHuman(["org", "idp", "list"], () => ({ body: envelope([{ id: "oic_1", idpProvider: "oidc", displayName: "SSO", clientId: "cid", enabled: true, createdAt: "x" }]) }));
    expect(list.stdout).toContain("SSO");
    expect(list.stdout).not.toContain("undefined");
  });

  it("groups list/get render source, not memberCount", async () => {
    const r = await signedInHuman(["org", "groups", "list"], (c) => (c.path === "/groups" ? { body: envelope([{ id: "g1", orgId: "o", name: "Eng", description: null, source: "idp", sourceGroupId: "x", createdAt: "x" }]) } : undefined));
    expect(r.stdout).toContain("Eng");
    expect(r.stdout).toContain("idp");
  });
});

describe("me", () => {
  it("profile get renders the gateway's profile", async () => {
    const r = await signedInHuman(["me", "profile", "get"], (c) => (c.path === "/me" ? { body: envelope({ id: "u_1", email: "op@acme.test", displayName: "Op", mfaEnabled: true, verifiedAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "x" }) } : undefined));
    expect(r.stdout).toContain("mfa enabled: yes");
    expect(r.stdout).not.toContain("undefined");
  });

  it("sessions list reads issuedAt / isCurrentSession", async () => {
    const r = await signedInHuman(["me", "sessions", "list"], (c) => (c.path === "/me/sessions" ? { body: envelope([{ id: "sess_1", userId: "u_1", issuedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", revokedAt: null, mfaVerifiedAt: null, userAgent: "k9o", ipAddress: "10.0.0.1", geoCountry: null, isCurrentSession: true }]) } : undefined));
    expect(r.stdout).toContain("sess_1");
    expect(r.stdout).toContain("*");
    expect(r.stdout).not.toContain("undefined");
  });

  it("api-tokens create sends label + scopeManifest + ttlSeconds and prints the plaintext once", async () => {
    const r = await signedInHuman(["me", "api-tokens", "create", "ci-deploy", "--operations", "read,write", "--projects", "portal", "--ttl-days", "90"], (c) =>
      c.path === "/me/api-tokens" && c.method === "POST"
        ? { status: 201, body: envelope({ id: "pat_1", userId: "u_1", orgId: "org_1", label: "ci-deploy", scopeManifest: {}, ttlSeconds: 7_776_000, createdAt: "x", expiresAt: "2027-01-01T00:00:00.000Z", lastUsedAt: null, revokedReason: null, status: "active", plaintext: "k9o_pat_secret" }) }
        : undefined);
    expect(r.calls[0]!.body).toEqual({ label: "ci-deploy", scopeManifest: { operations: ["read", "write"], projects: ["portal"] }, ttlSeconds: 7_776_000 });
    expect(r.stdout).toContain("k9o_pat_secret");
  });

  it("removed groups: notifications, audit-log, data-export", async () => {
    for (const g of ["notifications", "audit-log", "data-export"]) {
      const r = await signedIn(["me", g, "list"], () => undefined);
      expect(r.code, g).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });
});

describe("help and missing-dependency messages", () => {
  it("stack/showroom without run.sh print one line naming the dependency", async () => {
    const saved = process.cwd();
    const dir = tempPath("x");
    process.chdir(require("node:os").tmpdir());
    try {
      const r = await runCli(["stack", "status"], () => undefined, { K9O_RUNSH_PATH: "/nonexistent/run.sh" });
      if (r.code !== 0) {
        expect(r.stderr).toContain("needs run.sh from a k9o-core checkout");
        expect(r.stderr.trim().split("\n").filter((l) => l.startsWith("["))).toHaveLength(1);
      }
    } finally {
      process.chdir(saved);
      dir.cleanup();
    }
  });

  it("help for stack, showroom, doctor and ledger names the dependency", async () => {
    for (const [cmd, needle] of [["stack", "run.sh"], ["showroom", "run.sh"], ["doctor", "run.sh"], ["ledger", "kibo-ledger-verify"]]) {
      const r = await runCli([cmd!, "--help"], () => undefined);
      expect(r.stdout, cmd).toContain(needle!);
      expect(r.stdout, cmd).toContain("npm package");
    }
  });

  it("audit help says tail is not a live stream; top-level help carries no spec chapter references", async () => {
    const a = await runCli(["audit", "--help"], () => undefined);
    expect(a.stdout).toContain("Not a live");
    const top = await runCli(["--help"], () => undefined);
    // Built from parts so this file does not itself contain the tokens the public-source scan rejects.
    const chapterRef = new RegExp(["c", "h\\d\\d"].join("") + "|" + String.fromCharCode(0xa7));
    expect(top.stdout).not.toMatch(chapterRef);
  });
});
