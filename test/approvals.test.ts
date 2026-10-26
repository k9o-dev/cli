/** `k9o approvals`, `k9o approval-policy` and `k9o schema collections` against a fake gateway. */

import { describe, expect, it } from "bun:test";
import { envelope, runCli, tempCredentials, type Handler } from "./helpers.ts";

async function signedIn(argv: string[], handler: Handler, json = true) {
  const c = tempCredentials();
  try {
    return await runCli([...argv, "--credentials-file", c.path, ...(json ? ["--output", "json"] : [])], handler);
  } finally {
    c.cleanup();
  }
}

const pending = {
  id: "apr_1", status: "pending_approval", collection: "orders", operation: "update", makerId: "usr_1",
  proposedPayload: { amount: 5 }, targetRecordId: "rec_1", approverId: null, decidedAt: null, decisionReason: null,
  createdAt: "2026-10-26T10:00:00.000Z", expiresAt: null,
};
const BASE = "/@portal";

describe("k9o approvals", () => {
  it("list sends status and limit", async () => {
    const r = await signedIn(["approvals", "list", "--status", "approved", "--limit", "5"], () => ({ body: envelope([pending]) }));
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${BASE}/pending-approvals`]);
    expect(r.calls[0]!.query).toEqual({ status: "approved", limit: "5" });
  });

  it("list refuses a bad status or limit before any request", async () => {
    for (const argv of [["approvals", "list", "--status", "queued"], ["approvals", "list", "--limit", "0"], ["approvals", "list", "--limit", "201"]]) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("get reads one change; human output names the status", async () => {
    const r = await signedIn(["approvals", "get", "apr_1"], () => ({ body: envelope(pending) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.path).toBe(`${BASE}/pending-approvals/apr_1`);
    expect(r.stdout).toContain("pending_approval");
  });

  it("approve posts the reason and says when more approvers are needed", async () => {
    const r = await signedIn(["approvals", "approve", "apr_1", "--reason", "ok"], () => ({ body: envelope(pending) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/pending-approvals/apr_1/approve`, body: { reason: "ok" } });
    expect(r.stdout).toContain("more approvers are needed");
    const done = await signedIn(["approvals", "approve", "apr_1"], () => ({ body: envelope({ ...pending, status: "redeemed" }) }), false);
    expect(done.stdout).toContain("Approved.");
    expect(done.calls[0]!.body).toEqual({});
  });

  it("reject needs a reason", async () => {
    const none = await signedIn(["approvals", "reject", "apr_1"], () => undefined);
    expect(none.code).toBe(2);
    expect(none.calls).toHaveLength(0);
    const r = await signedIn(["approvals", "reject", "apr_1", "--reason", "duplicate"], () => ({ body: envelope({ ...pending, status: "rejected" }) }));
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/pending-approvals/apr_1/reject`, body: { reason: "duplicate" } });
  });

  it("bulk sends the criteria and prints the affected ids", async () => {
    const result = { attestationId: "apr_b", action: "reject", affectedCount: 1, affectedIds: ["apr_1"], reason: "stale" };
    const r = await signedIn(["approvals", "bulk", "--action", "reject", "--reason", "stale", "--criteria", '{"eq":["change.table","orders"]}'], () => ({ body: envelope(result) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/pending-approvals/bulk`, body: { action: "reject", reason: "stale", criteria: { eq: ["change.table", "orders"] } } });
    expect(r.stdout).toContain("apr_1");
    expect(r.stdout).toContain("skipped");
  });

  it("bulk refuses bad input before any request", async () => {
    const crit = '{"eq":["change.table","orders"]}';
    const cases = [
      ["approvals", "bulk", "--criteria", crit],
      ["approvals", "bulk", "--action", "delete", "--criteria", crit],
      ["approvals", "bulk", "--action", "approve"],
      ["approvals", "bulk", "--action", "approve", "--criteria", "nope"],
      ["approvals", "bulk", "--action", "approve", "--criteria", "[1]"],
      ["approvals", "bulk", "--action", "approve", "--criteria", "null"],
      ["approvals", "bulk", "--action", "reject", "--criteria", crit],
    ];
    for (const argv of cases) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("an unknown subcommand is a usage error", async () => {
    const r = await signedIn(["approvals", "nope"], () => undefined);
    expect(r.code).toBe(2);
  });
});

describe("k9o approval-policy", () => {
  const policy = { id: "apo_1", collection: "orders", operation: "update", predicate: { gt: ["change.row.amount", 1000] }, action: "queue", authoredBy: "usr_1", createdAt: "2026-10-26T10:00:00.000Z" };

  it("list, create and delete use the policy routes", async () => {
    const list = await signedIn(["approval-policy", "list"], () => ({ body: envelope([policy]) }));
    expect(list.calls[0]).toMatchObject({ method: "GET", path: `${BASE}/approval-policies` });
    const create = await signedIn(
      ["approval-policy", "create", "--collection", "orders", "--operation", "update", "--action", "queue", "--predicate", JSON.stringify(policy.predicate)],
      () => ({ status: 201, body: envelope(policy) }),
    );
    expect(create.code).toBe(0);
    expect(create.calls[0]).toMatchObject({ method: "POST", path: `${BASE}/approval-policies`, body: { collection: "orders", operation: "update", action: "queue", predicate: policy.predicate } });
    const del = await signedIn(["approval-policy", "delete", "apo_1"], () => ({ body: envelope({ id: "apo_1" }) }), false);
    expect(del.calls[0]).toMatchObject({ method: "DELETE", path: `${BASE}/approval-policies/apo_1` });
    expect(del.stdout).toContain("apo_1");
  });

  it("create refuses bad flags before any request", async () => {
    const ok = ["--collection", "orders", "--operation", "update", "--action", "queue", "--predicate", "{}"];
    const swap = (flag: string, value: string) => {
      const a = [...ok];
      a[a.indexOf(flag) + 1] = value;
      return ["approval-policy", "create", ...a];
    };
    const cases = [
      swap("--collection", "1bad"),
      swap("--operation", "upsert"),
      swap("--action", "block"),
      swap("--predicate", "[]"),
      swap("--predicate", "oops"),
      ["approval-policy", "create", "--collection", "orders", "--operation", "update", "--action", "queue"],
      ["approval-policy", "delete"],
    ];
    for (const argv of cases) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });
});

describe("k9o schema collections", () => {
  const row = { name: "orders", rowCount: 120, rowCountIsExact: true, columnCount: 8, indexCount: 3, lastMigrationSlug: "add_orders", lastMigrationAppliedAt: null };

  it("sends limit and cursor and prints the next cursor", async () => {
    const meta = { cursor: { next: "b3JkZXJz", totalCount: null, countMethod: "none" } };
    const r = await signedIn(["schema", "collections", "--limit", "1", "--cursor", "abc"], () => ({ body: envelope([row], meta) }), false);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.path).toBe(`${BASE}/schema/collections`);
    expect(r.calls[0]!.query).toEqual({ limit: "1", cursor: "abc" });
    expect(r.stdout).toContain("orders");
    expect(r.stdout).toContain("--cursor b3JkZXJz");
  });

  it("refuses a bad --limit and an unknown subcommand", async () => {
    const bad = await signedIn(["schema", "collections", "--limit", "0"], () => undefined);
    expect(bad.code).toBe(2);
    expect(bad.calls).toHaveLength(0);
    expect((await signedIn(["schema", "nope"], () => undefined)).code).toBe(2);
  });
});
