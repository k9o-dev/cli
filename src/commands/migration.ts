/**
 * `k9o migration` subcommands.
 *
 * Migration commands: list / status / apply.
 * Wave 1.1: pending / apply-pending — the by-id fast-path apply for a
 * migration a caller (e.g. the Console "New collection" wizard) already
 * queued via `POST /migrations/queue` but has no UI apply affordance for
 * yet. `client.migrations.applyPending`/`listPending` already existed in
 * the SDK; this just gives the CLI a command surface for them, so a queued
 * migration isn't stuck with no completion path outside hand-writing a
 * script against the SDK.
 * Wave 2 (future): new / rollback (rollback needs gateway-side rollback semantics).
 */

import { KError, type Migration } from "@k9o/core";
import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

function printMigrationHelp(): void {
  process.stdout.write(`
k9o migration — apply + inspect schema migrations

USAGE
  k9o migration <subcommand> [args...] [flags...]

SUBCOMMANDS
  list                          List applied migrations on the active project
  apply <file>                  Apply migrations from a JSON file
                                 ({ "migrations": [{ "version", "slug", "up", "down" }] })
  pending                       List queued migrations awaiting apply
  apply-pending <pendingId>     Apply a queued migration by id (PROJECT_ADMIN;
                                 a migration awaiting protected-collection
                                 approval is refused here, not this command's
                                 fast path)
`.trim() + "\n");
}

export async function dispatchMigration(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printMigrationHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list" || sub === "status") return await cmdMigrationList(args);
    if (sub === "apply") return await cmdMigrationApply(args);
    if (sub === "pending") return await cmdMigrationPending(args);
    if (sub === "apply-pending") return await cmdMigrationApplyPending(args);
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown migration subcommand "${sub}"`,
      context: { sub },
      recommendation: "Valid: list | status | apply | pending | apply-pending",
    }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

async function cmdMigrationList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const envelope = await client.migrations.list();
  emitSuccess(format, envelope, (migrations) => {
    if (migrations.length === 0) return "No applied migrations.";
    const rows = migrations.map((m) =>
      `  ${String(m.version).padEnd(20)}  ${m.slug.padEnd(40)}  ${m.appliedAt}`,
    );
    return ["Applied migrations:", ...rows].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdMigrationApply(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const file = args.flags["file"] ?? args.positional[2];
  if (file === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o migration apply requires <file> (positional) — a JSON file with { migrations: [...] }",
      context: {},
      recommendation: "k9o migration apply migrations.json",
    }));
    return EXIT_USAGE;
  }
  let body: { migrations: ReadonlyArray<Migration> };
  try {
    body = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `Failed to read or parse ${file}: ${e instanceof Error ? e.message : String(e)}`,
      context: { file },
      recommendation: "Pass a JSON file with shape: { \"migrations\": [{ \"version\": 1, \"slug\": \"init\", \"up\": [{ \"create_table\": { \"name\": \"...\", \"columns\": [...] } }], \"down\": [{ \"drop_table\": \"...\" }] }] }",
    });
  }
  const { client } = clientFromProfile(args);
  const envelope = await client.migrations.apply(body);
  emitSuccess(format, envelope, (result) => {
    if (result.applied.length === 0) return "No migrations applied (all already on this project).";
    return [
      `Applied ${result.applied.length} migration(s):`,
      ...result.applied.map((m) => `  ${m.version}  ${m.slug}  ${m.appliedAt}`),
    ].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdMigrationPending(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const envelope = await client.migrations.listPending();
  emitSuccess(format, envelope, (pending) => {
    if (pending.length === 0) return "No pending migrations.";
    const rows = pending.map((p) =>
      `  ${p.pendingId.padEnd(20)}  ${String(p.version).padEnd(10)}  ${p.slug.padEnd(30)}  submitted by ${p.submittedBy} at ${p.submittedAt}`,
    );
    return ["Pending migrations:", ...rows].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdMigrationApplyPending(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const pendingId = args.positional[2];
  if (pendingId === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o migration apply-pending requires <pendingId>",
      context: {},
      recommendation: "k9o migration pending   # to find the id, then\nk9o migration apply-pending pmig_...",
    }));
    return EXIT_USAGE;
  }
  const { client } = clientFromProfile(args);
  const envelope = await client.migrations.applyPending(pendingId);
  emitSuccess(format, envelope, (m) => `Applied ${m.version}  ${m.slug}  ${m.appliedAt}`);
  return EXIT_SUCCESS;
}
