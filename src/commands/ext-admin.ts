/**
 * `k9o ext-admin` — extension management tree (one-binary design). The `k9o` binary owns this tree; two verb
 * sources merge into one surface:
 *
 *   - Native "Use" verbs: list | available | enable | disable | config
 *   - Registered "Publish & operate" verbs (extension toolchain): publish | install |
 *     deprecate | metrics | status | logs — `@k9o/extension-cli` exports them as
 *     `EXT_ADMIN_VERBS: ExtAdminVerb[]` (built against `ext-admin-contract.ts`),
 *     merged here through an `ExtAdminCtx` so they behave identically to natives.
 *
 * Alias `extension-admin` → `ext-admin` (index.ts). The dynamic per-extension
 * surface is the sibling `k9o ext <slug> <verb>` (commands/ext.ts).
 */

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat, type OutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { cmdExtensionList, cmdExtensionEnable, cmdExtensionDisable, cmdExtensionConfig } from "./extension.ts";
import type { ExtAdminVerb, ExtAdminCtx } from "../ext-admin-contract.ts";

const NATIVE_VERBS = ["list", "available", "enable", "disable", "config"] as const;

/**
 * The `@k9o/extension-cli` toolchain is an OPTIONAL runtime dependency — present only
 * when the publisher toolchain is installed. The specifier is assembled at
 * runtime so the bundler does not hard-resolve it; absence → native verbs only.
 */
async function loadRegisteredVerbs(): Promise<ExtAdminVerb[]> {
  const pkg = ["@k9o", "extension-cli"].join("/");
  try {
    const mod = (await import(pkg)) as { EXT_ADMIN_VERBS?: ExtAdminVerb[] };
    return Array.isArray(mod.EXT_ADMIN_VERBS) ? mod.EXT_ADMIN_VERBS : [];
  } catch {
    return [];
  }
}

export async function dispatchExtAdmin(args: ParsedArgs): Promise<number> {
  const verb = args.positional[1];
  const format = resolveOutputFormat(args.flags);

  if (verb === undefined || args.flags["help"] === "true") {
    printExtAdminHelp();
    return verb === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }

  try {
    // Native "Use" verbs. Positionals align with the old
    // `extension <verb> <slug>` form, so the proven implementations are reused.
    if (verb === "list") return await cmdExtensionList(args);
    if (verb === "enable") return await cmdExtensionEnable(args);
    if (verb === "disable") return await cmdExtensionDisable(args);
    if (verb === "config") return await cmdExtensionConfig(args);
    if (verb === "available") return await cmdExtAdminAvailable(args);

    // Registered "Publish & operate" verbs (extension toolchain), if the toolchain is present.
    const registered = await loadRegisteredVerbs();
    const match = registered.find((v) => v.verb === verb);
    if (match) return await runRegisteredVerb(match, args, format);

    const known = [...NATIVE_VERBS, ...registered.map((v) => v.verb)];
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown ext-admin verb "${verb}"`,
      context: { verb, known },
      recommendation: `Valid verbs: ${known.join(" | ")}`,
    }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

/**
 * `available` — list extensions installable into a project (the marketplace
 * listing). The customer-facing marketplace endpoint for the CLI is a
 * gateway surface not yet available; this is gated with a CLI-local
 * sentinel rather than guessing a path (no fabricated endpoints).
 */
async function cmdExtAdminAvailable(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  emitError(format, new KError({
    code: "CLI_EXT_MARKETPLACE_UNAVAILABLE",
    message: "`k9o ext-admin available` is not yet wired — the extension marketplace listing endpoint is pending.",
    context: {},
    recommendation: "Use `k9o ext-admin list` for extensions already installed on the active project.",
  }));
  return EXIT_USAGE;
}

/** Build the `ExtAdminCtx` and run a toolchain-registered verb. */
async function runRegisteredVerb(verb: ExtAdminVerb, args: ParsedArgs, format: OutputFormat): Promise<number> {
  const { client, profile } = clientFromProfile(args);
  const config = client.config;
  const token = profile.accessToken ?? profile.refreshToken;

  const authFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };

  const ctx: ExtAdminCtx = {
    args,
    positionals: args.positional.slice(2),
    context: { baseUrl: config.baseUrl, orgSlug: config.orgSlug, projectSlug: config.projectSlug },
    fetchFn: authFetch as typeof fetch,
    format,
    emitSuccess: (envelope, render) => emitSuccess(format, envelope, render),
    emitError: (error) => emitError(format, error),
    exitCodeForError,
  };
  return verb.run(ctx);
}

function printExtAdminHelp(): void {
  process.stdout.write(`
k9o ext-admin — manage extensions on the active project

USAGE
  k9o ext-admin <verb> [args...] [flags...]

USE
  list                                  List extensions installed on the active project
  available                             List extensions available to install (marketplace)
  enable <slug>                         Enable an installed extension
  disable <slug>                        Disable an installed extension
  config <slug> [--set <json> | --get]  Read or update an extension's config

PUBLISH & OPERATE  (requires the @k9o/extension-cli publisher toolchain)
  publish | install | deprecate | metrics | status | logs

  Alias: \`k9o extension-admin\` is an alias for \`k9o ext-admin\`.
  Per-extension commands live under \`k9o ext <slug> <verb>\`.
`.trim() + "\n");
}
