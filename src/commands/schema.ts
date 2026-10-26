/**
 * `k9o schema` subcommands: collections, over `client.schema.collections`.
 *
 * `collections` lists the project's collections by name, one page per call. The next page's cursor is printed
 * (human output) or sits in `meta.cursor.next` (`--output json`).
 */

import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, textFlag, usageError } from "./json-flag.ts";

function printHelp(): void {
  process.stdout.write(`
k9o schema — inspect the project's data schema

USAGE
  k9o schema <subcommand> [flags...]

SUBCOMMANDS
  collections [--limit <1-200>] [--cursor <cursor>]
                                List collections by name with row, column and index counts and the
                                last migration. Pages of --limit (default 50); pass the printed
                                cursor to --cursor for the next page.

EXAMPLES
  k9o schema collections --limit 20
  k9o schema collections --limit 20 --cursor b3JkZXJz
`.trim() + "\n");
}

export async function dispatchSchema(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "collections") return await cmdCollections(args);
    return usageError(format, `unknown schema subcommand "${sub}"`, "Valid: collections");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

async function cmdCollections(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const limit = intFlag(args, "limit", 1, 200);
  if (typeof limit === "string") return usageError(format, limit);
  if (args.flags["cursor"] === "true") return usageError(format, "--cursor needs a value");
  const cursor = textFlag(args, "cursor");
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.schema.collections.list({
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  const next = (envelope.meta["cursor"] as { next?: string | null } | undefined)?.next ?? null;
  emitSuccess(format, envelope, (rows) => {
    if (rows.length === 0) return "No collections.";
    const lines = rows.map(
      (c) => `  ${c.name.padEnd(28)}  ${String(c.rowCount).padStart(9)} rows  ${String(c.columnCount).padStart(3)} cols  ${String(c.indexCount).padStart(3)} idx  ${c.lastMigrationSlug ?? "-"}`,
    );
    return ["Collections:", ...lines, ...(next !== null ? [`More: --cursor ${next}`] : [])].join("\n");
  });
  return EXIT_SUCCESS;
}
