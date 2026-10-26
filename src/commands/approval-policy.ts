/**
 * `k9o approval-policy` subcommands: list / create / delete, over `client.approvalPolicies`.
 *
 * A policy says what happens to writes on a collection that match a predicate: `queue` them for approval or
 * `auto_approve` them. `--predicate` takes the predicate as JSON.
 */

import type { ApprovalAction, ApprovalOperation, ApprovalPolicy } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { jsonObjectFlag, usageError } from "./json-flag.ts";

const COLLECTION_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function printHelp(): void {
  process.stdout.write(`
k9o approval-policy — rules that decide which writes wait for approval

USAGE
  k9o approval-policy <subcommand> [args...] [flags...]

SUBCOMMANDS
  list                          List the project's policies, oldest first (the first match decides)
  create --collection <name> --operation insert|update|delete --action queue|auto_approve
         --predicate '<json>'   Create a policy. The predicate is a JSON object such as
                                {"gt":["change.row.amount",1000]}. Policies apply to writes sent
                                with requireApproval.
  delete <id>                   Delete a policy

EXAMPLES
  k9o approval-policy create --collection orders --operation update --action queue \\
      --predicate '{"gt":["change.row.amount",1000]}'
  k9o approval-policy delete apo_123
`.trim() + "\n");
}

export async function dispatchApprovalPolicy(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdList(args);
    if (sub === "create") return await cmdCreate(args);
    if (sub === "delete") return await cmdDelete(args);
    return usageError(format, `unknown approval-policy subcommand "${sub}"`, "Valid: list | create | delete");
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function describe(p: ApprovalPolicy): string {
  return `${p.id}  ${p.operation.padEnd(6)}  ${p.collection.padEnd(24)}  ${p.action.padEnd(12)}  ${JSON.stringify(p.predicate)}`;
}

async function cmdList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.approvalPolicies.list(), (rows) =>
    rows.length === 0 ? "No approval policies." : ["Approval policies:", ...rows.map((p) => `  ${describe(p)}`)].join("\n"));
  return EXIT_SUCCESS;
}

async function cmdCreate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const example = `k9o approval-policy create --collection orders --operation update --action queue --predicate '{"gt":["change.row.amount",1000]}'`;
  const collection = args.flags["collection"];
  const operation = args.flags["operation"];
  const action = args.flags["action"];
  if (collection === undefined || !COLLECTION_RE.test(collection)) {
    return usageError(format, "k9o approval-policy create requires --collection <name>", "A name of letters, digits and underscores, starting with a letter or underscore (up to 63 characters)");
  }
  if (operation !== "insert" && operation !== "update" && operation !== "delete") return usageError(format, "--operation must be insert, update or delete", example);
  if (action !== "queue" && action !== "auto_approve") return usageError(format, "--action must be queue or auto_approve", example);
  const predicate = jsonObjectFlag(args, "predicate");
  if (predicate === undefined) return usageError(format, "k9o approval-policy create requires --predicate '<json>'", example);
  if (typeof predicate === "string") return usageError(format, predicate, example);
  const { client } = clientFromProfile(args, { requireProject: true });
  const envelope = await client.approvalPolicies.create({
    collection,
    operation: operation as ApprovalOperation,
    action: action as ApprovalAction,
    predicate,
  });
  emitSuccess(format, envelope, (p) => `Created. ${describe(p)}`);
  return EXIT_SUCCESS;
}

async function cmdDelete(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const id = args.positional[2];
  if (id === undefined || id.length === 0) return usageError(format, "k9o approval-policy delete requires <id> (positional)", "k9o approval-policy delete apo_123");
  const { client } = clientFromProfile(args, { requireProject: true });
  emitSuccess(format, await client.approvalPolicies.delete(id), (r) => `Policy ${r.id} deleted.`);
  return EXIT_SUCCESS;
}
