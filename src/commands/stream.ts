/**
 * `k9o stream` subcommands.
 *
 * create / list / get / delete / publish / tail / replay, over `client.streams`.
 *
 * `publish` takes the event as JSON: inline, `@file`, or `-` for stdin. `tail` follows a stream live and reopens its
 * connection by itself; it runs until interrupted (Ctrl-C) or until `--count` events have been printed.
 */

import { KError, type StreamEvent, type StreamRecord } from "@k9o/core";
import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat, type OutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

const GIB = 1024 ** 3;

function printStreamHelp(): void {
  process.stdout.write(`
k9o stream — publish to and read from your project's data streams

USAGE
  k9o stream <subcommand> [args...] [flags...]

SUBCOMMANDS
  create --name <display name> --max-bytes <size> [--retention <time>]
                                Create a stream (project admin)
                                 --max-bytes  1, 2, 4, 8, 16, 32 or 64 GiB: bytes, or a size like 4GiB
                                 --retention  whole hours, at least 1h: seconds, or 24h / 7d (default 24h)
  list                          List the project's streams
  get <slug>                    Show one stream
  delete <slug>                 Retire a stream (project admin)
  publish <slug> --data <json|@file|-> [--subject <suffix>]
                                Append an event (project admin). '-' reads the JSON from stdin.
                                --subject is up to 8 dot-separated tokens of [a-z0-9_-]
  tail <slug> [--from <sequence>] [--count <n>]
                                Follow a stream live, one event per line, until interrupted
                                (project admin or auditor). Starts after --from; with --output json
                                each line is one JSON event.
  replay <slug> [--from <sequence>] [--until <sequence>] [--limit <n>]
                                Read a bounded range once (project admin or auditor). --limit is
                                1 to 10000 (default 100). --from is exclusive.

EXAMPLES
  k9o stream create --name Orders --max-bytes 1GiB
  k9o stream publish orders --data '{"id":1,"total":42}'
  echo '{"id":2}' | k9o stream publish orders --data - --subject eu.new
  k9o stream tail orders --from 100
  k9o stream replay orders --from 0 --limit 50 --output json
`.trim() + "\n");
}

export async function dispatchStream(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printStreamHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "create") return await cmdCreate(args);
    if (sub === "list") return await cmdList(args);
    if (sub === "get") return await cmdGet(args);
    if (sub === "delete") return await cmdDelete(args);
    if (sub === "publish") return await cmdPublish(args);
    if (sub === "tail") return await cmdTail(args);
    if (sub === "replay") return await cmdReplay(args);
    return usage(format, `unknown stream subcommand "${sub}"`, "Valid: create | list | get | delete | publish | tail | replay");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function usage(format: OutputFormat, message: string, recommendation?: string): number {
  emitError(format, new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message,
    context: {},
    ...(recommendation !== undefined ? { recommendation } : {}),
  }));
  return EXIT_USAGE;
}

/** A whole-number flag, or undefined when absent. Returns an error message when present but invalid. */
function intFlag(args: ParsedArgs, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined | string {
  const raw = args.flags[name];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    return `--${name} must be a whole number from ${min} to ${max}`;
  }
  return Number(raw);
}

/** `1073741824`, `4GiB` or `4g` -> bytes. */
export function parseSize(raw: string): number | null {
  const m = /^(\d+)\s*(gib|gb|g)?$/i.exec(raw.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  return m[2] === undefined ? n : n * GIB;
}

/** `900`, `15m`, `24h` or `7d` -> seconds. */
export function parseDuration(raw: string): number | null {
  const m = /^(\d+)\s*([smhd])?$/i.exec(raw.trim());
  if (m === null) return null;
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? "s").toLowerCase() as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

function slugArg(args: ParsedArgs): string | null {
  const slug = args.positional[2];
  return slug === undefined || slug.length === 0 ? null : slug;
}

function needSlug(format: OutputFormat, sub: string, example: string): number {
  return usage(format, `k9o stream ${sub} requires <slug> (positional)`, example);
}

const sizeText = (b: number | null): string => (b === null ? "-" : b % GIB === 0 ? `${b / GIB}GiB` : `${b}B`);
const retentionText = (s: number): string => (s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`);

function describeStream(s: StreamRecord): string {
  return [
    `Stream ${s.slug} (${s.id})`,
    `  name: ${s.displayName}`,
    `  status: ${s.status}`,
    `  region: ${s.region}`,
    `  retention: ${retentionText(s.retentionSeconds)} (${s.retentionClass})`,
    `  max size: ${sizeText(s.maxBytes)}`,
    `  created: ${s.createdAt}`,
  ].join("\n");
}

async function cmdCreate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = "k9o stream create --name Orders --max-bytes 1GiB --retention 24h";
  const name = args.flags["name"];
  const rawSize = args.flags["max-bytes"];
  if (name === undefined || name === "true" || name.length === 0) return usage(format, "k9o stream create requires --name <display name>", example);
  if (rawSize === undefined) return usage(format, "k9o stream create requires --max-bytes <size>", "Sizes: 1, 2, 4, 8, 16, 32 or 64 GiB, e.g. --max-bytes 4GiB");
  const maxBytes = parseSize(rawSize);
  if (maxBytes === null || maxBytes < 1) return usage(format, `invalid --max-bytes "${rawSize}"`, "Use bytes or a size like 4GiB");
  let retentionSeconds: number | undefined;
  if (args.flags["retention"] !== undefined) {
    const r = parseDuration(args.flags["retention"]);
    if (r === null) return usage(format, `invalid --retention "${args.flags["retention"]}"`, "Use seconds, or 24h / 7d");
    retentionSeconds = r;
  }
  const { client } = clientFromProfile(args);
  const envelope = await client.streams.create({ displayName: name, maxBytes, ...(retentionSeconds !== undefined ? { retentionSeconds } : {}) });
  emitSuccess(format, envelope, (s) => `Created. ${describeStream(s)}`);
  return EXIT_SUCCESS;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const envelope = await client.streams.list();
  emitSuccess(format, envelope, (streams) => {
    if (streams.length === 0) return "No streams.";
    const rows = streams.map((s) => `  ${s.slug.padEnd(28)}  ${retentionText(s.retentionSeconds).padEnd(6)}  ${sizeText(s.maxBytes).padEnd(7)}  ${s.status.padEnd(8)}  ${s.displayName}`);
    return ["Streams:", ...rows].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args);
  if (slug === null) return needSlug(format, "get", "k9o stream get orders");
  const { client } = clientFromProfile(args);
  emitSuccess(format, await client.streams.get(slug), describeStream);
  return EXIT_SUCCESS;
}

async function cmdDelete(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args);
  if (slug === null) return needSlug(format, "delete", "k9o stream delete orders");
  const { client } = clientFromProfile(args);
  emitSuccess(format, await client.streams.delete(slug), () => `Stream "${slug}" retired.`);
  return EXIT_SUCCESS;
}

/** The event JSON from `--data`: inline, `@file`, or `-` for stdin. */
function readData(raw: string): unknown {
  let text: string;
  const source = raw === "-" ? "stdin" : raw.startsWith("@") ? raw.slice(1) : null;
  try {
    text = raw === "-" ? readFileSync(0, "utf8") : raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  } catch (e) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `Failed to read --data from ${source}: ${e instanceof Error ? e.message : String(e)}`,
      context: { source },
    });
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `--data is not valid JSON${source === null ? "" : ` (from ${source})`}: ${e instanceof Error ? e.message : String(e)}`,
      context: {},
      recommendation: "Quote strings, e.g. --data '\"hello\"'",
    });
  }
}

async function cmdPublish(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = "k9o stream publish orders --data '{\"id\":1}'";
  const slug = slugArg(args);
  if (slug === null) return needSlug(format, "publish", example);
  const raw = args.flags["data"];
  if (raw === undefined || raw === "true") return usage(format, "k9o stream publish requires --data <json|@file|->", example);
  const subject = args.flags["subject"];
  if (subject === "true") return usage(format, "--subject needs a value", "e.g. --subject eu.new");
  const data = readData(raw);
  const { client } = clientFromProfile(args);
  const envelope = await client.streams.publish(slug, data, subject === undefined ? {} : { subject });
  emitSuccess(format, envelope, (r) => `Accepted ${r.bytes} bytes on ${r.subject}`);
  return EXIT_SUCCESS;
}

/** The part of the subject after the stream's own prefix, e.g. `eu.new` (or `_` when published without one). */
function subjectSuffix(subject: string): string {
  const m = /\.user\.pstr_[^.]+\.(.+)$/.exec(subject);
  return m === null ? subject : m[1]!;
}

function eventLine(format: OutputFormat, e: StreamEvent): string {
  if (format === "json") return JSON.stringify(e);
  return `${e.sequence}  ${e.publishedAt}  ${subjectSuffix(e.subject)}  ${JSON.stringify(e.data)}`;
}

async function cmdTail(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args);
  if (slug === null) return needSlug(format, "tail", "k9o stream tail orders --from 100");
  const from = intFlag(args, "from", 0);
  if (typeof from === "string") return usage(format, from);
  const count = intFlag(args, "count", 1);
  if (typeof count === "string") return usage(format, count);
  const { client } = clientFromProfile(args);

  const stop = new AbortController();
  const onSigint = () => stop.abort();
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigint);
  let printed = 0;
  try {
    for await (const event of client.streams.subscribe(slug, { ...(from !== undefined ? { fromSequence: from } : {}), signal: stop.signal })) {
      process.stdout.write(eventLine(format, event) + "\n");
      printed++;
      if (count !== undefined && printed >= count) break;
    }
  } finally {
    stop.abort();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigint);
  }
  return EXIT_SUCCESS;
}

async function cmdReplay(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = slugArg(args);
  if (slug === null) return needSlug(format, "replay", "k9o stream replay orders --from 0 --limit 50");
  const from = intFlag(args, "from", 0);
  if (typeof from === "string") return usage(format, from);
  const until = intFlag(args, "until", 0);
  if (typeof until === "string") return usage(format, until);
  const limit = intFlag(args, "limit", 1, 10_000);
  if (typeof limit === "string") return usage(format, limit);
  const { client } = clientFromProfile(args);
  const envelope = await client.streams.replay(slug, {
    ...(from !== undefined ? { fromSequence: from } : {}),
    ...(until !== undefined ? { untilSequence: until } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  emitSuccess(format, envelope, (r) => {
    if (r.events.length === 0) return "No events.";
    const lines = r.events.map((e) => eventLine("human", e));
    if (r.hasMore && r.nextCursor !== null) lines.push(`More events: continue with --from ${r.nextCursor}`);
    return lines.join("\n");
  });
  return EXIT_SUCCESS;
}
