/**
 * Extension lifecycle on a project: list / enable / disable / config.
 *
 * These call the gateway's per-project `extensions-admin` routes through
 * `@k9o/core`'s request layer (the SDK has no typed methods for them):
 *
 *   list     GET    /@{project}/extensions-admin
 *   enable   POST   /@{project}/extensions-admin/{slug}/enable
 *   disable  DELETE /@{project}/extensions-admin/{slug}/disable
 *   config   GET    /@{project}/extensions-admin/{slug}   (reads `config`)
 *            PATCH  /@{project}/extensions-admin/{slug}/config   (merges the object)
 */

import { KError } from "@k9o/core";
import { request } from "@k9o/core/http";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import type { WireInstalledExtension } from "../wire.ts";

export async function dispatchExtension(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o extension requires a subcommand: list | enable | disable | config",
      context: {},
      recommendation: "k9o extension list",
    }));
    return EXIT_USAGE;
  }
  try {
    if (sub === "list") return await cmdExtensionList(args);
    if (sub === "enable") return await cmdExtensionEnable(args);
    if (sub === "disable") return await cmdExtensionDisable(args);
    if (sub === "config") return await cmdExtensionConfig(args);
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown extension subcommand "${sub}"`, context: { sub }, recommendation: "Valid: list | enable | disable | config" }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

/**
 * The bound client config. The gateway extensions-admin endpoints are
 * member-plane (`/@<projectSlug>/extensions-admin/...`).
 */
function getBoundConfig(args: ParsedArgs) {
  const { client } = clientFromProfile(args);
  return client.config;
}

async function rawRequest<T>(args: ParsedArgs, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<{ data: T; meta: Record<string, unknown> }> {
  return request<T>(getBoundConfig(args), { method, path, body });
}

function needProject(format: ReturnType<typeof resolveOutputFormat>, projectSlug: string | undefined, verb: string): string | null {
  if (projectSlug !== undefined) return projectSlug;
  emitError(format, new KError({
    code: "K9O_MISSING_PROJECT_CONTEXT",
    message: `k9o ext-admin ${verb} requires an active project`,
    context: {},
    recommendation: "k9o project set-active <slug>   (or pass --project <slug>)",
  }));
  return null;
}

export async function cmdExtensionList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const project = needProject(format, getBoundConfig(args).projectSlug, "list");
  if (project === null) return EXIT_USAGE;
  const env = await rawRequest<ReadonlyArray<WireInstalledExtension>>(args, "GET", `/@${project}/extensions-admin`);
  emitSuccess(format, env, (rows) => {
    if (rows.length === 0) return "No extensions installed on this project.";
    return ["Installed extensions:", ...rows.map((e) =>
      `  ${e.extensionSlug.padEnd(30)}  ${e.status.padEnd(9)}  v${e.manifestVersion}${e.updateAvailable ? `  (update available: v${e.latestVersion})` : ""}`,
    )].join("\n");
  });
  return EXIT_SUCCESS;
}

export async function cmdExtensionEnable(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.positional[2];
  if (slug === undefined) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o ext-admin enable requires <slug>", context: {}, recommendation: "k9o ext-admin enable paperless" }));
    return EXIT_USAGE;
  }
  const project = needProject(format, getBoundConfig(args).projectSlug, "enable");
  if (project === null) return EXIT_USAGE;
  const env = await rawRequest<{ hookSecret?: string | null }>(args, "POST", `/@${project}/extensions-admin/${encodeURIComponent(slug)}/enable`);
  emitSuccess(format, env, (d) =>
    `Enabled extension "${slug}" on project ${project}.` +
    (d?.hookSecret ? "\n  The extension's hook secret is shown once; run again with --output json to capture it." : ""),
  );
  return EXIT_SUCCESS;
}

export async function cmdExtensionDisable(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.positional[2];
  if (slug === undefined) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o ext-admin disable requires <slug>", context: {} }));
    return EXIT_USAGE;
  }
  const project = needProject(format, getBoundConfig(args).projectSlug, "disable");
  if (project === null) return EXIT_USAGE;
  const env = await rawRequest(args, "DELETE", `/@${project}/extensions-admin/${encodeURIComponent(slug)}/disable`);
  emitSuccess(format, env, () => `Disabled extension "${slug}" on project ${project}.`);
  return EXIT_SUCCESS;
}

export async function cmdExtensionConfig(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.positional[2];
  if (slug === undefined) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o ext-admin config requires <slug> + optional --set '<json>' (omit to read)", context: {} }));
    return EXIT_USAGE;
  }
  const project = needProject(format, getBoundConfig(args).projectSlug, "config");
  if (project === null) return EXIT_USAGE;

  if (args.flags["set"] !== undefined) {
    let configBody: Record<string, unknown>;
    try {
      configBody = JSON.parse(args.flags["set"]);
    } catch {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "--set value is not valid JSON", context: {} }));
      return EXIT_USAGE;
    }
    if (typeof configBody !== "object" || configBody === null || Array.isArray(configBody)) {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "--set must be a JSON object (its keys are merged into the extension's config)", context: {} }));
      return EXIT_USAGE;
    }
    const env = await rawRequest(args, "PATCH", `/@${project}/extensions-admin/${encodeURIComponent(slug)}/config`, configBody);
    emitSuccess(format, env, () => `Updated config for extension "${slug}".`);
    return EXIT_SUCCESS;
  }

  // Default: read the current config (carried on the extension's detail).
  const env = await rawRequest<WireInstalledExtension>(args, "GET", `/@${project}/extensions-admin/${encodeURIComponent(slug)}`);
  emitSuccess(format, { data: env.data.config ?? {}, meta: env.meta }, (cfg) => JSON.stringify(cfg, null, 2));
  return EXIT_SUCCESS;
}
