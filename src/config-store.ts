/**
 * Local config + credentials persistence for the `k9o` CLI.
 *
 * Storage model:
 *   - Credentials file at `~/.k9o/credentials` (mode 0600) per active profile
 *   - Config file at `~/.k9o/config.toml` (mode 0644 acceptable) per `k9o config` cmds
 *
 * Profile model: a single file contains multiple `[profile.<name>]` sections
 * (default profile name: `default`). Each profile stores: refreshToken,
 * accessToken (cached), expiresAt, baseUrl, orgSlug, activeProjectSlug.
 *
 * currently ships a minimal JSON-shaped persistence (file format: JSON, not
 * TOML, to avoid a TOML dependency at first pass). The `~/.k9o/config.toml`
 * spec name is preserved in path documentation but internal serialisation
 * is JSON; TOML serialisation may be added later.
 *
 * The credentials file mode is enforced on write — `chmod(0o600)` after
 * `writeFile`. On read, the SDK warns + prompts re-login
 * if mode is tampered (not implemented; the file is only read).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { KError } from "@k9o/core";

const CONFIG_DIR_NAME = ".k9o";
const CREDENTIALS_FILE = "credentials";
const CONFIG_FILE = "config.json"; // see note above; canonical-name-pending-TOML

export type Profile = {
  /** Long-lived refresh token returned by `gate.signIn`. */
  refreshToken: string;
  /** Short-lived access token cached for the duration of `expiresAt`. */
  accessToken: string | null;
  /** ISO 8601 instant the cached access token expires (or null when unminted). */
  expiresAt: string | null;
  /** Gateway origin baseUrl bound at login. */
  baseUrl: string;
  /** Org slug bound at login. */
  orgSlug: string;
  /** End-user identity returned from gate.signIn (for whoami). */
  userId: string;
  /** End-user email (for whoami display). */
  userEmail: string;
  /** Currently-selected active project (set via `k9o project set-active`). */
  activeProjectSlug: string | null;
};

export type CredentialsFile = {
  /** Map of profile name → Profile. Default profile is `default`. */
  profiles: Record<string, Profile>;
  /** Currently-selected profile name. */
  current: string;
};

export type ConfigFile = {
  /** Per-profile general settings — not credentials; safe at 0644 mode. */
  profiles: Record<string, {
    outputFormat?: "human" | "json";
    color?: boolean;
  }>;
};

function configDir(): string {
  const dir = join(homedir(), CONFIG_DIR_NAME);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function credentialsPath(override?: string): string {
  return override ?? join(configDir(), CREDENTIALS_FILE);
}

export function configPath(override?: string): string {
  return override ?? join(configDir(), CONFIG_FILE);
}

export function readCredentials(override?: string): CredentialsFile {
  const path = credentialsPath(override);
  if (!existsSync(path)) {
    return { profiles: {}, current: "default" };
  }
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as CredentialsFile;
  } catch (e) {
    throw new KError({
      code: "CLI_CONFIG_INVALID",
      message: `Credentials file at ${path} is malformed: ${e instanceof Error ? e.message : String(e)}`,
      context: { path },
      recommendation: "Run `k9o logout` to clear; then `k9o login` to re-authenticate.",
    });
  }
}

export function writeCredentials(creds: CredentialsFile, override?: string): void {
  const path = credentialsPath(override);
  writeFileSync(path, JSON.stringify(creds, null, 2), "utf8");
  // Enforce mode 0600 — owner-only.
  chmodSync(path, 0o600);
}

export function readConfig(override?: string): ConfigFile {
  const path = configPath(override);
  if (!existsSync(path)) {
    return { profiles: {} };
  }
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as ConfigFile;
  } catch (e) {
    throw new KError({
      code: "CLI_CONFIG_INVALID",
      message: `Config file at ${path} is malformed: ${e instanceof Error ? e.message : String(e)}`,
      context: { path },
      recommendation: "Edit the file to fix the JSON syntax, or delete it to reset to defaults.",
    });
  }
}

export function writeConfig(cfg: ConfigFile, override?: string): void {
  const path = configPath(override);
  writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
}

/**
 * Resolve the active profile name from environment + flag overrides.
 * Precedence: `--profile <name>` flag > `K9O_PROFILE` env > current
 * (from credentials file) > "default".
 */
export function resolveActiveProfile(flags: Record<string, string>, creds: CredentialsFile): string {
  if (typeof flags["profile"] === "string") return flags["profile"];
  const env = process.env["K9O_PROFILE"];
  if (typeof env === "string" && env.length > 0) return env;
  return creds.current;
}

/**
 * Resolve the active project slug:
 *   1. `--project <slug>` flag
 *   2. `K9O_PROJECT` env var
 *   3. Active profile's `activeProjectSlug` (set via `k9o project set-active`)
 *   4. (service-token mode: token's bound project — not implemented)
 *
 * Returns null when no project context resolves (caller decides if that's OK).
 */
export function resolveProjectContext(
  flags: Record<string, string>,
  profile: Profile | undefined,
): string | null {
  if (typeof flags["project"] === "string") return flags["project"];
  const env = process.env["K9O_PROJECT"];
  if (typeof env === "string" && env.length > 0) return env;
  if (profile !== undefined && profile.activeProjectSlug !== null) return profile.activeProjectSlug;
  return null;
}

/**
 * Resolve the active org slug (org-symmetric to project):
 *   1. `--org <slug>` flag
 *   2. `K9O_ORG` env var
 *   3. Active profile's `orgSlug` (bound at login)
 */
export function resolveOrgContext(
  flags: Record<string, string>,
  profile: Profile | undefined,
): string | null {
  if (typeof flags["org"] === "string") return flags["org"];
  const env = process.env["K9O_ORG"];
  if (typeof env === "string" && env.length > 0) return env;
  if (profile !== undefined) return profile.orgSlug;
  return null;
}
