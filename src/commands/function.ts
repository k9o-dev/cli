/**
 * `k9o function` subcommands.
 *
 * deploy / list / get / invoke / delete.
 *
 * `deploy` is two calls: it uploads the build artifact
 * (`client.functions.uploadArtifact`, which returns a content-addressed
 * `artifactKey`), then registers the function
 * (`client.functions.deploy({ name, runtime, tier, artifactKey, version })`).
 * The gateway tier takes a `.wasm` artifact; the sandbox tier takes a `.tar`.
 * Deploy returns the row at `status: "deploying"`; the function is invocable
 * once it flips to `active` (poll `k9o function get <name>`).
 */

import { KError, type DeployFunctionInput } from "@k9o/core";
import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import type { WireFunction } from "../wire.ts";

type Runtime = DeployFunctionInput["runtime"];
type Tier = DeployFunctionInput["tier"];

const VALID_RUNTIMES: ReadonlySet<Runtime> = new Set<Runtime>([
  "bun", "python", "go", "java", "kotlin", "dotnet", "swift", "php", "ruby", "rust", "tinygo", "zig", "assemblyscript",
]);
const VALID_TIERS: ReadonlySet<Tier> = new Set<Tier>(["gateway", "sandbox"]);

function printFunctionHelp(): void {
  process.stdout.write(`
k9o function — deploy, invoke, and manage serverless functions

USAGE
  k9o function <subcommand> [args...] [flags...]

SUBCOMMANDS
  deploy [<manifest.json>]      Upload an artifact and deploy a function
                                 --name <name> --runtime <runtime> --tier gateway|sandbox
                                 --version <label> --artifact <file>   (uploads the file)
                                 or --artifact-key <key>               (already uploaded)
                                 [--description <text>]
                                 Flags override the same fields in the manifest.
  list                          List deployed functions
  get <name>                    Get a function by name
  invoke <name>                 Invoke a function (--payload JSON or --payload-file)
  delete <name>                 Retire a function

DEPLOY NOTES
  runtime: bun | python | go | java | kotlin | dotnet | swift | php | ruby | rust | tinygo | zig | assemblyscript
  tier gateway takes a .wasm artifact and is restricted to platform operators;
  tier sandbox takes a .tar artifact. Not every runtime runs on every tier.
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
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown function subcommand "${sub}"`,
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
 * Shape of the optional deploy manifest JSON. Every field is optional at the
 * file level so individual fields can come from flags (flags win); the
 * assembled input is validated before any request is made.
 */
type DeployManifest = {
  name?: unknown;
  runtime?: unknown;
  tier?: unknown;
  version?: unknown;
  description?: unknown;
  artifactKey?: unknown;
  artifact?: unknown;
};

function usage(format: ReturnType<typeof resolveOutputFormat>, message: string, recommendation?: string): number {
  emitError(format, new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message,
    context: {},
    ...(recommendation !== undefined ? { recommendation } : {}),
  }));
  return EXIT_USAGE;
}

async function cmdFunctionDeploy(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);

  const manifestPath = args.flags["manifest"] ?? args.positional[2];
  let manifest: DeployManifest = {};
  if (typeof manifestPath === "string") {
    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch (e) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `Failed to read manifest: ${e instanceof Error ? e.message : String(e)}`,
        context: { manifest: manifestPath },
        recommendation: "Pass a readable JSON manifest, e.g. k9o function deploy ./fn.json",
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        context: { manifest: manifestPath },
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: "manifest must be a JSON object with name, runtime, tier, version and artifact or artifactKey.",
        context: { manifest: manifestPath },
      });
    }
    manifest = parsed as DeployManifest;
  }

  const str = (flag: string, field: unknown): string | undefined =>
    args.flags[flag] ?? (typeof field === "string" ? field : undefined);
  const name = str("name", manifest.name);
  const runtime = str("runtime", manifest.runtime);
  const tier = str("tier", manifest.tier);
  const version = str("version", manifest.version);
  const description = str("description", manifest.description);
  const artifactFile = str("artifact", manifest.artifact);
  let artifactKey = str("artifact-key", manifest.artifactKey);

  const example = "k9o function deploy --name my-fn --runtime go --tier sandbox --version 1 --artifact ./fn.tar";
  if (name === undefined || name.length === 0) return usage(format, "k9o function deploy requires a name (manifest `name` or --name)", example);
  if (runtime === undefined) return usage(format, "k9o function deploy requires a runtime (manifest `runtime` or --runtime)", `Valid runtimes: ${[...VALID_RUNTIMES].join(" | ")}`);
  if (!VALID_RUNTIMES.has(runtime as Runtime)) return usage(format, `invalid runtime "${runtime}"`, `Valid runtimes: ${[...VALID_RUNTIMES].join(" | ")}`);
  if (tier === undefined) return usage(format, "k9o function deploy requires a tier (manifest `tier` or --tier)", `Valid tiers: ${[...VALID_TIERS].join(" | ")}`);
  if (!VALID_TIERS.has(tier as Tier)) return usage(format, `invalid tier "${tier}"`, `Valid tiers: ${[...VALID_TIERS].join(" | ")}`);
  if (version === undefined || version.length === 0) return usage(format, "k9o function deploy requires a version label (manifest `version` or --version)", example);
  if (artifactFile === undefined && artifactKey === undefined) {
    return usage(format, "k9o function deploy requires an artifact: --artifact <file> to upload one, or --artifact-key <key> for one already uploaded", example);
  }
  if (artifactFile !== undefined && artifactKey !== undefined) {
    return usage(format, "pass either --artifact <file> or --artifact-key <key>, not both");
  }

  const { client } = clientFromProfile(args);

  if (artifactFile !== undefined) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(artifactFile);
    } catch (e) {
      throw new KError({
        code: "K9O_INVALID_FIELD_VALUE",
        message: `Failed to read --artifact: ${e instanceof Error ? e.message : String(e)}`,
        context: { artifact: artifactFile },
      });
    }
    // The tier decides the artifact kind: gateway = wasm, sandbox = tar.
    const uploaded = await client.functions.uploadArtifact(bytes, tier === "gateway" ? "wasm" : "tar");
    artifactKey = uploaded.data.artifactKey;
  }

  const input: DeployFunctionInput = {
    name,
    runtime: runtime as Runtime,
    tier: tier as Tier,
    artifactKey: artifactKey!,
    version,
    ...(description !== undefined ? { description } : {}),
  };
  const envelope = await client.functions.deploy(input);
  emitSuccess(format, envelope, (f) => {
    const w = f as unknown as WireFunction;
    const head = `Function ${w.name} (${w.id}) — runtime=${w.runtime} tier=${w.tier} status=${w.status}`;
    return w.status === "active"
      ? head
      : `${head}\n  Deployment in progress. Poll with: k9o function get ${w.name}`;
  });
  return EXIT_SUCCESS;
}

async function cmdFunctionList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const envelope = await client.functions.list();
  emitSuccess(format, envelope, (fns) => {
    if (fns.length === 0) return "No functions deployed.";
    const rows = (fns as unknown as ReadonlyArray<WireFunction>).map((f) =>
      `  ${f.name.padEnd(30)}  ${String(f.runtime ?? "-").padEnd(14)}  ${String(f.tier ?? "-").padEnd(8)}  ${String(f.status ?? "-").padEnd(10)}  ${f.id}`,
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
  emitSuccess(format, envelope, (rec) => {
    const f = rec as unknown as WireFunction;
    return `Function ${f.name} (${f.id})\n  runtime: ${f.runtime}\n  status: ${f.status}\n  tier: ${f.tier}\n  created: ${f.createdAt}`;
  });
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
  emitSuccess(format, envelope, (rec) => {
    const retiredAt = (rec as unknown as { retiredAt?: string | null }).retiredAt;
    return retiredAt
      ? `Function "${name}" retired at ${retiredAt}. The name can be reused 24 hours after that.`
      : `Function "${name}" retired. The name can be reused after a 24 hour cooldown.`;
  });
  return EXIT_SUCCESS;
}
