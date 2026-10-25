/**
 * `k9o extension` subcommands — customer-side
 * extension lifecycle on a project (enable / disable / list / config).
 *
 * currently ships the SDK-resolvable surfaces; the underlying extension
 * runtime lifecycle endpoints (enable/disable/config persistence)
 * are gated on the gateway extensions-admin substrate.
 *
 * Wraps `@k9o/core` `client.extensions.extension(slug)` factory for
 * the typed-binding side; lifecycle ops route via per-project
 * `extensions-admin` gateway routes.
 */

import { KError, createClient } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

// The lifecycle endpoints are served by the gateway's extensions-admin
// routes (per `services/gateway/src/routes/extensions.ts`). The SDK
// doesn't expose typed `client.extensions.{enable,disable,list,config}`
// methods yet (gated on the extension build pipeline + the gateway routes shape stabilising);
// this CLI uses the bound HTTP client directly via the @k9o/core
// `createClient` factory + a raw request path. Once `client.extensions
// .admin.*` SDK methods ship, this CLI rewires to use them.

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
 * Use the bound profile to construct a temporary client + access its
 * config; the gateway extensions-admin endpoints are member-plane
 * (`/@<projectSlug>/extensions-admin/...`).
 */
function getBoundConfig(args: ParsedArgs) {
  const { client } = clientFromProfile(args);
  return client.config;
}

async function rawRequest<T>(args: ParsedArgs, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<{ data: T; meta: Record<string, unknown> }> {
  const config = getBoundConfig(args);
  // Reach for the @k9o/core http layer directly. This is a stop-gap until
  // SDK ships client.extensions.admin.*; intentional layering deviation
  // for the CLI surface.
  const { request } = await import("@k9o/core/http");
  return request(config, { method, path, body });
}

export async function cmdExtensionList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const config = getBoundConfig(args);
  if (config.projectSlug === undefined) {
    emitError(format, new KError({ code: "K9O_MISSING_PROJECT_CONTEXT", message: "k9o extension requires an active project", context: {}, recommendation: "k9o project set-active <slug>" }));
    return EXIT_USAGE;
  }
  type Ext = { slug: string; name: string; class: string; enabled: boolean; version: string };
  const env = await rawRequest<ReadonlyArray<Ext>>(args, "GET", `/@${config.projectSlug}/extensions-admin`);
  emitSuccess(format, env, (rows) => {
    if (rows.length === 0) return "No extensions installed on this project.";
    return ["Installed extensions:", ...rows.map((e) => `  ${e.slug.padEnd(30)}  ${e.class.padEnd(14)}  ${e.enabled ? "enabled " : "disabled"}  v${e.version}  ${e.name}`)].join("\n");
  });
  return EXIT_SUCCESS;
}

export async function cmdExtensionEnable(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.positional[2];
  if (slug === undefined) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o extension enable requires <slug>", context: {}, recommendation: "k9o extension enable paperless" }));
    return EXIT_USAGE;
  }
  const config = getBoundConfig(args);
  if (config.projectSlug === undefined) {
    emitError(format, new KError({ code: "K9O_MISSING_PROJECT_CONTEXT", message: "k9o extension enable requires an active project", context: {} }));
    return EXIT_USAGE;
  }
  const env = await rawRequest(args, "POST", `/@${config.projectSlug}/extensions-admin/${encodeURIComponent(slug)}/enable`);
  emitSuccess(format, env, () => `Enabled extension "${slug}" on project ${config.projectSlug}.`);
  return EXIT_SUCCESS;
}

export async function cmdExtensionDisable(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.positional[2];
  if (slug === undefined) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o extension disable requires <slug>", context: {} }));
    return EXIT_USAGE;
  }
  const config = getBoundConfig(args);
  if (config.projectSlug === undefined) {
    emitError(format, new KError({ code: "K9O_MISSING_PROJECT_CONTEXT", message: "k9o extension disable requires an active project", context: {} }));
    return EXIT_USAGE;
  }
  const env = await rawRequest(args, "POST", `/@${config.projectSlug}/extensions-admin/${encodeURIComponent(slug)}/disable`);
  emitSuccess(format, env, () => `Disabled extension "${slug}" on project ${config.projectSlug}.`);
  return EXIT_SUCCESS;
}

export async function cmdExtensionConfig(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.positional[2];
  if (slug === undefined) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o extension config requires <slug> + optional --set '<json>' or --get", context: {} }));
    return EXIT_USAGE;
  }
  const config = getBoundConfig(args);
  if (config.projectSlug === undefined) {
    emitError(format, new KError({ code: "K9O_MISSING_PROJECT_CONTEXT", message: "k9o extension config requires an active project", context: {} }));
    return EXIT_USAGE;
  }

  if (args.flags["set"] !== undefined) {
    let configBody: Record<string, unknown>;
    try {
      configBody = JSON.parse(args.flags["set"]);
    } catch {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "--set value is not valid JSON", context: {} }));
      return EXIT_USAGE;
    }
    const env = await rawRequest(args, "PATCH", `/@${config.projectSlug}/extensions-admin/${encodeURIComponent(slug)}/config`, configBody);
    emitSuccess(format, env, () => `Updated config for extension "${slug}".`);
    return EXIT_SUCCESS;
  }

  // Default: read current config
  const env = await rawRequest(args, "GET", `/@${config.projectSlug}/extensions-admin/${encodeURIComponent(slug)}/config`);
  emitSuccess(format, env);
  return EXIT_SUCCESS;
}
