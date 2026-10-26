/**
 * `k9o config` subcommands.
 *
 * Local-only — no API calls. Manages `~/.k9o/config.json` per-profile
 * settings (output format default, color preference, etc.). Credentials
 * are in a separate file (`~/.k9o/credentials`); this command does not
 * touch credentials.
 *
 *   - k9o config set <key> <value>   — set a key on the active profile
 *   - k9o config get <key>           — read a key
 *   - k9o config unset <key>         — clear a key
 *   - k9o config list                — list all keys for active profile
 *
 * Supported keys (closed set):
 *   - outputFormat: "human" | "json"   (default output format)
 *   - color: "true" | "false"           (default color preference)
 */

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import {
  readCredentials,
  readConfig,
  writeConfig,
  resolveActiveProfile,
  type ConfigFile,
} from "../config-store.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

const SUPPORTED_KEYS = new Set(["outputFormat", "color"]);

function getProfileSettings(cfg: ConfigFile, profileName: string): { outputFormat?: "human" | "json"; color?: boolean } {
  return cfg.profiles[profileName] ?? {};
}

function printConfigHelp(): void {
  process.stdout.write(`
k9o config — local CLI profile config (~/.k9o/config.json; not credentials)

USAGE
  k9o config <subcommand> [args...] [flags...]

SUBCOMMANDS
  set <key> <value>            Set a key on the active profile
  get <key>                    Read a key
  unset <key>                  Clear a key
  list                         List all keys for the active profile

SUPPORTED KEYS
  outputFormat   "human" | "json"   Default output format
  color          "true" | "false"   Default color preference
`.trim() + "\n");
}

export async function dispatchConfig(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printConfigHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "set") return cmdConfigSet(args);
    if (sub === "get") return cmdConfigGet(args);
    if (sub === "unset") return cmdConfigUnset(args);
    if (sub === "list") return cmdConfigList(args);
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unknown config subcommand "${sub}"`, context: { sub }, recommendation: "Valid: set | get | unset | list" }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

function cmdConfigSet(args: ParsedArgs): number {
  const format = resolveOutputFormat(args.flags);
  const key = args.positional[2];
  const value = args.positional[3];
  if (key === undefined || value === undefined) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o config set requires <key> <value>", context: {}, recommendation: `Supported keys: ${[...SUPPORTED_KEYS].join(", ")}` }));
    return EXIT_USAGE;
  }
  if (!SUPPORTED_KEYS.has(key)) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unsupported config key "${key}"`, context: { key }, recommendation: `Supported keys: ${[...SUPPORTED_KEYS].join(", ")}` }));
    return EXIT_USAGE;
  }
  const cfg = readConfig(args.flags["config"]);
  const creds = readCredentials(args.flags["credentials-file"]);
  const profileName = resolveActiveProfile(args.flags, creds);
  const settings = getProfileSettings(cfg, profileName);

  if (key === "outputFormat") {
    if (value !== "human" && value !== "json") {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `outputFormat must be "human" or "json"; got "${value}"`, context: { value } }));
      return EXIT_USAGE;
    }
    settings.outputFormat = value;
  } else if (key === "color") {
    if (value !== "true" && value !== "false") {
      emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `color must be "true" or "false"; got "${value}"`, context: { value } }));
      return EXIT_USAGE;
    }
    settings.color = value === "true";
  }

  cfg.profiles[profileName] = settings;
  writeConfig(cfg, args.flags["config"]);
  emitSuccess(format, { data: { profile: profileName, key, value }, meta: {} },
    (d) => `Set ${d.key}=${d.value} for profile "${d.profile}".`);
  return EXIT_SUCCESS;
}

function cmdConfigGet(args: ParsedArgs): number {
  const format = resolveOutputFormat(args.flags);
  const key = args.positional[2];
  if (key === undefined) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o config get requires <key>", context: {} }));
    return EXIT_USAGE;
  }
  if (!SUPPORTED_KEYS.has(key)) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unsupported config key "${key}"`, context: { key }, recommendation: `Supported keys: ${[...SUPPORTED_KEYS].join(", ")}` }));
    return EXIT_USAGE;
  }
  const cfg = readConfig(args.flags["config"]);
  const creds = readCredentials(args.flags["credentials-file"]);
  const profileName = resolveActiveProfile(args.flags, creds);
  const settings = getProfileSettings(cfg, profileName);
  const value = (settings as Record<string, unknown>)[key];
  emitSuccess(format, { data: { profile: profileName, key, value: value ?? null }, meta: {} },
    (d) => d.value === null ? `(unset)` : String(d.value));
  return EXIT_SUCCESS;
}

function cmdConfigUnset(args: ParsedArgs): number {
  const format = resolveOutputFormat(args.flags);
  const key = args.positional[2];
  if (key === undefined) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "k9o config unset requires <key>", context: {} }));
    return EXIT_USAGE;
  }
  if (!SUPPORTED_KEYS.has(key)) {
    emitError(format, new KError({ code: "K9O_INVALID_FIELD_VALUE", message: `unsupported config key "${key}"`, context: { key } }));
    return EXIT_USAGE;
  }
  const cfg = readConfig(args.flags["config"]);
  const creds = readCredentials(args.flags["credentials-file"]);
  const profileName = resolveActiveProfile(args.flags, creds);
  const settings = getProfileSettings(cfg, profileName);
  delete (settings as Record<string, unknown>)[key];
  cfg.profiles[profileName] = settings;
  writeConfig(cfg, args.flags["config"]);
  emitSuccess(format, { data: { profile: profileName, key, cleared: true }, meta: {} },
    (d) => `Cleared ${d.key} for profile "${d.profile}".`);
  return EXIT_SUCCESS;
}

function cmdConfigList(args: ParsedArgs): number {
  const format = resolveOutputFormat(args.flags);
  const cfg = readConfig(args.flags["config"]);
  const creds = readCredentials(args.flags["credentials-file"]);
  const profileName = resolveActiveProfile(args.flags, creds);
  const settings = getProfileSettings(cfg, profileName);
  emitSuccess(format, { data: { profile: profileName, settings }, meta: {} },
    (d) => {
      const entries = Object.entries(d.settings);
      if (entries.length === 0) return `Profile "${d.profile}": (no settings; all defaults)`;
      return [`Profile "${d.profile}":`, ...entries.map(([k, v]) => `  ${k.padEnd(20)} = ${v}`)].join("\n");
    });
  return EXIT_SUCCESS;
}
