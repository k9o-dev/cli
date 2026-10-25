/**
 * `k9o login` / `k9o logout` / `k9o whoami`.
 *
 * Auth flow:
 *   - `login` — Reads email + password from prompts (or env vars for
 *     scripted contexts), calls `client.gate.signIn`, persists refreshToken
 *     into the credentials file at `~/.k9o/credentials` mode 0600.
 *   - `logout` — Clears the active profile from the credentials file.
 *   - `whoami` — Prints the active profile's user + org + active project.
 *
 * Browser-based device-authorisation sign-in is not available yet; the CLI
 * ships the email/password flow, which composes with
 * `client.gate.signIn`.
 *
 * For CI / automation, callers should use service-token mode
 * (`K9O_SERVICE_TOKEN` env var) — not implemented in `client.gate` yet;
 * the gateway supports it.
 *
 * CWI-mode: the auth-path SHAPE is
 * built here (flag/env recognition, `wl_<base62>` id format,
 * `identifier`-profile tag validation) — the actual
 * mint/DPoP wire mechanics are NOT, because they are genuinely
 * unspecified upstream (/: claim set, PoP-keypair
 * lifecycle, and nonce-retry chaining are not yet ruled). Selecting
 * CWI-mode today fails fast with a clear "ruled, not yet operable"
 * error rather than silently falling through to "run k9o login".
 */

import { createClient, resolveBaseUrl, KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import {
  readCredentials,
  writeCredentials,
  resolveActiveProfile,
  resolveProjectContext,
  resolveOrgContext,
} from "../config-store.ts";
import { emitSuccess, emitError, resolveOutputFormat, type OutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_AUTH, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

/**
 * `identifier` profile — strict ASCII, ≤63 chars. Used here for
 * `--workload-tag` / `K9O_WORKLOAD_TAG`: a self-asserted,
 * correlation-only string, never a security discriminator. The regex is
 * ASCII-only by construction, so it inherently rejects every category
 * requires rejected (Cc/Cf/Cs/Co/Cn/Zl/Zp) — no separate Unicode
 * category check is needed on top of it.
 */
const IDENTIFIER_PROFILE_PATTERN = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
const IDENTIFIER_PROFILE_MAX_LENGTH = 63;

/** `wl_<base62>` Workload id shape. */
const WORKLOAD_ID_PATTERN = /^wl_[0-9A-Za-z]+$/;

/**
 * Validate a `--workload-tag` / `K9O_WORKLOAD_TAG` value against the
 * `identifier` profile. Reject-don't-sanitize — an
 * invalid tag is a hard error, never silently truncated or stripped.
 */
export function validateWorkloadTag(tag: string): void {
  if (tag.length === 0 || tag.length > IDENTIFIER_PROFILE_MAX_LENGTH || !IDENTIFIER_PROFILE_PATTERN.test(tag)) {
    throw new KError({
      code: "K9O_INVALID_CHARACTER",
      message: `--workload-tag / K9O_WORKLOAD_TAG must be lowercase ASCII letters, digits, '.', '_', '-' only, 1-${IDENTIFIER_PROFILE_MAX_LENGTH} chars, no leading/trailing separator.`,
      context: { field: "workload-tag", value: tag },
      recommendation: "Example: --workload-tag prod  or  --workload-tag host-01",
    });
  }
}

/**
 * Resolve `--workload-id` / `K9O_WORKLOAD_ID`. Returns
 * `undefined` when CWI-mode is not selected. Validates the `wl_<base62>`
 * format and (if present) the tag's identifier profile eagerly, so a
 * malformed selector fails at parse time rather than deep in a command.
 */
export function resolveWorkloadId(flags: ParsedArgs["flags"]): string | undefined {
  const workloadId = flags["workload-id"] ?? process.env["K9O_WORKLOAD_ID"];
  if (workloadId === undefined) return undefined;
  if (!WORKLOAD_ID_PATTERN.test(workloadId)) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `--workload-id / K9O_WORKLOAD_ID must match wl_<base62>, got: ${workloadId}`,
      context: { field: "workload-id", value: workloadId },
      recommendation: null,
    });
  }
  const tag = flags["workload-tag"] ?? process.env["K9O_WORKLOAD_TAG"];
  if (tag !== undefined) validateWorkloadTag(tag);
  return workloadId;
}

/**
 * CWI-mode is specified but the mint/DPoP wire
 * contract is genuinely unspecified upstream — see the module docstring.
 * Selecting it fails fast and honestly rather than falling through to a
 * misleading "no credentials, run k9o login" error.
 */
export function cwiModeNotYetOperableError(workloadId: string): KError {
  return new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message:
      `CWI mode is selected (workload ${workloadId}) but not yet operable — the underlying ` +
      "mint/DPoP protocol isn't built yet.",
    context: { workloadId },
    recommendation: "Use k9o login or K9O_SERVICE_TOKEN until CWI-mode's wire contract lands.",
  });
}

/**
 * The project-context resolution precedence, rendered as a
 * recommendation string for `MISSING_PROJECT_CONTEXT` failures.
 *
 * Spec ordering: flag > K9O_PROJECT env > active project from
 * config (`k9o project set-active`) > service-token bound project >
 * Workload's bound project (CWI-mode, immutable one-project binding).
 */
const PROJECT_CONTEXT_PRECEDENCE_HINT =
  "Resolve project context via one of (highest precedence first): " +
  "1. --project <slug> flag; " +
  "2. K9O_PROJECT env var; " +
  "3. active project from config (`k9o project set-active <slug>`); " +
  "4. service-token bound project (service-token mode); " +
  "5. Workload's bound project (CWI-mode).";

const ORG_CONTEXT_PRECEDENCE_HINT =
  "Resolve org context via one of (highest precedence first): " +
  "1. --org <slug> flag; " +
  "2. K9O_ORG env var; " +
  "3. the org bound to the active profile at login.";

/**
 * Construct the `MISSING_PROJECT_CONTEXT` error, printing the
 * resolution-precedence list as the recommendation.
 *
 * The coined code is emitted with the `K9O_`-prefixed variant
 * (`K9O_MISSING_PROJECT_CONTEXT`) so the existing exit-code resolver maps
 * it deterministically to exit 65 (`EXIT_MISSING_CONTEXT`);
 * the spec-canonical `MISSING_PROJECT_CONTEXT` name is carried in
 * `context.canonicalCode` for traceability and consumers narrowing on the
 * unprefixed name.
 */
export function missingProjectContextError(): KError {
  return new KError({
    code: "K9O_MISSING_PROJECT_CONTEXT",
    message:
      "This command requires a project context, but none could be resolved.",
    context: { canonicalCode: "MISSING_PROJECT_CONTEXT" },
    recommendation: PROJECT_CONTEXT_PRECEDENCE_HINT,
  });
}

/**
 * Construct the `MISSING_ORG_CONTEXT` error (org-symmetric to
 * `MISSING_PROJECT_CONTEXT`), also mapping to exit 65.
 */
export function missingOrgContextError(): KError {
  return new KError({
    code: "K9O_MISSING_ORG_CONTEXT",
    message: "This command requires an org context, but none could be resolved.",
    context: { canonicalCode: "MISSING_ORG_CONTEXT" },
    recommendation: ORG_CONTEXT_PRECEDENCE_HINT,
  });
}

async function readSecretFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const buf = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\n")) {
        process.stdin.pause();
        resolve(data.split("\n")[0]!);
      }
    });
  });
  return buf.trim();
}

export async function cmdLogin(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  if (args.flags["help"] === "true") {
    process.stdout.write(`
k9o login — sign in to a Kilimanjaro project

USAGE
  k9o login --org <slug> --project <slug> [--base-url <url>] [--email <email>] [--password <password>]

  --base-url defaults to https://api.k9o.io and derives the org subdomain
  from --org — pass --org alone for a production login. Give --base-url
  explicitly only for a non-default host (self-hosted / Sovereign / dev), or
  skip --org entirely if --base-url already includes the org subdomain
  (e.g. https://acme.api.k9o.io).
  base-url / org / project also read from K9O_BASE_URL / K9O_ORG / K9O_PROJECT.
  email / password also read from K9O_EMAIL / K9O_PASSWORD, or prompted if omitted.

Examples:
  k9o login --org acme --project member-portal
  k9o login --base-url https://platform.example.com --org acme --project member-portal
`.trim() + "\n");
    return EXIT_SUCCESS;
  }
  const baseUrlInput = args.flags["base-url"] ?? process.env["K9O_BASE_URL"];
  const orgSlug = args.flags["org"] ?? process.env["K9O_ORG"];
  const projectSlug = args.flags["project"] ?? process.env["K9O_PROJECT"];

  if (projectSlug === undefined) {
    emitError(format, new KError({
      code: "K9O_MISSING_PROJECT_CONTEXT",
      message: "login requires --project (or K9O_PROJECT)",
      context: {},
      recommendation: "Example: k9o login --org acme --project member-portal",
    }));
    return EXIT_USAGE;
  }

  let baseUrl: string;
  try {
    // Same resolution `createClient` does internally: --base-url is optional
    // and defaults to the platform apex, deriving `<org>.api.k9o.io` from
    // --org; an already-qualified --base-url (or a self-hosted/dev host)
    // passes through unchanged.
    baseUrl = resolveBaseUrl(baseUrlInput, orgSlug);
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }

  const hostname = new URL(baseUrl).hostname;

  // The one case resolution can't paper over: still on a bare platform
  // apex (prod OR staging) with no org to derive a subdomain from at all.
  if ((hostname === "api.k9o.io" || hostname === "api-staging.k9o.io") && orgSlug === undefined) {
    emitError(format, new KError({
      code: "K9O_MISSING_PROJECT_CONTEXT",
      message: "login requires --org (or K9O_ORG), or a --base-url that already includes the org subdomain",
      context: {},
      recommendation:
        "k9o login --org acme --project member-portal   (defaults to https://acme.api.k9o.io)\n" +
        "     or: k9o login --base-url https://acme.api.k9o.io --project member-portal",
    }));
    return EXIT_USAGE;
  }

  // The stored profile's `orgSlug` is required (not optional) — every other
  // command reconstructs its client from it. When --org was omitted because
  // --base-url already carried the org subdomain (a bare-apex host would
  // have been rejected above), recover it from the resolved host for a
  // known platform apex family; anything else (self-hosted / Sovereign /
  // dev) has no reliable subdomain convention to parse, so it still needs
  // an explicit --org.
  let resolvedOrgSlug = orgSlug;
  if (resolvedOrgSlug === undefined) {
    const match = /^([a-z][a-z0-9-]*)\.(api(?:-staging)?\.k9o\.io)$/.exec(hostname);
    if (match?.[1] === undefined) {
      emitError(format, new KError({
        code: "K9O_MISSING_PROJECT_CONTEXT",
        message: `login requires --org (or K9O_ORG) — could not determine the org from --base-url "${baseUrl}"`,
        context: { baseUrl },
        recommendation: "Pass --org explicitly, e.g. k9o login --base-url " + baseUrl + " --org <slug> --project member-portal",
      }));
      return EXIT_USAGE;
    }
    resolvedOrgSlug = match[1];
  }

  // Read email + password from flags or env or prompt
  const email = args.flags["email"] ?? process.env["K9O_EMAIL"]
    ?? await readSecretFromStdin("email: ");
  const password = args.flags["password"] ?? process.env["K9O_PASSWORD"]
    ?? await readSecretFromStdin("password: ");

  try {
    const client = createClient({ baseUrl, orgSlug: resolvedOrgSlug, projectSlug });
    const result = await client.gate.signIn({ email, password });

    // Persist to credentials file under the resolved profile name.
    const creds = readCredentials(args.flags["credentials-file"]);
    const profileName = resolveActiveProfile(args.flags, creds);
    creds.profiles[profileName] = {
      refreshToken: result.data.session.refreshToken,
      accessToken: result.data.session.accessToken,
      expiresAt: result.data.session.expiresAt,
      baseUrl,
      orgSlug: resolvedOrgSlug,
      userId: result.data.user.id,
      userEmail: result.data.user.email,
      activeProjectSlug: projectSlug,
    };
    creds.current = profileName;
    writeCredentials(creds, args.flags["credentials-file"]);

    emitSuccess(format, {
      data: {
        profile: profileName,
        userId: result.data.user.id,
        email: result.data.user.email,
        orgSlug: resolvedOrgSlug,
        activeProjectSlug: projectSlug,
      },
      meta: {},
    }, (d) => `Signed in as ${d.email} (${d.userId}) on org=${d.orgSlug} project=${d.activeProjectSlug} (profile=${d.profile})`);

    return EXIT_SUCCESS;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

export async function cmdLogout(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  if (args.flags["help"] === "true") {
    process.stdout.write("k9o logout — clear local credentials for the active (or --profile) profile\n\nUSAGE\n  k9o logout [--profile <name>]\n");
    return EXIT_SUCCESS;
  }
  try {
    const creds = readCredentials(args.flags["credentials-file"]);
    const profileName = resolveActiveProfile(args.flags, creds);
    if (creds.profiles[profileName] === undefined) {
      emitSuccess(format, { data: { profile: profileName, alreadyClearedOrAbsent: true }, meta: {} },
        (d) => `Profile "${d.profile}" was already absent — nothing to clear.`);
      return EXIT_SUCCESS;
    }
    delete creds.profiles[profileName];
    writeCredentials(creds, args.flags["credentials-file"]);
    emitSuccess(format, { data: { profile: profileName, cleared: true }, meta: {} },
      (d) => `Cleared credentials for profile "${d.profile}".`);
    return EXIT_SUCCESS;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

export async function cmdWhoami(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  if (args.flags["help"] === "true") {
    process.stdout.write("k9o whoami — print the active identity\n\nUSAGE\n  k9o whoami [--profile <name>]\n");
    return EXIT_SUCCESS;
  }
  try {
    const creds = readCredentials(args.flags["credentials-file"]);
    const profileName = resolveActiveProfile(args.flags, creds);
    const profile = creds.profiles[profileName];
    if (profile === undefined) {
      emitError(format, new KError({
        code: "UNAUTHENTICATED",
        message: `No credentials for profile "${profileName}". Run \`k9o login\` first.`,
        context: { profile: profileName },
        recommendation: "k9o login --base-url <url> --org <slug> --project <slug>",
      }));
      return EXIT_AUTH;
    }
    emitSuccess(format, {
      data: {
        profile: profileName,
        userId: profile.userId,
        email: profile.userEmail,
        orgSlug: profile.orgSlug,
        activeProjectSlug: profile.activeProjectSlug,
        baseUrl: profile.baseUrl,
      },
      meta: {},
    }, (d) => `${d.email} (${d.userId}) on org=${d.orgSlug}${d.activeProjectSlug !== null ? ` project=${d.activeProjectSlug}` : " (no active project)"} (profile=${d.profile})`);
    return EXIT_SUCCESS;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

/**
 * Construct an authenticated K9oClient from the active profile.
 *
 * Throws `UNAUTHENTICATED` if no profile is logged in.
 *
 * Project + org context are resolved through the canonical precedence
 * resolvers (`resolveProjectContext` / `resolveOrgContext` from
 * config-store) — flag > `K9O_PROJECT` env > active project from config
 * (> service-token bound project). The previous inline coalesce
 * (`flags["project"] ?? profile.activeProjectSlug`) silently SKIPPED the
 * `K9O_PROJECT` / `K9O_ORG` env layer (step 2); routing through the
 * resolvers fixes that.
 *
 * When `opts.requireProject` is set, a command that cannot resolve a
 * project context fails fast with `MISSING_PROJECT_CONTEXT` (exit 65 per
 * /), printing the resolution-precedence list as the
 * recommendation. Callers that are org-scoped (or otherwise tolerate a
 * null project) leave `requireProject` unset — the default preserves the
 * prior behaviour for every existing caller.
 *
 * Used by all other commands that need API access.
 */
export function clientFromProfile(
  args: ParsedArgs,
  opts?: { requireProject?: boolean; requireOrg?: boolean },
): { client: ReturnType<typeof createClient>; profile: import("../config-store.ts").Profile; profileName: string } {
  // CWI-mode is checked FIRST — a caller who deliberately
  // selected it via --workload-id/K9O_WORKLOAD_ID should get an honest
  // "not yet operable" error, not a misleading "run k9o login" fallback.
  const workloadId = resolveWorkloadId(args.flags);
  if (workloadId !== undefined) throw cwiModeNotYetOperableError(workloadId);

  const creds = readCredentials(args.flags["credentials-file"]);
  const profileName = resolveActiveProfile(args.flags, creds);
  const profile = creds.profiles[profileName];
  if (profile === undefined) {
    throw new KError({
      code: "UNAUTHENTICATED",
      message: `No credentials for profile "${profileName}". Run \`k9o login\` first.`,
      context: { profile: profileName },
      recommendation: "k9o login --base-url <url> --org <slug> --project <slug>",
    });
  }

  // precedence (flag > K9O_PROJECT env > config active-project), via the
  // single canonical resolver — NOT the old 2-way coalesce that skipped env.
  const projectSlug = resolveProjectContext(args.flags, profile);
  const orgSlug = resolveOrgContext(args.flags, profile);

  if (opts?.requireProject === true && projectSlug === null) {
    throw missingProjectContextError();
  }
  if (opts?.requireOrg === true && orgSlug === null) {
    throw missingOrgContextError();
  }

  const client = createClient({
    baseUrl: profile.baseUrl,
    apiKey: profile.accessToken ?? profile.refreshToken,
    orgSlug: orgSlug ?? undefined,
    projectSlug: projectSlug ?? undefined,
  });
  return { client, profile, profileName };
}
