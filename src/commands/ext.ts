/**
 * `k9o ext <slug> <verb>` — dynamic per-extension command dispatch (one-binary
 * design). Resolves the extension's declared CLI surface (manifest
 * `surfaces.cli[]`, synced from `GET /@<projectSlug>/extensions`) and invokes the
 * matched `(method, path)` against the extension's `runtime_api`.
 *
 * Alias `extension` → `ext` (index.ts). `admin` is a RESERVED slug: `k9o ext
 * admin …` points the user at `k9o ext-admin` rather than treating "admin" as
 * an extension.
 *
 * Step-1 status: the `surfaces.cli` sync endpoint (`GET
 * /@<projectSlug>/extensions` exposing `surfaces.cli[]`) is not yet live, so
 * resolution is gated — a typed, CLI-local error is emitted until the manifest
 * sync lands. The slug/verb parsing, reserved-slug guard, and dispatch skeleton
 * are built to.
 */

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { emitError, resolveOutputFormat, type OutputFormat } from "../output.ts";
import { EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

/** Names that are NOT extensions — they collide with the management tree. */
const RESERVED_SLUGS = new Set(["admin"]);

export async function dispatchExt(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.positional[1];

  if (slug === undefined || args.flags["help"] === "true") {
    printExtHelp();
    return slug === undefined ? EXIT_USAGE : 0;
  }

  // Reserved-slug / root guard: `ext admin` is the management tree, not an extension.
  if (RESERVED_SLUGS.has(slug)) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `"${slug}" is a reserved name, not an extension`,
      context: { slug },
      recommendation: "For extension management use `k9o ext-admin`.",
    }));
    return EXIT_USAGE;
  }

  const verb = args.positional[2];
  if (verb === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `k9o ext ${slug} requires a verb`,
      context: { slug },
      recommendation: `k9o ext ${slug} --help`,
    }));
    return EXIT_USAGE;
  }

  try {
    return await invokeExtensionVerb(args, slug, verb, format);
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

/**
 * Resolve the extension's CLI surface + invoke the matched verb. Gated until the
 * gateway's `surfaces.cli` sync (`GET /@<projectSlug>/extensions`) is
 * live; emits a typed, CLI-local not-yet-available error meanwhile.
 */
async function invokeExtensionVerb(_args: ParsedArgs, slug: string, verb: string, format: OutputFormat): Promise<number> {
  emitError(format, new KError({
    code: "CLI_EXT_SURFACES_UNAVAILABLE",
    message: `extension command surfaces are not yet available (cannot resolve "k9o ext ${slug} ${verb}")`,
    context: { slug, verb },
    recommendation: "Per-extension CLI commands require the project's synced extension surfaces (gateway surfaces.cli endpoint). Use `k9o ext-admin` for management in the meantime.",
  }));
  return EXIT_USAGE;
}

function printExtHelp(): void {
  process.stdout.write(`
k9o ext — run a specific extension's commands

USAGE
  k9o ext <slug> <verb> [args...] [flags...]

  Each installed extension declares its own commands (manifest surfaces.cli).
  Run \`k9o ext-admin list\` to see installed extensions, then
  \`k9o ext <slug> --help\` for a given extension's verbs.

  Alias: \`k9o extension <slug> <verb>\` is an alias for \`k9o ext <slug> <verb>\`.
  For platform-side management (install / enable / publish / …) use \`k9o ext-admin\`.
`.trim() + "\n");
}
