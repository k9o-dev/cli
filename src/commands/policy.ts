/**
 * `k9o policy` subcommands.
 *
 * Wire to `client.policies.*` per @k9o/core.
 *
 * Policy commands: list / current / get / validate / publish.
 * create/update/delete are not available yet (the write flow
 * needs a rules JSON file loader); the CLI ships read + lifecycle ops.
 */

import { readFileSync } from "node:fs";
import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { resolvePolicyDocument } from "../policy-include.ts";

/**
 * Resolve `k9o policy validate/apply <file> [<file> ...]`'s positional file
 * args into the document to submit.
 *
 * Backward-compat by construction: a single file with no top-level
 * `include` field is passed through EXACTLY as before (raw parsed JSON,
 * whatever shape it has) — zero behavior change for the existing
 * single-file workflow. The new `include`-graph / multi-file merge logic
 * (which requires every involved file to conform to the
 * `{rules, policy}` shape) only activates when the customer actually
 * opts into composition, by using `include` or passing >1 file.
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

function printPolicyHelp(): void {
  process.stdout.write(`
k9o policy — manage policy bundles

USAGE
  k9o policy <subcommand> [args...] [flags...]

SUBCOMMANDS
  list                          List policy bundles (--status draft|published|deactivated)
  current                       Show the currently-active policy
  get <id>                      Get a policy bundle by id
  validate <file> [<file> ...]  Lint one or more policy JSON files without persisting
  apply <file> [<file> ...] --name   Create a draft bundle from one or more policy JSON files
  publish <id>                  Publish a draft bundle (activate on project)

A file with a top-level "include" array pulls in other files' rules
automatically; passing several files composes them together. Either way
only one fully-resolved document is ever submitted.
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
  const status = args.flags["status"] as "draft" | "published" | "deactivated" | undefined;
  const envelope = await client.policies.list({ status });
  emitSuccess(format, envelope, (bundles) => {
    if (bundles.length === 0) return "No policy bundles.";
    const rows = bundles.map((b) => `  ${b.id.padEnd(24)}  v${String(b.version).padEnd(4)}  ${b.status.padEnd(12)}  ${b.name}`);
    return ["Policy bundles:", ...rows].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdPolicyCurrent(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const envelope = await client.policies.current();
  emitSuccess(format, envelope, (b) =>
    b === null ? "No active policy on this project." : `Active policy: ${b.id} v${b.version} "${b.name}" (published ${b.publishedAt})`,
  );
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
  const envelope = await client.policies.get(bundleId);
  emitSuccess(format, envelope, (b) =>
    `Policy ${b.id} v${b.version}\n  name: ${b.name}\n  status: ${b.status}\n  published: ${b.publishedAt ?? "(not published)"}\n  createdBy: ${b.createdBy}`,
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
  const rules = loadPolicyDocument(args);
  const { client } = clientFromProfile(args);
  const envelope = await client.policies.validate({ rules });
  emitSuccess(format, envelope, (result) => {
    const lines = [result.valid ? "Policy is valid." : "Policy has errors."];
    if (result.errors.length > 0) {
      lines.push("Errors:");
      for (const e of result.errors) lines.push(`  ${e.rule}: ${e.message}`);
    }
    if (result.warnings.length > 0) {
      lines.push("Warnings:");
      for (const w of result.warnings) lines.push(`  ${w.rule}: ${w.message}`);
    }
    return lines.join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdPolicyApply(args: ParsedArgs): Promise<number> {
  // "apply" = create a draft bundle from one or more policy JSON files (the
  // gateway's create endpoint) — multi-file composition's include
  // mechanics. Publishing is a separate step (`k9o policy publish <id>`).
  const format = resolveOutputFormat(args.flags);
  const name = args.flags["name"];
  if ((args.positional.length < 3 && args.flags["file"] === undefined) || name === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o policy apply requires <file> [<file> ...] (positional) and --name <name>",
      context: {},
      recommendation: "k9o policy apply policy.json --name 'my-policy'   (or: k9o policy apply a.json b.json --name 'my-policy')",
    }));
    return EXIT_USAGE;
  }
  const rules = loadPolicyDocument(args);
  const { client } = clientFromProfile(args);
  const envelope = await client.policies.create({ name, rules });
  emitSuccess(format, envelope, (b) =>
    `Created draft policy ${b.id} v${b.version} "${b.name}". Run \`k9o policy publish ${b.id}\` to activate.`,
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
  const envelope = await client.policies.publish(bundleId);
  emitSuccess(format, envelope, (b) =>
    `Published policy ${b.id} v${b.version} "${b.name}". Active on this project.`,
  );
  return EXIT_SUCCESS;
}
