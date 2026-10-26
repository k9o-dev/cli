/**
 * `k9o audit` subcommands.
 *
 * Wire to `client.audit.*` (GET /@{project}/audit-log). The route filters by
 * event type, actor and time window (after / before) and pages by cursor; it
 * cannot filter by target.
 *
 *   - `tail`   — events from the last N minutes, fetched once (NOT a live stream)
 *   - `query`  — historical events with the filter set
 *   - `export` — writes every matching event to an NDJSON file
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
  tail                          Recent events, fetched once for the last N minutes
                                 (--since-minutes, default 5; --limit). Not a live
                                 stream: run it again to see newer events.
  query                         Query historical events
                                 --event-type <type>  --actor <actorId>
                                 --after <ISO time>   --before <ISO time>
                                 --limit <1-200>      --cursor <cursor>
  export <file>                 Write all matching events to an NDJSON file
                                 (same filters as query; pages through the results)
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

type AuditFlags = {
  eventType?: string | undefined; actorId?: string | undefined;
  after?: string | undefined; before?: string | undefined;
  limit?: number | undefined; cursor?: string | undefined;
};

/** Map flags to the route's filters. `--type`, `--since` and `--until` are older spellings of `--event-type`, `--after` and `--before`. */
function parseAuditQueryFlags(args: ParsedArgs): AuditFlags {
  for (const gone of ["target-kind", "target-id"]) {
    if (args.flags[gone] !== undefined) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `--${gone} is not supported: the audit log cannot be filtered by target`,
        context: { flag: gone },
        recommendation: "Filter with --event-type, --actor, --after or --before.",
      });
    }
  }
  return {
    eventType: args.flags["event-type"] ?? args.flags["type"],
    actorId: args.flags["actor"],
    after: args.flags["after"] ?? args.flags["since"],
    before: args.flags["before"] ?? args.flags["until"],
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
      recommendation: "k9o audit export events.ndjson --after 2026-01-01T00:00:00Z",
    }));
    return EXIT_USAGE;
  }
  const { client } = clientFromProfile(args);
  const filters = parseAuditQueryFlags(args);
  // Page through every matching event (the route returns at most 200 a page).
  // --limit, when given, caps the total written.
  const cap = filters.limit;
  const events: AuditEvent[] = [];
  let cursor = filters.cursor;
  for (;;) {
    const pageSize = cap !== undefined ? Math.min(200, cap - events.length) : 200;
    const envelope = await client.audit.query({ ...filters, limit: pageSize, cursor });
    events.push(...envelope.data);
    const next = (envelope.meta["cursor"] as { next?: string | null } | undefined)?.next ?? null;
    if (next === null || envelope.data.length === 0 || (cap !== undefined && events.length >= cap)) break;
    cursor = next;
  }
  // One event per line: NDJSON.
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
  writeFileSync(outFile, lines, "utf8");
  emitSuccess(format, {
    data: { file: outFile, count: events.length },
    meta: {},
  }, (d) => `Wrote ${d.count} audit events to ${d.file} (NDJSON format).`);
  return EXIT_SUCCESS;
}
