/**
 * `k9o policy` subcommands.
 *
 * Wire to `client.policies.*`: list / current / get / validate / apply
 * (create a draft) / publish. A bundle is `{ policy, rules? }`: `policy` is the
 * per-surface document (collections, storage, tools, functions, secrets,
 * streams, analytics) and `rules` the named-rule catalogue. A bundle has no
 * name or version of its own.
 */

import { readFileSync } from "node:fs";
import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { resolvePolicyDocument } from "../policy-include.ts";
import { wire, type WirePolicyBundle, type WirePublishResult } from "../wire.ts";

/**
 * Resolve `k9o policy validate/apply <file> [<file> ...]`'s positional file
 * args into the document to submit.
 *
 * A single file with no top-level `include` field is passed through as
 * parsed. The `include`-graph / multi-file merge logic (which requires every
 * involved file to be shaped `{rules, policy}`) only activates when the
 * customer opts into composition, by using `include` or passing >1 file.
 */
export function loadPolicyDocument(args: ParsedArgs): Record<string, unknown> {
  const files = args.positional.slice(2);
  const legacyFileFlag = args.flags["file"];
  const entryFiles = files.length > 0 ? files : legacyFileFlag !== undefined ? [legacyFileFlag] : [];
  if (entryFiles.length === 0) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "requires at least one <file> (positional) — a JSON policy file",
      context: {},
    });
  }

  if (entryFiles.length === 1) {
    const file = entryFiles[0]!;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `Failed to read or parse ${file}: ${e instanceof Error ? e.message : String(e)}`,
        context: { file },
      });
    }
    if (raw["include"] === undefined) return raw; // no composition requested — pass through unchanged
  }

  const { rules, policy } = resolvePolicyDocument(entryFiles);
  return Object.keys(policy).length > 0 ? { rules, policy } : { rules };
}

/**
 * Shape a loaded document into the request body the gateway takes:
 * `{ policy, rules? }`. A file shaped `{ policy, rules }` (or `{ rules }`)
 * maps straight across; any other object is treated as the policy document
 * itself.
 */
export function toPolicyBody(doc: Record<string, unknown>): { policy: Record<string, unknown>; rules?: unknown } {
  const policy = doc["policy"];
  const hasPolicy = typeof policy === "object" && policy !== null && !Array.isArray(policy);
  const hasRules = doc["rules"] !== undefined;
  if (hasPolicy || hasRules) {
    return {
      policy: hasPolicy ? (policy as Record<string, unknown>) : {},
      ...(hasRules ? { rules: doc["rules"] } : {}),
    };
  }
  return { policy: doc };
}

function printPolicyHelp(): void {
  process.stdout.write(`
k9o policy — manage policy bundles

USAGE
  k9o policy <subcommand> [args...] [flags...]

SUBCOMMANDS
  list                          List policy bundles (--status draft|published|superseded)
  current                       Show the currently-published policy
  get <id>                      Get a policy bundle by id
  validate <file> [<file> ...]  Check one or more policy JSON files without persisting
  apply <file> [<file> ...]     Create a draft bundle from one or more policy JSON files
  publish <id>                  Publish a draft bundle (activate on the project)

A policy file is { "policy": { ... }, "rules": { ... } }; a file without a
"policy" or "rules" key is taken to be the policy document itself.
A file with a top-level "include" array pulls in other files' rules
automatically; passing several files composes them together. Either way
only one fully-resolved document is ever submitted.

Publishing may need a second approver (maker-checker): the command then
reports the queued approval instead of an active bundle.
`.trim() + "\n");
}

export async function dispatchPolicy(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printPolicyHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdPolicyList(args);
    if (sub === "current") return await cmdPolicyCurrent(args);
    if (sub === "get") return await cmdPolicyGet(args);
    if (sub === "validate") return await cmdPolicyValidate(args);
    if (sub === "apply") return await cmdPolicyApply(args);
    if (sub === "publish") return await cmdPolicyPublish(args);
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown policy subcommand "${sub}"`,
      context: { sub },
      recommendation: "Valid: list | current | get | validate | apply | publish",
    }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

async function cmdPolicyList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const status = args.flags["status"] as "draft" | "published" | "superseded" | undefined;
  if (status !== undefined && !["draft", "published", "superseded"].includes(status)) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `invalid --status "${status}"`,
      context: { status },
      recommendation: "Valid: draft | published | superseded",
    }));
    return EXIT_USAGE;
  }
  const envelope = wire<ReadonlyArray<WirePolicyBundle>>(await client.policies.list(status !== undefined ? { status: status as never } : undefined));
  emitSuccess(format, envelope, (bundles) => {
    if (bundles.length === 0) return "No policy bundles.";
    const rows = bundles.map((b) => `  ${b.id.padEnd(24)}  ${b.status.padEnd(12)}  created ${b.createdAt}${b.publishedAt !== null ? `  published ${b.publishedAt}` : ""}`);
    return ["Policy bundles:", ...rows].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdPolicyCurrent(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  try {
    const envelope = wire<WirePolicyBundle>(await client.policies.current());
    emitSuccess(format, envelope, (b) => `Published policy: ${b.id} (published ${b.publishedAt})`);
  } catch (e) {
    if (e instanceof KError && e.code === "K9O_POLICY_NOT_FOUND") {
      emitSuccess(format, { data: null, meta: {} }, () => "No published policy on this project.");
      return EXIT_SUCCESS;
    }
    throw e;
  }
  return EXIT_SUCCESS;
}

async function cmdPolicyGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const bundleId = args.positional[2];
  if (bundleId === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o policy get requires <bundleId> (positional)",
      context: {},
      recommendation: "k9o policy get pol_abc123",
    }));
    return EXIT_USAGE;
  }
  const { client } = clientFromProfile(args);
  const envelope = wire<WirePolicyBundle>(await client.policies.get(bundleId));
  emitSuccess(format, envelope, (b) =>
    `Policy ${b.id}\n  status: ${b.status}\n  published: ${b.publishedAt ?? "(not published)"}\n  createdBy: ${b.createdBy}\n  created: ${b.createdAt}`,
  );
  return EXIT_SUCCESS;
}

async function cmdPolicyValidate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  if (args.positional.length < 3 && args.flags["file"] === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o policy validate requires <file> [<file> ...] (positional) — one or more JSON policy files",
      context: {},
      recommendation: "k9o policy validate policy.json   (or: k9o policy validate a.json b.json)",
    }));
    return EXIT_USAGE;
  }
  const body = toPolicyBody(loadPolicyDocument(args));
  const { client } = clientFromProfile(args);
  // The gateway answers { valid: true } or rejects with the reason (a KError).
  const envelope = await client.policies.validate(body);
  emitSuccess(format, envelope, () => "Policy is valid.");
  return EXIT_SUCCESS;
}

async function cmdPolicyApply(args: ParsedArgs): Promise<number> {
  // "apply" = create a draft bundle from one or more policy JSON files (the
  // gateway's create endpoint) — multi-file composition's include
  // mechanics. Publishing is a separate step (`k9o policy publish <id>`).
  const format = resolveOutputFormat(args.flags);
  if (args.positional.length < 3 && args.flags["file"] === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o policy apply requires <file> [<file> ...] (positional)",
      context: {},
      recommendation: "k9o policy apply policy.json   (or: k9o policy apply a.json b.json)",
    }));
    return EXIT_USAGE;
  }
  if (args.flags["name"] !== undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "policy bundles have no name; omit --name",
      context: {},
      recommendation: "k9o policy apply policy.json",
    }));
    return EXIT_USAGE;
  }
  const body = toPolicyBody(loadPolicyDocument(args));
  const { client } = clientFromProfile(args);
  const envelope = wire<WirePolicyBundle>(await client.policies.create(body));
  emitSuccess(format, envelope, (b) =>
    `Created draft policy ${b.id}. Run \`k9o policy publish ${b.id}\` to activate.`,
  );
  return EXIT_SUCCESS;
}

async function cmdPolicyPublish(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const bundleId = args.positional[2];
  if (bundleId === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o policy publish requires <bundleId> (positional)",
      context: {},
      recommendation: "k9o policy publish pol_abc123",
    }));
    return EXIT_USAGE;
  }
  const { client } = clientFromProfile(args);
  const envelope = wire<WirePublishResult>(await client.policies.publish(bundleId));
  emitSuccess(format, envelope, (b) =>
    b.pendingChangeId !== undefined
      ? `Publish of ${b.bundleId ?? bundleId} is awaiting approval (pending change ${b.pendingChangeId}). A different approver must approve it before it takes effect.`
      : `Published policy ${b.id ?? bundleId}. Active on this project.`,
  );
  return EXIT_SUCCESS;
}
