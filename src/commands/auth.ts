/**
 * `k9o login` / `k9o logout` / `k9o whoami`, plus the client factory every
 * other command uses.
 *
 * Auth flow:
 *   - `login` signs in as the OPERATOR (`POST /auth/sign-in`), clears the MFA
 *     challenge when the org requires one, and persists the tokens into the
 *     credentials file at `~/.k9o/credentials` (mode 0600). See
 *     `operator-auth.ts` for the wire flow. Password sign-in is the interim
 *     until browser-based device authorisation lands.
 *   - `logout` clears the active profile from the credentials file.
 *   - `whoami` prints the active profile's user + org + active project.
 *
 * For CI / automation use a service token: set `K9O_SERVICE_TOKEN` (sent as
 * the Bearer token, no login needed) and give the org and project through
 * flags or environment (`--org`/`K9O_ORG`, `--project`/`K9O_PROJECT`,
 * `--base-url`/`K9O_BASE_URL`).
 *
 * Keyless workload federation: `--workload-id swi_...` (or `K9O_WORKLOAD_ID`)
 * exchanges an external OIDC token for a short-lived platform token, held in
 * memory for the run (see `federation.ts`). A `wl_...` id selects the
 * bound-key mode, which is not built: it fails fast with a clear error rather
 * than falling through to "run k9o login".
 */

import { createClient, resolveBaseUrl, validateSlug, KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import {
  readCredentials,
  writeCredentials,
  resolveActiveProfile,
  resolveProjectContext,
  resolveOrgContext,
  type Profile,
} from "../config-store.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_AUTH, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { operatorSignIn, operatorRefresh, epochSecondsToIso } from "../operator-auth.ts";
import {
  FEDERATED_WORKLOAD_ID_PATTERN,
  exchangeWorkloadToken,
  getFederatedSession,
  oidcSourceFromEnv,
  resolveOidcToken,
  setFederatedSession,
  type FederatedSession,
} from "../federation.ts";

/** Strict ASCII identifier, at most 63 chars. Used for `--workload-tag` / `K9O_WORKLOAD_TAG`: a self-asserted, correlation-only string, never a security discriminator. */
const IDENTIFIER_PROFILE_PATTERN = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
const IDENTIFIER_PROFILE_MAX_LENGTH = 63;

/** `wl_<base62>` workload id shape. */
const WORKLOAD_ID_PATTERN = /^wl_[0-9A-Za-z]+$/;

/** Refresh the cached access token when it expires within this many milliseconds. */
const REFRESH_SKEW_MS = 30_000;

/**
 * Validate a `--workload-tag` / `K9O_WORKLOAD_TAG` value. Reject, never
 * sanitize: an invalid tag is a hard error, never silently truncated or
 * stripped.
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
 * Resolve `--workload-id` / `K9O_WORKLOAD_ID`. Returns `undefined` when
 * workload-identity mode is not selected. Validates the `wl_<base62>` format
 * and (if present) the tag eagerly, so a malformed selector fails at parse
 * time rather than deep in a command.
 */
export function resolveWorkloadId(flags: ParsedArgs["flags"]): string | undefined {
  const fromEnv = process.env["K9O_WORKLOAD_ID"];
  const workloadId = flags["workload-id"] ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined);
  if (workloadId === undefined) return undefined;
  if (!WORKLOAD_ID_PATTERN.test(workloadId) && !FEDERATED_WORKLOAD_ID_PATTERN.test(workloadId)) {
    throw new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `--workload-id / K9O_WORKLOAD_ID must start with swi_ (keyless federation) or wl_ (bound key), got: ${workloadId}`,
      context: { field: "workload-id", value: workloadId },
      recommendation: null,
    });
  }
  const tag = flags["workload-tag"] ?? process.env["K9O_WORKLOAD_TAG"];
  if (tag !== undefined) validateWorkloadTag(tag);
  return workloadId;
}

/** True when the workload id selects keyless federation (`swi_...`). */
export function isFederatedWorkloadId(workloadId: string | undefined): workloadId is string {
  return workloadId !== undefined && workloadId.startsWith("swi_");
}

/**
 * Federation mode: exchange the external OIDC token for a platform token, once per run, and keep it in memory.
 * Call before the first authenticated request. A no-op outside federation mode or when already exchanged.
 */
export async function prepareFederation(
  args: ParsedArgs,
  deps: { fetch?: typeof globalThis.fetch | undefined } = {},
): Promise<FederatedSession | null> {
  const workloadId = resolveWorkloadId(args.flags);
  if (!isFederatedWorkloadId(workloadId)) return null;
  const existing = getFederatedSession();
  if (existing !== null && existing.workloadId === workloadId) return existing;

  const baseUrlInput = args.flags["base-url"] ?? process.env["K9O_BASE_URL"];
  const orgSlug = resolveOrgContext(args.flags, undefined);
  const projectSlug = resolveProjectContext(args.flags, undefined);
  if (projectSlug === null) throw missingProjectContextError();
  if (baseUrlInput === undefined && orgSlug === null) throw missingOrgContextError();
  validateSlug(projectSlug, "project");
  if (orgSlug !== null) validateSlug(orgSlug, "org");
  const baseUrl = resolveBaseUrl(baseUrlInput, orgSlug ?? undefined);
  const tag = args.flags["workload-tag"] ?? process.env["K9O_WORKLOAD_TAG"];

  const oidcToken = await resolveOidcToken(oidcSourceFromEnv(args.flags), { fetch: deps.fetch });
  const res = await exchangeWorkloadToken({
    baseUrl,
    projectSlug,
    workloadId,
    oidcToken,
    ...(tag !== undefined ? { tag } : {}),
    ...(orgSlug !== null ? { orgSlug } : {}),
    fetch: deps.fetch,
  });
  const session: FederatedSession = {
    workloadId,
    orgSlug,
    projectSlug,
    baseUrl,
    accessToken: res.accessToken,
    tokenType: res.tokenType,
    expiresIn: res.expiresIn,
  };
  setFederatedSession(session);
  return session;
}

/**
 * Workload-identity mode is recognised but its token mint is not built yet.
 * Selecting it fails fast and honestly rather than falling through to a
 * misleading "no credentials, run k9o login" error.
 */
export function cwiModeNotYetOperableError(workloadId: string): KError {
  return new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message:
      `Workload-identity mode is selected (workload ${workloadId}) but not yet operable — the underlying ` +
      "token exchange isn't built yet.",
    context: { workloadId },
    recommendation: "Use k9o login or K9O_SERVICE_TOKEN until workload-identity mode lands.",
  });
}

const PROJECT_CONTEXT_PRECEDENCE_HINT =
  "Resolve project context via one of (highest precedence first): " +
  "1. --project <slug> flag; " +
  "2. K9O_PROJECT env var; " +
  "3. active project from config (`k9o project set-active <slug>`).";

const ORG_CONTEXT_PRECEDENCE_HINT =
  "Resolve org context via one of (highest precedence first): " +
  "1. --org <slug> flag; " +
  "2. K9O_ORG env var; " +
  "3. the org bound to the active profile at login.";

/** The error for a command that needs a project but none could be resolved. Exit 65. */
export function missingProjectContextError(): KError {
  return new KError({
    code: "K9O_MISSING_PROJECT_CONTEXT",
    message:
      "This command requires a project context, but none could be resolved.",
    context: { canonicalCode: "MISSING_PROJECT_CONTEXT" },
    recommendation: PROJECT_CONTEXT_PRECEDENCE_HINT,
  });
}

/** The org-symmetric twin of `missingProjectContextError`. Exit 65. */
export function missingOrgContextError(): KError {
  return new KError({
    code: "K9O_MISSING_ORG_CONTEXT",
    message: "This command requires an org context, but none could be resolved.",
    context: { canonicalCode: "MISSING_ORG_CONTEXT" },
    recommendation: ORG_CONTEXT_PRECEDENCE_HINT,
  });
}

/** The service token from `K9O_SERVICE_TOKEN`, or undefined when unset/empty. */
export function serviceTokenFromEnv(): string | undefined {
  const t = process.env["K9O_SERVICE_TOKEN"];
  return typeof t === "string" && t.length > 0 ? t : undefined;
}

async function readLineFromStdin(prompt: string): Promise<string> {
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

export type LoginDeps = { fetch?: typeof globalThis.fetch | undefined };

export async function cmdLogin(args: ParsedArgs, deps: LoginDeps = {}): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  if (args.flags["help"] === "true") {
    process.stdout.write(`
k9o login — sign in as an operator

USAGE
  k9o login [--org <slug>] [--base-url <url>] [--email <email>] [--password <password>]
            [--mfa-code <code>] [--project <slug>]

  Signs in with your operator email and password (not as a project end user).
  Password sign-in is the interim method; browser-based device authorisation
  replaces it once it lands.

  If your organisation requires multi-factor authentication you are asked for
  an authenticator-app code (or pass --mfa-code / K9O_MFA_CODE in scripts).
  If you have no authenticator enrolled yet, enroll one in the Console first.

  --base-url defaults to the public cloud and derives the org host from --org.
  Give --base-url explicitly for a self-hosted or internal host, or pass an
  org host that already includes the org (e.g. https://acme.api.example.com).
  --project sets the default project for later commands (optional).
  base-url / org / project / email / password / mfa-code also read from
  K9O_BASE_URL / K9O_ORG / K9O_PROJECT / K9O_EMAIL / K9O_PASSWORD / K9O_MFA_CODE.
  Email and password are prompted if omitted.

  For CI use K9O_SERVICE_TOKEN instead of logging in (see \`k9o --help\`).

  Keyless sign-in from CI (instead of a login or a stored secret):
    --workload-id <swi_...>      The federated workload id (env K9O_WORKLOAD_ID). Needs --org (or
                                 --base-url) and --project.
    --workload-tag <label>       Optional label for the run (env K9O_WORKLOAD_TAG)
    --oidc-token-file <path>     Read the external OIDC token from a file
    K9O_OIDC_TOKEN               ...or from this variable
    --oidc-audience <aud>        On GitHub Actions, the audience to request (env K9O_OIDC_AUDIENCE)
  On GitHub Actions the job needs \`permissions: id-token: write\`. The CLI exchanges the token once per
  run and keeps the result in memory; nothing is written to disk.
  Today that token carries no project grants, so commands after the exchange are refused. The exchange
  itself works (check it with \`k9o whoami\`). Use K9O_SERVICE_TOKEN to run commands in CI until then.

Examples:
  k9o login --org acme
  k9o login --org acme --project member-portal
  k9o login --base-url https://platform.example.com --org acme
`.trim() + "\n");
    return EXIT_SUCCESS;
  }
  const baseUrlInput = args.flags["base-url"] ?? process.env["K9O_BASE_URL"];
  const orgSlug = args.flags["org"] ?? process.env["K9O_ORG"];
  const projectSlug = args.flags["project"] ?? process.env["K9O_PROJECT"];

  let baseUrl: string;
  try {
    if (orgSlug !== undefined) validateSlug(orgSlug, "org");
    if (projectSlug !== undefined) validateSlug(projectSlug, "project");
    // --base-url is optional and defaults to the platform host; --org derives
    // the org host from it. An org host, self-hosted or dev host passes
    // through unchanged.
    baseUrl = resolveBaseUrl(baseUrlInput, orgSlug);
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }

  const email = args.flags["email"] ?? process.env["K9O_EMAIL"]
    ?? await readLineFromStdin("email: ");
  const password = args.flags["password"] ?? process.env["K9O_PASSWORD"]
    ?? await readLineFromStdin("password: ");
  const mfaCode = args.flags["mfa-code"] ?? process.env["K9O_MFA_CODE"];

  try {
    const session = await operatorSignIn({
      baseUrl,
      ...(orgSlug !== undefined ? { orgSlug } : {}),
      email,
      password,
      mfaCode,
      promptMfaCode: process.stdin.isTTY === true ? () => readLineFromStdin("MFA code: ") : undefined,
      fetch: deps.fetch,
    });

    // Persist under the resolved profile name. The profile's base URL is the
    // org's host, derived from the org the gateway signed us into.
    const profileBaseUrl = resolveBaseUrl(baseUrlInput, session.org.slug);
    const creds = readCredentials(args.flags["credentials-file"]);
    const profileName = resolveActiveProfile(args.flags, creds);
    const activeProject = projectSlug ?? session.project?.slug ?? null;
    creds.profiles[profileName] = {
      refreshToken: session.refreshToken ?? "",
      accessToken: session.accessToken,
      expiresAt: epochSecondsToIso(session.accessTokenExp),
      refreshTokenExpiresAt: session.refreshTokenExp !== null ? epochSecondsToIso(session.refreshTokenExp) : null,
      baseUrl: profileBaseUrl,
      orgSlug: session.org.slug,
      userId: session.user.id,
      userEmail: session.user.email,
      activeProjectSlug: activeProject,
    };
    creds.current = profileName;
    writeCredentials(creds, args.flags["credentials-file"]);

    emitSuccess(format, {
      data: {
        profile: profileName,
        userId: session.user.id,
        email: session.user.email,
        orgSlug: session.org.slug,
        activeProjectSlug: activeProject,
        mfaVerified: session.mfaVerified,
      },
      meta: {},
    }, (d) =>
      `Signed in as ${d.email} (${d.userId}) on org=${d.orgSlug}` +
      `${d.activeProjectSlug !== null ? ` project=${d.activeProjectSlug}` : " (no active project; run `k9o project set-active <slug>`)"}` +
      ` (profile=${d.profile})`,
    );

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

export async function cmdWhoami(args: ParsedArgs, deps: { fetch?: typeof globalThis.fetch | undefined } = {}): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  if (args.flags["help"] === "true") {
    process.stdout.write("k9o whoami — print the active identity\n\nUSAGE\n  k9o whoami [--profile <name>]\n\n  With K9O_SERVICE_TOKEN set, reports service-token mode instead of a profile.\n  With --workload-id swi_... (keyless federation) it performs the token exchange and reports the\n  workload, org, project and how long the token lasts. Tokens are never printed.\n");
    return EXIT_SUCCESS;
  }
  try {
    if (isFederatedWorkloadId(resolveWorkloadId(args.flags))) {
      const fed = await prepareFederation(args, deps);
      if (fed === null) throw new Error("unreachable");
      emitSuccess(format, {
        data: {
          mode: "federated-workload",
          workloadId: fed.workloadId,
          orgSlug: fed.orgSlug,
          activeProjectSlug: fed.projectSlug,
          expiresIn: fed.expiresIn,
        },
        meta: {},
      }, (d) =>
        `federated workload ${d.workloadId} on org=${d.orgSlug ?? "(unset)"} project=${d.activeProjectSlug}, token valid for ${d.expiresIn}s`,
      );
      return EXIT_SUCCESS;
    }
    if (serviceTokenFromEnv() !== undefined) {
      emitSuccess(format, {
        data: {
          mode: "service-token",
          orgSlug: args.flags["org"] ?? process.env["K9O_ORG"] ?? null,
          activeProjectSlug: args.flags["project"] ?? process.env["K9O_PROJECT"] ?? null,
        },
        meta: {},
      }, (d) =>
        `service token (K9O_SERVICE_TOKEN) on org=${d.orgSlug ?? "(unset)"} project=${d.activeProjectSlug ?? "(unset)"}`,
      );
      return EXIT_SUCCESS;
    }
    const creds = readCredentials(args.flags["credentials-file"]);
    const profileName = resolveActiveProfile(args.flags, creds);
    const profile = creds.profiles[profileName];
    if (profile === undefined) {
      emitError(format, new KError({
        code: "UNAUTHENTICATED",
        message: `No credentials for profile "${profileName}". Run \`k9o login\` first.`,
        context: { profile: profileName },
        recommendation: "k9o login --org <slug>   (or set K9O_SERVICE_TOKEN for CI)",
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
 * Refresh the active profile's access token when it has expired (or is about
 * to), using `POST /auth/refresh`. The refresh token is single-use, so the new
 * pair is written back to the credentials file immediately. A no-op in
 * service-token mode, workload-identity mode, with no stored profile, or when
 * the cached token is still valid. Called once by the dispatcher before an
 * authenticated command runs.
 */
export async function refreshSessionIfNeeded(
  args: ParsedArgs,
  deps: { fetch?: typeof globalThis.fetch | undefined; now?: () => number } = {},
): Promise<void> {
  if (serviceTokenFromEnv() !== undefined) return;
  if (resolveWorkloadId(args.flags) !== undefined) return;
  const credsPath = args.flags["credentials-file"];
  const creds = readCredentials(credsPath);
  const profileName = resolveActiveProfile(args.flags, creds);
  const profile = creds.profiles[profileName];
  if (profile === undefined || profile.expiresAt === null || profile.refreshToken.length === 0) return;
  const now = deps.now?.() ?? Date.now();
  const expiresMs = Date.parse(profile.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs - now > REFRESH_SKEW_MS) return;

  try {
    const next = await operatorRefresh({ baseUrl: profile.baseUrl, refreshToken: profile.refreshToken, fetch: deps.fetch });
    profile.accessToken = next.accessToken;
    profile.expiresAt = epochSecondsToIso(next.accessTokenExp);
    profile.refreshToken = next.refreshToken;
    profile.refreshTokenExpiresAt = epochSecondsToIso(next.refreshTokenExp);
    writeCredentials(creds, credsPath);
  } catch (e) {
    if (e instanceof KError && (e.status === 401 || e.status === 403)) {
      throw new KError({
        code: "UNAUTHENTICATED",
        message: "Your session has expired and could not be refreshed.",
        context: { profile: profileName },
        recommendation: "Run `k9o login` to sign in again.",
      });
    }
    throw e;
  }
}

/**
 * Construct an authenticated K9oClient.
 *
 * Auth source, in order:
 *   0. Workload federation (`--workload-id swi_...`): the token `prepareFederation` exchanged.
 *   1. `K9O_SERVICE_TOKEN` (Bearer; no login). Org, project and base URL come
 *      from flags or environment only.
 *   2. The active profile from the credentials file (`k9o login`).
 * Throws `UNAUTHENTICATED` when neither is present.
 *
 * Project and org context resolve flag > env > active profile. When
 * `opts.requireProject` is set, a command that cannot resolve a project fails
 * fast with a missing-project-context error (exit 65), printing the
 * resolution order as the recommendation. Org-scoped callers leave it unset.
 *
 * Used by all other commands that need API access.
 */
export function clientFromProfile(
  args: ParsedArgs,
  opts?: { requireProject?: boolean; requireOrg?: boolean },
): { client: ReturnType<typeof createClient>; profile: Profile; profileName: string; bearerToken: string } {
  // Workload-identity mode is checked first: a caller who deliberately
  // selected it gets its own path (or an honest "not yet operable" error for
  // a wl_ id), not a misleading "run k9o login" fallback.
  const workloadId = resolveWorkloadId(args.flags);
  if (workloadId !== undefined && !isFederatedWorkloadId(workloadId)) throw cwiModeNotYetOperableError(workloadId);
  if (isFederatedWorkloadId(workloadId)) {
    const fed = getFederatedSession();
    if (fed === null) {
      throw new KError({
        code: "K9O_INTERNAL_ERROR",
        message: "Workload federation is selected but the token exchange has not run.",
        context: { workloadId },
        recommendation: null,
      });
    }
    if (opts?.requireProject === true && fed.projectSlug.length === 0) throw missingProjectContextError();
    const client = createClient({
      baseUrl: fed.baseUrl,
      apiKey: fed.accessToken,
      orgSlug: fed.orgSlug ?? undefined,
      projectSlug: fed.projectSlug,
    });
    const profile: Profile = {
      refreshToken: "",
      accessToken: fed.accessToken,
      expiresAt: new Date(Date.now() + fed.expiresIn * 1000).toISOString(),
      baseUrl: fed.baseUrl,
      orgSlug: fed.orgSlug ?? "",
      userId: fed.workloadId,
      userEmail: fed.workloadId,
      activeProjectSlug: fed.projectSlug,
    };
    return { client, profile, profileName: "federated-workload", bearerToken: fed.accessToken };
  }

  const serviceToken = serviceTokenFromEnv();
  if (serviceToken !== undefined) {
    const baseUrlInput = args.flags["base-url"] ?? process.env["K9O_BASE_URL"];
    const orgSlug = resolveOrgContext(args.flags, undefined);
    const projectSlug = resolveProjectContext(args.flags, undefined);
    if (baseUrlInput === undefined && orgSlug === null) throw missingOrgContextError();
    if (opts?.requireProject === true && projectSlug === null) throw missingProjectContextError();
    const baseUrl = resolveBaseUrl(baseUrlInput, orgSlug ?? undefined);
    const client = createClient({
      baseUrl,
      apiKey: serviceToken,
      orgSlug: orgSlug ?? undefined,
      projectSlug: projectSlug ?? undefined,
    });
    const profile: Profile = {
      refreshToken: "",
      accessToken: serviceToken,
      expiresAt: null,
      baseUrl,
      orgSlug: orgSlug ?? "",
      userId: "service-token",
      userEmail: "service-token",
      activeProjectSlug: projectSlug,
    };
    return { client, profile, profileName: "service-token", bearerToken: serviceToken };
  }

  const creds = readCredentials(args.flags["credentials-file"]);
  const profileName = resolveActiveProfile(args.flags, creds);
  const profile = creds.profiles[profileName];
  if (profile === undefined) {
    throw new KError({
      code: "UNAUTHENTICATED",
      message: `No credentials for profile "${profileName}". Run \`k9o login\` first.`,
      context: { profile: profileName },
      recommendation: "k9o login --org <slug>   (or set K9O_SERVICE_TOKEN for CI)",
    });
  }

  const projectSlug = resolveProjectContext(args.flags, profile);
  const orgSlug = resolveOrgContext(args.flags, profile);

  if (opts?.requireProject === true && projectSlug === null) {
    throw missingProjectContextError();
  }
  if (opts?.requireOrg === true && orgSlug === null) {
    throw missingOrgContextError();
  }

  const bearerToken = profile.accessToken ?? profile.refreshToken;
  const client = createClient({
    baseUrl: profile.baseUrl,
    apiKey: bearerToken,
    orgSlug: orgSlug ?? undefined,
    projectSlug: projectSlug ?? undefined,
  });
  return { client, profile, profileName, bearerToken };
}
