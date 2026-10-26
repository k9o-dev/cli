/**
 * `k9o query` and `k9o search` — read your project's data from the terminal.
 *
 *   k9o query <sql|-> [--params '<json>'] [--file <path>]     one read-only SQL statement; rows print one JSON object per line
 *   k9o search <collection> --column <c> --q <text> [--language <l>] [--type plain|phrase|websearch] [--limit N] [--cursor <c>]
 *
 * `--params` is a JSON array (positional, `$1`, `$2`, ...) or a JSON object (named, `:name` in the SQL). Wire to
 * `client.query()` / `client.search()` (packages/core/src/query.ts, search.ts). Raw SQL is read-only; one statement per call.
 */

import { readFileSync } from "node:fs";
import { KError, type QueryParams } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

function printQueryHelp(): void {
  process.stdout.write(`
k9o query — run one read-only SQL statement against the project's data

USAGE
  k9o query <sql|-> [--params '<json>']
  k9o query --file <path|-> [--params '<json>']

  <sql>            the statement ("-" reads it from stdin); one statement per call, SELECT only
  --file <path>    read the statement from a file ("-" is stdin)
  --params <json>  a JSON array (positional: $1, $2, ...) or a JSON object (named: :name in the SQL);
                   values are strings, numbers, booleans or null and are bound by the database

Rows print one JSON object per line (--output json: the whole result). Needs the project-editor role.
Writes are refused; change data through the data methods.
`.trim() + "\n");
}

function printSearchHelp(): void {
  process.stdout.write(`
k9o search — full-text search over one column of a collection

USAGE
  k9o search <collection> --column <name> --q <text> [--language <name>] [--type plain|phrase|websearch]
                          [--limit N] [--cursor <cursor>]

Matching rows print one JSON object per line, best match first (--output json: the whole result).
`.trim() + "\n");
}

/** The query request from argv, or the reasons it is unusable. */
export function queryFromArgs(
  args: ParsedArgs,
  readStdin: () => string = () => readFileSync(0, "utf8"),
  readFile: (p: string) => string = (p) => readFileSync(p === "-" ? 0 : p, "utf8"),
): { sql: string; params?: QueryParams } | { problems: string[] } {
  const problems: string[] = [];
  const text = args.positional[1];
  const file = args.flags["file"];
  if (text !== undefined && file !== undefined) problems.push("pass the SQL or --file, not both");
  if (text === undefined && file === undefined) problems.push('give the SQL, or --file <path|->');
  if (problems.length > 0) return { problems };
  let sql: string;
  try {
    sql = file !== undefined ? readFile(file) : text === "-" ? readStdin() : text!;
  } catch {
    return { problems: ["cannot read the SQL"] };
  }
  if (sql.trim().length === 0) return { problems: ["the SQL is empty"] };
  const raw = args.flags["params"];
  if (raw === undefined) return { sql };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { problems: ["--params must be a JSON array or object"] };
  }
  if (parsed === null || typeof parsed !== "object") return { problems: ["--params must be a JSON array or object"] };
  return { sql, params: parsed as QueryParams };
}

/** The search request from argv, or the reasons it is unusable. */
export function searchFromArgs(args: ParsedArgs):
  | { collection: string; input: { column: string; q: string; language?: string; type?: "plain" | "phrase" | "websearch"; limit?: number; cursor?: string } }
  | { problems: string[] } {
  const problems: string[] = [];
  const collection = args.positional[1];
  const column = args.flags["column"];
  const q = args.flags["q"];
  if (collection === undefined) problems.push("give the collection");
  if (column === undefined) problems.push("--column is required");
  if (q === undefined) problems.push("--q is required");
  const type = args.flags["type"];
  if (type !== undefined && type !== "plain" && type !== "phrase" && type !== "websearch") problems.push("--type must be plain, phrase or websearch");
  const limitRaw = args.flags["limit"];
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1) problems.push("--limit must be a positive integer");
  }
  if (problems.length > 0) return { problems };
  const input: { column: string; q: string; language?: string; type?: "plain" | "phrase" | "websearch"; limit?: number; cursor?: string } = {
    column: column!,
    q: q!,
  };
  const language = args.flags["language"];
  const cursor = args.flags["cursor"];
  if (language !== undefined) input.language = language;
  if (type !== undefined) input.type = type as "plain" | "phrase" | "websearch";
  if (limit !== undefined) input.limit = limit;
  if (cursor !== undefined) input.cursor = cursor;
  return { collection: collection!, input };
}

function rowsPerLine(rows: ReadonlyArray<unknown>): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

function usage(format: ReturnType<typeof resolveOutputFormat>, cmd: string, problems: string[], recommendation: string): number {
  emitError(format, new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message: `k9o ${cmd}: ${problems.join("; ")}`,
    context: {},
    recommendation,
  }));
  return EXIT_USAGE;
}

export async function dispatchQuery(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  if (args.flags["help"] === "true") {
    printQueryHelp();
    return EXIT_SUCCESS;
  }
  try {
    const got = queryFromArgs(args);
    if ("problems" in got) {
      return usage(format, "query", got.problems, `k9o query "SELECT * FROM users WHERE role = :role" --params '{"role":"admin"}'`);
    }
    const { client } = clientFromProfile(args, { requireProject: true });
    const env = await client.query(got.sql, got.params);
    emitSuccess(format, env, (rows) => rowsPerLine(rows));
    return EXIT_SUCCESS;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

export async function dispatchSearch(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  if (args.flags["help"] === "true") {
    printSearchHelp();
    return EXIT_SUCCESS;
  }
  try {
    const got = searchFromArgs(args);
    if ("problems" in got) {
      return usage(format, "search", got.problems, "k9o search articles --column body --q 'climate resilience'");
    }
    const { client } = clientFromProfile(args, { requireProject: true });
    const env = await client.search(got.collection, got.input);
    emitSuccess(format, env, (rows) => rowsPerLine(rows));
    return EXIT_SUCCESS;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}
