/**
 * `k9o approvals` subcommands: list / get / approve / reject / bulk, over `client.approvals`.
 *
 * `bulk` takes the selection as a JSON predicate in `--criteria`. A bulk run skips rows that fail without reporting
 * them, so the command prints the ids it decided: compare them with what you meant to decide.
 */

import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { intFlag, jsonObjectFlag, textFlag, usageError } from "./json-flag.ts";
import type { PendingChange, PendingChangeStatus } from "@k9o/core";

const STATUSES = ["pending_approval", "approved", "rejected", "expired", "redeemed"];

function printHelp(): void {
  process.stdout.write(`
k9o approvals — review changes waiting for approval

USAGE
  k9o approvals <subcommand> [args...] [flags...]

SUBCOMMANDS
  list [--status <s>] [--limit <1-200>]
                                List pending changes, newest first. Not paginated: --limit caps
                                the result (default 50). --status is pending_approval, approved,
                                rejected, expired or redeemed. Admins and auditors see every
                                change; other members see only their own.
  get <id>                      Show one change
  approve <id> [--reason <text>]
                                Approve a change. When more approvers are needed the change stays
                                pending_approval: your approval is recorded, it is not applied yet.
  reject <id> --reason <text>   Reject a change (reason required)
  bulk --action approve|reject --criteria '<json>' [--reason <text>]
                                Decide every pending change that matches a predicate. Rows that
                                fail are skipped silently: compare the printed ids with what you
                                intended. --reason is required for reject.

EXAMPLES
  k9o approvals list --status pending_approval --limit 20
  k9o approvals approve apr_123 --reason "checked with finance"
  k9o approvals reject apr_123 --reason "duplicate"
  k9o approvals bulk --action reject --reason stale --criteria '{"eq":["change.table","orders"]}'
`.trim() + "\n");
}

function describe(c: PendingChange): string {
  return [
    `Change ${c.id}`,
    `  status: ${c.status}`,
    `  ${c.operation} on ${c.collection}${c.targetRecordId !== null ? ` (${c.targetRecordId})` : ""}`,
    `  proposed by: ${c.makerId}`,
    `  created: ${c.createdAt}`,
    ...(c.expiresAt !== null ? [`  expires: ${c.expiresAt}`] : []),
    ...(c.approverId !== null ? [`  decided by: ${c.approverId} at ${c.decidedAt ?? "-"}`] : []),
    ...(c.decisionReason !== null ? [`  reason: ${c.decisionReason}`] : []),
  ].join("\n");
}

export async function dispatchApprovals(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdList(args);
    if (sub === "get") return await cmdGet(args);
    if (sub === "approve") return await cmdApprove(args);
    if (sub === "reject") return await cmdReject(args);
    if (sub === "bulk") return await cmdBulk(args);
    return usageError(format, `unknown approvals subcommand "${sub}"`, "Valid: list | get | approve | reject | bulk");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function idArg(args: ParsedArgs): string | null {
  const id = args.positional[2];
  return id === undefined || id.length === 0 ? null : id;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const status = args.flags["status"];
  if (status !== undefined && !STATUSES.includes(status)) return usageError(format, `invalid --status "${status}"`, `Use one of: ${STATUSES.join(", ")}`);
  const limit = intFlag(args, "limit", 1, 200);
  if (typeof limit === "string") return usageError(format, limit);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.approvals.list({
    ...(status !== undefined ? { status: status as PendingChangeStatus } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  emitSuccess(format, envelope, (rows) => {
    if (rows.length === 0) return "No pending changes.";
    const lines = rows.map((c) => `  ${c.id.padEnd(24)}  ${c.status.padEnd(16)}  ${c.operation.padEnd(6)}  ${c.collection.padEnd(24)}  ${c.makerId}  ${c.createdAt}`);
    return ["Pending changes:", ...lines].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args);
  if (id === null) return usageError(format, "k9o approvals get requires <id> (positional)", "k9o approvals get apr_123");
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.approvals.get(id), describe);
  return EXIT_SUCCESS;
}

async function cmdApprove(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args);
  if (id === null) return usageError(format, "k9o approvals approve requires <id> (positional)", "k9o approvals approve apr_123 --reason ok");
  if (args.flags["reason"] === "true") return usageError(format, "--reason needs a value");
  const reason = textFlag(args, "reason");
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.approvals.approve(id, reason === undefined ? {} : { reason });
  emitSuccess(format, envelope, (c) =>
    c.status === "pending_approval"
      ? `Approval recorded, but more approvers are needed: the change is still pending.\n${describe(c)}`
      : `Approved. ${describe(c)}`);
  return EXIT_SUCCESS;
}

async function cmdReject(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = idArg(args);
  const example = "k9o approvals reject apr_123 --reason duplicate";
  if (id === null) return usageError(format, "k9o approvals reject requires <id> (positional)", example);
  const reason = textFlag(args, "reason");
  if (reason === undefined || reason.trim().length === 0) return usageError(format, "k9o approvals reject requires --reason <text>", example);
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.approvals.reject(id, { reason }), (c) => `Rejected. ${describe(c)}`);
  return EXIT_SUCCESS;
}

async function cmdBulk(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o approvals bulk --action reject --reason stale --criteria '{"eq":["change.table","orders"]}'`;
  const action = args.flags["action"];
  if (action !== "approve" && action !== "reject") return usageError(format, "k9o approvals bulk requires --action approve|reject", example);
  const criteria = jsonObjectFlag(args, "criteria");
  if (criteria === undefined) return usageError(format, "k9o approvals bulk requires --criteria '<json>'", example);
  if (typeof criteria === "string") return usageError(format, criteria, example);
  const reason = textFlag(args, "reason");
  if (args.flags["reason"] === "true") return usageError(format, "--reason needs a value");
  if (action === "reject" && (reason === undefined || reason.trim().length === 0)) return usageError(format, "bulk reject requires --reason <text>", example);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.approvals.bulk({ action, criteria, ...(reason !== undefined ? { reason } : {}) });
  emitSuccess(format, envelope, (r) => {
    const verb = r.action === "approve" ? "Approved" : "Rejected";
    return [
      `${verb} ${r.affectedCount} change${r.affectedCount === 1 ? "" : "s"} (batch ${r.attestationId}).`,
      ...r.affectedIds.map((i) => `  ${i}`),
      "Changes that failed were skipped without a report: compare these ids with what you intended.",
    ].join("\n");
  });
  return EXIT_SUCCESS;
}
