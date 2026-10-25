/**
 * `k9o audit` subcommands.
 *
 * Wire to `client.audit.*` per @k9o/core.
 *
 * Audit commands: tail / query / export.
 *   - `tail` — recent events (read-once; subscription-mode SSE tail
 *     lands when streaming substrate ships)
 *   - `query` — historical events with full filter set
 *   - `export` — writes results to a file (NDJSON for streaming-friendly
 *     consumption); `export` wraps `query` + a file write
 */

import { KError, type AuditEvent } from "@k9o/core";
import { writeFileSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

function printAuditHelp(): void {
  process.stdout.write(`
k9o audit — query and export project audit events

USAGE
  k9o audit <subcommand> [args...] [flags...]

SUBCOMMANDS
  tail                          Tail recent audit events (--since-minutes, --limit)
  query                         Query historical events (--since/--until/--type/--actor/...)
  export <file>                 Export query results to an NDJSON file
`.trim() + "\n");
}

export async function dispatchAudit(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printAuditHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "tail") return await cmdAuditTail(args);
    if (sub === "query") return await cmdAuditQuery(args);
    if (sub === "export") return await cmdAuditExport(args);
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown audit subcommand "${sub}"`,
      context: { sub },
      recommendation: "Valid: tail | query | export",
    }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function renderEvent(e: AuditEvent): string {
  return `  ${e.occurredAt}  ${e.type.padEnd(40)}  actor=${e.actorId ?? "-"}  target=${e.targetKind ?? "-"}:${e.targetId ?? "-"}`;
}

async function cmdAuditTail(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const sinceMinutes = args.flags["since-minutes"] !== undefined ? parseInt(args.flags["since-minutes"]!, 10) : 5;
  const limit = args.flags["limit"] !== undefined ? parseInt(args.flags["limit"]!, 10) : 100;
  const envelope = await client.audit.tail({ sinceMinutes, limit });
  emitSuccess(format, envelope, (events) => {
    if (events.length === 0) return `No audit events in the last ${sinceMinutes} minute(s).`;
    return [`${events.length} event(s) in the last ${sinceMinutes} minute(s):`, ...events.map(renderEvent)].join("\n");
  });
  return EXIT_SUCCESS;
}

function parseAuditQueryFlags(args: ParsedArgs): {
  since?: string | undefined; until?: string | undefined; type?: string | undefined; actorId?: string | undefined;
  targetKind?: string | undefined; targetId?: string | undefined; limit?: number | undefined; cursor?: string | undefined;
} {
  return {
    since: args.flags["since"],
    until: args.flags["until"],
    type: args.flags["type"],
    actorId: args.flags["actor"],
    targetKind: args.flags["target-kind"],
    targetId: args.flags["target-id"],
    limit: args.flags["limit"] !== undefined ? parseInt(args.flags["limit"]!, 10) : undefined,
    cursor: args.flags["cursor"],
  };
}

async function cmdAuditQuery(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const envelope = await client.audit.query(parseAuditQueryFlags(args));
  emitSuccess(format, envelope, (events) => {
    if (events.length === 0) return "No matching audit events.";
    return [`${events.length} event(s):`, ...events.map(renderEvent)].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdAuditExport(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const outFile = args.flags["out"] ?? args.positional[2];
  if (outFile === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o audit export requires --out <file> (or positional path)",
      context: {},
      recommendation: "k9o audit export events.ndjson --since 2026-01-01T00:00:00Z",
    }));
    return EXIT_USAGE;
  }
  const { client } = clientFromProfile(args);
  const envelope = await client.audit.query(parseAuditQueryFlags(args));
  // Emit one event per line — NDJSON for streaming-friendly consumption.
  const lines = envelope.data.map((e) => JSON.stringify(e)).join("\n") + (envelope.data.length > 0 ? "\n" : "");
  writeFileSync(outFile, lines, "utf8");
  emitSuccess(format, {
    data: { file: outFile, count: envelope.data.length },
    meta: envelope.meta,
  }, (d) => `Wrote ${d.count} audit events to ${d.file} (NDJSON format).`);
  return EXIT_SUCCESS;
}
