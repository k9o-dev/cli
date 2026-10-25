/**
 * `k9o function` subcommands.
 *
 * deploy / list / get / invoke / delete.
 * Wave 3 (BLOCKED): logs (SSE / async-iterator — gated on the streaming
 * substrate; no `functions.logs` SDK method exists yet).
 *
 * `deploy` is a thin wrapper over `client.functions.deploy(input)`
 * /: it reads a deploy manifest (JSON) + a base64-encoded runtime
 * bundle into a `DeployFunctionInput` and emits the returned `FunctionRecord`.
 * Per deploy returns the row at `status: "deploying"`; the function
 * is invocable once it flips to `active` (poll `k9o function get <name>`).
 */

import { KError, type DeployFunctionInput, type FunctionRecord } from "@k9o/core";
import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

const VALID_RUNTIMES: ReadonlySet<DeployFunctionInput["runtime"]> = new Set(["wasm", "bun", "node"]);
const VALID_TIERS: ReadonlySet<NonNullable<DeployFunctionInput["tier"]>> = new Set(["low", "medium", "high"]);

function printFunctionHelp(): void {
  process.stdout.write(`
k9o function — deploy, invoke, and manage serverless functions

USAGE
  k9o function <subcommand> [args...] [flags...]

SUBCOMMANDS
  deploy <file>                 Deploy a function (--code-file <bundle>; --name/--runtime/--tier override)
                                 runtime: wasm | bun | node   tier: low | medium | high
  list                          List deployed functions
  get <name>                    Get a function by name
  invoke <name>                 Invoke a function (--payload JSON or --payload-file)
  delete <name>                 Retire a function
`.trim() + "\n");
}

export async function dispatchFunction(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printFunctionHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "deploy") return await cmdFunctionDeploy(args);
    if (sub === "list") return await cmdFunctionList(args);
    if (sub === "get") return await cmdFunctionGet(args);
    if (sub === "invoke") return await cmdFunctionInvoke(args);
    if (sub === "delete") return await cmdFunctionDelete(args);
    if (sub === "logs") {
      emitError(format, new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: "k9o function logs is not yet available — it requires the streaming substrate (no functions.logs SDK surface yet).",
        context: { sub },
        recommendation: "Track function status with `k9o function get <name>`; logs land once the streaming substrate ships.",
      }));
      return EXIT_USAGE;
    }
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown function subcommand "${sub}". (logs lands once the streaming substrate ships.)`,
      context: { sub },
      recommendation: "Valid: deploy | list | get | invoke | delete",
    }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

/**
 * Shape of the deploy manifest JSON consumed by `k9o function deploy`. All
 * fields are optional at the file level so individual fields can be supplied
 * (or overridden) by flags; the assembled `DeployFunctionInput` is validated
 * before the SDK call.
 */
type DeployManifest = {
  name?: unknown;
  runtime?: unknown;
  tier?: unknown;
  code?: unknown;
  config?: unknown;
};

async function cmdFunctionDeploy(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);

  // Manifest source: --manifest <file> (or positional <file>). The manifest
  // carries name/runtime/tier/config and may inline a base64 `code` bundle.
  const manifestPath = args.flags["manifest"] ?? args.positional[2];
  let manifest: DeployManifest = {};
  if (typeof manifestPath === "string") {
    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch (e) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `Failed to read --manifest file: ${e instanceof Error ? e.message : String(e)}`,
        context: { manifest: manifestPath },
        recommendation: "Pass a readable JSON manifest, e.g. k9o function deploy ./fn.json --code-file ./fn.wasm",
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `--manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        context: { manifest: manifestPath },
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: "--manifest must be a JSON object mapping deploy fields (name, runtime, tier, code, config).",
        context: { manifest: manifestPath },
      });
    }
    manifest = parsed as DeployManifest;
  }

  // Flags override manifest fields (CI overrides common-flag
  // precedence). --code-file reads a raw bundle and base64-encodes it,
  // taking precedence over any inline manifest `code`.
  const name = args.flags["name"] ?? (typeof manifest.name === "string" ? manifest.name : undefined);
  const runtime = args.flags["runtime"] ?? (typeof manifest.runtime === "string" ? manifest.runtime : undefined);
  const tier = args.flags["tier"] ?? (typeof manifest.tier === "string" ? manifest.tier : undefined);

  let code: string | undefined;
  if (typeof args.flags["code-file"] === "string") {
    try {
      code = readFileSync(args.flags["code-file"]).toString("base64");
    } catch (e) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `Failed to read --code-file: ${e instanceof Error ? e.message : String(e)}`,
        context: { codeFile: args.flags["code-file"] },
      });
    }
  } else if (typeof manifest.code === "string") {
    code = manifest.code;
  }

  // Validate the assembled input before the round-trip. Required: name,
  // runtime, code (the base64 bundle). tier is optional.
  if (name === undefined || name.length === 0) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o function deploy requires a function name (manifest `name` or --name)",
      context: {},
      recommendation: "k9o function deploy ./fn.json --code-file ./fn.wasm  OR  --name my-fn --runtime wasm --code-file ./fn.wasm",
    }));
    return EXIT_USAGE;
  }
  if (runtime === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o function deploy requires a runtime (manifest `runtime` or --runtime)",
      context: { name },
      recommendation: `Valid runtimes: ${[...VALID_RUNTIMES].join(" | ")}`,
    }));
    return EXIT_USAGE;
  }
  if (!VALID_RUNTIMES.has(runtime as DeployFunctionInput["runtime"])) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `invalid runtime "${runtime}"`,
      context: { name, runtime },
      recommendation: `Valid runtimes: ${[...VALID_RUNTIMES].join(" | ")}`,
    }));
    return EXIT_USAGE;
  }
  if (tier !== undefined && !VALID_TIERS.has(tier as NonNullable<DeployFunctionInput["tier"]>)) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `invalid tier "${tier}"`,
      context: { name, tier },
      recommendation: `Valid tiers: ${[...VALID_TIERS].join(" | ")}`,
    }));
    return EXIT_USAGE;
  }
  if (code === undefined || code.length === 0) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o function deploy requires a runtime bundle (--code-file <path>, or base64 `code` in the manifest)",
      context: { name },
      recommendation: "k9o function deploy ./fn.json --code-file ./fn.wasm",
    }));
    return EXIT_USAGE;
  }
  if (manifest.config !== undefined && (typeof manifest.config !== "object" || manifest.config === null || Array.isArray(manifest.config))) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "manifest `config` must be a JSON object",
      context: { name },
    }));
    return EXIT_USAGE;
  }

  const input: DeployFunctionInput = {
    name,
    runtime: runtime as DeployFunctionInput["runtime"],
    code,
    ...(tier !== undefined ? { tier: tier as NonNullable<DeployFunctionInput["tier"]> } : {}),
    ...(manifest.config !== undefined ? { config: manifest.config as Record<string, unknown> } : {}),
  };

  const { client } = clientFromProfile(args);
  const envelope = await client.functions.deploy(input);
  emitSuccess(format, envelope, (f: FunctionRecord) => {
    const head = `Function ${f.name} (${f.id}) — runtime=${f.runtime} tier=${f.tier} status=${f.status}`;
    return f.status === "active"
      ? head
      : `${head}\n  Deployment in progress. Poll with: k9o function get ${f.name}`;
  });
  return EXIT_SUCCESS;
}

async function cmdFunctionList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const envelope = await client.functions.list();
  emitSuccess(format, envelope, (fns) => {
    if (fns.length === 0) return "No functions deployed.";
    const rows = fns.map((f) =>
      `  ${f.name.padEnd(30)}  ${f.runtime.padEnd(6)}  ${f.tier.padEnd(8)}  ${f.status.padEnd(10)}  ${f.id}`,
    );
    return ["Functions:", ...rows].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdFunctionGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = args.positional[2];
  if (name === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o function get requires <name> (positional)",
      context: {},
      recommendation: "k9o function get my-fn",
    }));
    return EXIT_USAGE;
  }
  const { client } = clientFromProfile(args);
  const envelope = await client.functions.get(name);
  emitSuccess(format, envelope, (f) =>
    `Function ${f.name} (${f.id})\n  runtime: ${f.runtime}\n  status: ${f.status}\n  tier: ${f.tier}\n  created: ${f.createdAt}`,
  );
  return EXIT_SUCCESS;
}

async function cmdFunctionInvoke(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = args.positional[2];
  if (name === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o function invoke requires <name> (positional)",
      context: {},
      recommendation: "k9o function invoke my-fn --payload '{\"x\":1}' OR --payload-file payload.json",
    }));
    return EXIT_USAGE;
  }
  let payload: unknown = {};
  if (typeof args.flags["payload"] === "string") {
    try {
      payload = JSON.parse(args.flags["payload"]);
    } catch (e) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `--payload value is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        context: { payload: args.flags["payload"] },
      });
    }
  } else if (typeof args.flags["payload-file"] === "string") {
    try {
      payload = JSON.parse(readFileSync(args.flags["payload-file"], "utf8"));
    } catch (e) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `Failed to read --payload-file: ${e instanceof Error ? e.message : String(e)}`,
        context: { file: args.flags["payload-file"] },
      });
    }
  }
  const { client } = clientFromProfile(args);
  const envelope = await client.functions.invoke(name, payload);
  emitSuccess(format, envelope);
  return EXIT_SUCCESS;
}

async function cmdFunctionDelete(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const name = args.positional[2];
  if (name === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o function delete requires <name> (positional)",
      context: {},
      recommendation: "k9o function delete my-fn",
    }));
    return EXIT_USAGE;
  }
  const { client } = clientFromProfile(args);
  const envelope = await client.functions.delete(name);
  emitSuccess(format, envelope, (d) =>
    `Function "${name}" retired. Name re-use cooldown until ${d.cooldownUntil}.`,
  );
  return EXIT_SUCCESS;
}
