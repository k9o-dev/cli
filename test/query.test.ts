/** `k9o query` and `k9o search` — argument handling and the run against a fake gateway. */

import { describe, expect, it } from "bun:test";
import { queryFromArgs, searchFromArgs } from "../src/commands/query.ts";
import type { ParsedArgs } from "../src/args.ts";
import { envelope, runCli, tempCredentials } from "./helpers.ts";

const pa = (positional: string[], flags: Record<string, string> = {}): ParsedArgs => ({ positional, flags });
const ROWS = [{ id: "u1", role: "admin" }, { id: "u2", role: "admin" }];

async function signedIn(argv: string[], handler: Parameters<typeof runCli>[1]) {
  const c = tempCredentials();
  try {
    return await runCli([...argv, "--credentials-file", c.path], handler);
  } finally {
    c.cleanup();
  }
}

describe("queryFromArgs", () => {
  it("takes the SQL and JSON params", () => {
    expect(queryFromArgs(pa(["query", "SELECT 1"], { params: '{"a":1}' }))).toEqual({ sql: "SELECT 1", params: { a: 1 } });
    expect(queryFromArgs(pa(["query", "SELECT $1"], { params: '["x"]' }))).toEqual({ sql: "SELECT $1", params: ["x"] });
  });
  it("reads the SQL from stdin with - and from a file", () => {
    expect(queryFromArgs(pa(["query", "-"]), () => "SELECT 2")).toEqual({ sql: "SELECT 2" });
    expect(queryFromArgs(pa(["query"], { file: "q.sql" }), () => "", () => "SELECT 3")).toEqual({ sql: "SELECT 3" });
  });
  it("rejects missing SQL, both forms, empty SQL and bad params", () => {
    expect("problems" in queryFromArgs(pa(["query"]))).toBe(true);
    expect("problems" in queryFromArgs(pa(["query", "SELECT 1"], { file: "x" }))).toBe(true);
    expect("problems" in queryFromArgs(pa(["query", "  "]))).toBe(true);
    expect("problems" in queryFromArgs(pa(["query", "SELECT 1"], { params: "nope" }))).toBe(true);
    expect("problems" in queryFromArgs(pa(["query", "SELECT 1"], { params: "5" }))).toBe(true);
  });
});

describe("searchFromArgs", () => {
  it("needs the collection, --column and --q", () => {
    expect("problems" in searchFromArgs(pa(["search"], {}))).toBe(true);
    expect(searchFromArgs(pa(["search", "articles"], { column: "body", q: "climate", type: "websearch", limit: "5", language: "french" }))).toEqual({
      collection: "articles",
      input: { column: "body", q: "climate", type: "websearch", limit: 5, language: "french" },
    });
  });
  it("rejects a bad --type and --limit", () => {
    expect("problems" in searchFromArgs(pa(["search", "a"], { column: "c", q: "x", type: "bad" }))).toBe(true);
    expect("problems" in searchFromArgs(pa(["search", "a"], { column: "c", q: "x", limit: "0" }))).toBe(true);
  });
});

describe("k9o query / search run", () => {
  it("query posts the rewritten SQL and prints one row per line", async () => {
    const r = await signedIn(["query", "SELECT * FROM users WHERE role = :role", "--params", '{"role":"admin"}'], () => ({ body: envelope(ROWS) }));
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toEqual({ sql: "SELECT * FROM users WHERE role = $1", params: ["admin"] });
    expect(r.stdout.trim().split("\n")).toEqual(ROWS.map((x) => JSON.stringify(x)));
  });
  it("search sends the text-search parameters", async () => {
    const r = await signedIn(["search", "articles", "--column", "body", "--q", "climate resilience", "--output", "json"], () => ({ body: envelope(ROWS) }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).data).toEqual(ROWS);
    expect(r.calls[0]!.query["textSearch"]).toBe("body:climate resilience");
  });
  it("usage errors exit 2 before any request", async () => {
    const a = await signedIn(["query"], () => ({ body: envelope(ROWS) }));
    const b = await signedIn(["search", "articles"], () => ({ body: envelope(ROWS) }));
    expect(a.code).toBe(2);
    expect(b.code).toBe(2);
    expect(a.calls.length + b.calls.length).toBe(0);
  });
  it("a write is refused by the gateway and exits non-zero", async () => {
    const r = await signedIn(["query", "DELETE FROM users", "--output", "json"], () => ({
      status: 400,
      body: { code: "K9O_RAW_SQL_READ_ONLY", message: "raw SQL is read-only", context: {}, recommendation: null },
    }));
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("K9O_RAW_SQL_READ_ONLY");
  });
});
