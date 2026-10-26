/**
 * `k9o stream`: each subcommand against a fake gateway answering in the gateway's wire shapes (read from
 * services/gateway/src/routes/pulse-streams.ts and pulse-stream-consume.ts).
 */

import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { parseDuration, parseSize } from "../src/commands/stream.ts";
import { parseArgs } from "../src/args.ts";
import { envelope, runCli, tempCredentials, tempPath, type Handler } from "./helpers.ts";

const BASE = "/@portal/data-streams/user";

async function signedIn(argv: string[], handler: Handler, json = true) {
  const c = tempCredentials();
  try {
    return await runCli([...argv, "--credentials-file", c.path, ...(json ? ["--output", "json"] : [])], handler);
  } finally {
    c.cleanup();
  }
}

const stream = {
  id: "pstr_1", slug: "orders", projectId: "proj_1", displayName: "Orders", subjectPrefix: "k9o.de01.acme.proj_1.user.pstr_1",
  region: "de01", retentionSeconds: 86400, retentionClass: "warm", maxBytes: 1073741824, status: "active",
  createdAt: "2026-10-26T10:00:00.000Z", createdBy: "u_1",
};

const ev = (n: number, data: unknown, suffix = "_") => ({
  sequence: String(n), subject: `${stream.subjectPrefix}.${suffix}`, data, publishedAt: "2026-10-26T10:00:0" + n + ".000Z",
});
const frame = (n: number, data: unknown) => `id: ${n}\ndata: ${JSON.stringify(ev(n, data))}\n\n`;

describe("parsers", () => {
  it("sizes and durations", () => {
    expect(parseSize("4GiB")).toBe(4 * 1024 ** 3);
    expect(parseSize("1073741824")).toBe(1073741824);
    expect(parseSize("abc")).toBeNull();
    expect(parseDuration("24h")).toBe(86400);
    expect(parseDuration("15m")).toBe(900);
    expect(parseDuration("7d")).toBe(604800);
    expect(parseDuration("900")).toBe(900);
    expect(parseDuration("x")).toBeNull();
  });
  it("parseArgs keeps a lone - as a value", () => {
    expect(parseArgs(["stream", "publish", "o", "--data", "-"]).flags["data"]).toBe("-");
  });
});

describe("control plane", () => {
  it("create sends the gateway body", async () => {
    const r = await signedIn(["stream", "create", "--name", "Orders", "--max-bytes", "1GiB", "--retention", "24h"], () => ({ status: 201, body: envelope(stream) }));
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${BASE}`]);
    expect(r.calls[0]!.body).toEqual({ displayName: "Orders", maxBytes: 1073741824, retentionSeconds: 86400 });
  });

  it("create refuses missing or bad flags (exit 2) before any request", async () => {
    for (const argv of [["stream", "create"], ["stream", "create", "--name", "x"], ["stream", "create", "--name", "x", "--max-bytes", "lots"], ["stream", "create", "--name", "x", "--max-bytes", "1GiB", "--retention", "soon"]]) {
      const r = await signedIn(argv, () => undefined);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.calls).toHaveLength(0);
    }
  });

  it("list, get, delete", async () => {
    const list = await signedIn(["stream", "list"], () => ({ body: envelope([stream]) }), false);
    expect(list.stdout).toContain("orders");
    expect(list.stdout).toContain("1GiB");
    const get = await signedIn(["stream", "get", "orders"], () => ({ body: envelope(stream) }), false);
    expect(get.stdout).toContain("retention: 1d (warm)");
    const del = await signedIn(["stream", "delete", "orders"], () => ({ body: envelope({ slug: "orders", status: "deleted" }) }), false);
    expect(del.stdout).toContain('Stream "orders" retired.');
    expect(del.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE ${BASE}/orders`]);
    for (const sub of ["get", "delete", "publish", "tail", "replay"]) expect((await signedIn(["stream", sub], () => undefined)).code, sub).toBe(2);
  });
});

describe("publish", () => {
  const accepted = { status: 202, body: envelope({ streamSlug: "orders", subject: `${stream.subjectPrefix}.eu.new`, bytes: 8, accepted: true }) };

  it("sends inline JSON and the subject", async () => {
    const r = await signedIn(["stream", "publish", "orders", "--data", '{"id":1}', "--subject", "eu.new"], () => accepted);
    expect(r.code).toBe(0);
    expect(r.calls[0]!.path).toBe(`${BASE}/orders/publish`);
    expect(r.calls[0]!.body).toEqual({ data: { id: 1 }, subject: "eu.new" });
  });

  it("reads @file", async () => {
    const f = tempPath("event.json");
    writeFileSync(f.path, '{"id":2}');
    try {
      const r = await signedIn(["stream", "publish", "orders", "--data", `@${f.path}`], () => accepted);
      expect(r.calls[0]!.body).toEqual({ data: { id: 2 } });
    } finally {
      f.cleanup();
    }
  });

  it("refuses invalid JSON and a missing --data (exit 70 / 2) without a request", async () => {
    const bad = await signedIn(["stream", "publish", "orders", "--data", "{nope"], () => accepted);
    expect(bad.code).toBe(70);
    expect(bad.calls).toHaveLength(0);
    expect((await signedIn(["stream", "publish", "orders"], () => accepted)).code).toBe(2);
  });

  it("surfaces K9O_STREAM_UNAVAILABLE with its message", async () => {
    const r = await signedIn(["stream", "publish", "orders", "--data", "1"], () => ({
      status: 503,
      body: { code: "K9O_STREAM_UNAVAILABLE", message: "The Pulse Stream data plane is not yet available in this deployment.", context: {} },
    }), false);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("[K9O_STREAM_UNAVAILABLE]");
    expect(r.stderr).toContain("not yet available");
  });
});

describe("replay", () => {
  it("sends the range and prints events with a continuation hint", async () => {
    const r = await signedIn(["stream", "replay", "orders", "--from", "10", "--until", "50", "--limit", "2"], () => ({
      body: envelope({ streamSlug: "orders", events: [ev(11, { a: 1 }, "eu.new"), ev(12, { a: 2 })], nextCursor: "12", hasMore: true }),
    }), false);
    expect(r.calls[0]!.body).toEqual({ fromSequence: 10, untilSequence: 50, limit: 2 });
    expect(r.stdout).toContain('11  2026-10-26T10:00:011.000Z  eu.new  {"a":1}');
    expect(r.stdout).toContain("More events: continue with --from 12");
  });

  it("rejects bad numbers (exit 2)", async () => {
    expect((await signedIn(["stream", "replay", "orders", "--limit", "0"], () => undefined)).code).toBe(2);
    expect((await signedIn(["stream", "replay", "orders", "--from", "abc"], () => undefined)).code).toBe(2);
  });
});

describe("tail", () => {
  it("prints one JSON event per line and resumes after the last sequence on reconnect", async () => {
    let n = 0;
    const r = await signedIn(["stream", "tail", "orders", "--from", "5", "--count", "3"], () => {
      n++;
      return { sse: n === 1 ? `retry: 5\n:ok\n\n${frame(6, { a: 6 })}${frame(7, { a: 7 })}` : `retry: 5\n:ok\n\n${frame(8, { a: 8 })}` };
    });
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((e) => e.sequence)).toEqual(["6", "7", "8"]);
    const subs = r.calls.filter((c) => c.path.endsWith("/subscribe"));
    expect(subs.map((c) => c.query["fromSequence"])).toEqual(["5", "7"]);
  });

  it("human output is one line per event", async () => {
    const r = await signedIn(["stream", "tail", "orders", "--count", "1"], () => ({ sse: frame(1, { a: 1 }) }), false);
    expect(r.stdout.trim().split("\n")).toEqual(['1  2026-10-26T10:00:01.000Z  _  {"a":1}']);
  });

  it("surfaces a 503 on open and exits non-zero", async () => {
    const r = await signedIn(["stream", "tail", "orders"], () => ({ status: 503, body: { code: "K9O_STREAM_UNAVAILABLE", message: "plane down", context: {} } }), false);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("K9O_STREAM_UNAVAILABLE");
  });
});
