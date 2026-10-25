/**
 * `k9o init` — interactive project/workspace bootstrap wizard (login/project/
 * config surface, credentials model, project-context resolution, and the
 * `--profile` / `--config` flags).
 *
 * Purely-local DX wrapper — introduces NO new platform API. It composes
 * already-exposed surfaces to take a fresh checkout from "nothing" to a
 * working profile with an active project bound:
 *
 *   1. Resolve org / gateway / project from flags or K9O_* env
 *      (prompting for the missing pieces in an interactive terminal). The
 *      org slug is asked FIRST and the gateway is then DERIVED from it —
 *      `https://<orgSlug>.api.k9o.io` per the baseUrl-optional rule
 *      via the SDK `resolveBaseUrl`. An explicit
 *      `--base-url`/`K9O_BASE_URL` (self-hosted / Sovereign) is honoured,
 *      and an interactive run can override the derived default at the prompt.
 *   2. If the resolved profile is not yet authenticated (no credentials
 *      via `readCredentials`), hand off to `cmdLogin` (auth.ts) so the
 *      refresh token is minted + persisted at `~/.k9o/credentials` 0600.
 *   3. Call `client.projects.list()` (SDK `makeProjectsNamespace`, already
 *      exposed) to let the operator pick an existing project — or scaffold
 *      a new one with `client.projects.create()`.
 *   4. Persist baseUrl / orgSlug + `activeProjectSlug` into the resolved
 *      profile via `writeCredentials` (the set-active equivalent,).
 *   5. Print next-steps.
 *
 * No new API logic: it is a thin orchestration over `cmdLogin`,
 * `clientFromProfile` / `client.projects.{list,create}`, the config-store
 * helpers, and the shared output/exit-code conventions (/).
 *
 * In `--output json` mode the wizard is non-interactive: every required
 * input must arrive via flag or env (an interactive prompt would corrupt
 * the canonical stdout contract), and a single structured envelope is
 * emitted on completion. The gateway is the one exception — when omitted it
 * is derived from `--org` (`https://<orgSlug>.api.k9o.io`), so a scripted
 * `k9o init --org acme --project p --output json` needs no `--base-url`.
 */

import { KError, resolveBaseUrl, validateSlug } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { cmdLogin, clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat, type OutputFormat } from "../output.ts";
import {
  readCredentials,
  writeCredentials,
  resolveActiveProfile,
} from "../config-store.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";

/** Read a single line of non-secret input from stdin (mirrors auth.ts). */
async function readLineFromStdin(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const buf = await new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
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

/** Prompt showing a default in brackets; an empty answer accepts the default. */
async function promptWithDefault(promptText: string, def: string): Promise<string> {
  const v = await readLineFromStdin(`${promptText} [${def}]: `);
  return v.length === 0 ? def : v;
}

/** Max interactive re-prompt attempts before giving up (avoids an infinite loop). */
const MAX_PROMPT_ATTEMPTS = 5;

/**
 * Resolve the org slug (flag → env → interactive prompt) and validate it
 * against the slug grammar. In an interactive run an invalid or empty
 * answer is re-prompted (up to MAX_PROMPT_ATTEMPTS); in json mode an absent or
 * malformed value throws so CI fails loudly instead of hanging.
 */
export async function resolveOrgSlug(args: ParsedArgs, format: OutputFormat): Promise<string> {
  const fromFlagOrEnv = args.flags["org"] ?? process.env["K9O_ORG"];
  if (fromFlagOrEnv !== undefined && fromFlagOrEnv.length > 0) {
    validateSlug(fromFlagOrEnv, "org"); // throws K9O_INVALID_FIELD_VALUE on bad input
    return fromFlagOrEnv;
  }
  if (format === "json") {
    throw new KError({
      code: "K9O_MISSING_PROJECT_CONTEXT",
      message: "k9o init in --output json mode is non-interactive and requires --org via flag or env",
      context: { missing: "--org" },
      recommendation: "Supply --org <slug> (or set K9O_ORG) when scripting `k9o init`.",
    });
  }
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
    const v = await readLineFromStdin("Org slug: ");
    if (v.length === 0) {
      process.stdout.write("  Org slug is required.\n");
      continue;
    }
    try {
      validateSlug(v, "org");
      return v;
    } catch (e) {
      process.stdout.write(`  ${e instanceof KError ? e.message : String(e)}\n`);
    }
  }
  throw new KError({
    code: "K9O_MISSING_PROJECT_CONTEXT",
    message: "no valid org slug provided",
    context: { missing: "--org" },
    recommendation: "Run `k9o init` again and enter a slug matching ^[a-z][a-z0-9-]{1,62}$, or pass --org.",
  });
}

/**
 * Resolve the gateway base URL per the baseUrl-optional rule.
 * Precedence: explicit --base-url/K9O_BASE_URL (run through `resolveBaseUrl`
 * so a bare apex still derives the org subdomain) → else derive
 * `https://<orgSlug>.api.k9o.io`. In an interactive run the derived value is
 * offered as a bracketed default the operator can override (self-hosted /
 * Sovereign hosts); in json mode it is taken silently with no prompt.
 */
export async function resolveGatewayBaseUrl(
  args: ParsedArgs,
  orgSlug: string,
  format: OutputFormat,
): Promise<string> {
  const explicit = args.flags["base-url"] ?? process.env["K9O_BASE_URL"];
  if (explicit !== undefined && explicit.length > 0) {
    return resolveBaseUrl(explicit, orgSlug); // validates + derives apex→subdomain
  }
  const derived = resolveBaseUrl(undefined, orgSlug); // https://<orgSlug>.api.k9o.io
  if (format === "json") return derived;
  const chosen = await promptWithDefault("Gateway URL", derived);
  return resolveBaseUrl(chosen, orgSlug); // re-validate any custom host the operator typed
}

/**
 * Resolve a required scalar from flag → env → (interactive) prompt.
 * In json mode, prompting is disallowed: an absent value throws
 * K9O_MISSING_PROJECT_CONTEXT so CI fails loudly instead of hanging.
 */
async function resolveRequired(
  flagVal: string | undefined,
  envVal: string | undefined,
  label: string,
  promptText: string,
  format: OutputFormat,
): Promise<string> {
  const fromFlagOrEnv = flagVal ?? envVal;
  if (fromFlagOrEnv !== undefined && fromFlagOrEnv.length > 0) return fromFlagOrEnv;
  if (format === "json") {
    throw new KError({
      code: "K9O_MISSING_PROJECT_CONTEXT",
      message: `k9o init in --output json mode is non-interactive and requires ${label} via flag or env`,
      context: { missing: label },
      recommendation:
        "Supply --base-url / --org (and optionally --project) as flags, or set K9O_BASE_URL / K9O_ORG / K9O_PROJECT, when scripting `k9o init`.",
    });
  }
  const v = await readLineFromStdin(promptText);
  if (v.length === 0) {
    throw new KError({
      code: "K9O_MISSING_PROJECT_CONTEXT",
      message: `${label} is required`,
      context: { missing: label },
      recommendation: `Provide ${label} when prompted, or pass it as a flag / env var.`,
    });
  }
  return v;
}

export async function dispatchInit(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);

  if (args.flags["help"] === "true") {
    process.stdout.write(`
k9o init — bootstrap a workspace (auth + active project)

USAGE
  k9o init [--org <slug>] [--base-url <url>] [--project <slug>]

Interactively resolves an org, derives its gateway, signs you in if you
aren't already, and sets an active project — everything \`k9o login\` +
\`k9o project set-active\` do, in one guided flow. Any flag you pass is used
as-is instead of being prompted for.
`.trim() + "\n");
    return EXIT_SUCCESS;
  }

  try {
    // ---- 1. Resolve org first, then DERIVE the gateway from it -----------
    // Org slug is the primary identity; the gateway is `https://<org>.api.k9o.io`
    // by default (baseUrl-optional rule). Asking org-first lets a
    // fresh checkout reach a working profile without knowing the URL grammar.
    const orgSlug = await resolveOrgSlug(args, format);
    const baseUrl = await resolveGatewayBaseUrl(args, orgSlug, format);

    // ---- 2. Ensure the resolved profile is authenticated -----------------
    // Pre-resolve the profile name so login + persistence target the same one.
    const credsProbe = readCredentials(args.flags["credentials-file"]);
    const profileName = resolveActiveProfile(args.flags, credsProbe);
    const alreadyAuthed = credsProbe.profiles[profileName] !== undefined;

    if (!alreadyAuthed) {
      // Hand off to the canonical login flow. `cmdLogin` re-resolves base-url
      // + org from the same flag/env precedence and persists the profile; it
      // needs a project to bind, so seed K9O_PROJECT if the operator gave one
      // (login requires a project slug currently). If none was supplied yet we
      // cannot login non-interactively, so require it here.
      const loginProject = await resolveRequired(
        args.flags["project"],
        process.env["K9O_PROJECT"],
        "--project",
        "Project slug to sign in against (an existing project on this org): ",
        format,
      );
      // Compose explicit flags for the login hand-off so it does not depend on
      // ambient env that may differ from what we resolved above.
      const loginArgs: ParsedArgs = {
        positional: ["login"],
        flags: {
          ...args.flags,
          "base-url": baseUrl,
          org: orgSlug,
          project: loginProject,
        },
      };
      const loginCode = await cmdLogin(loginArgs);
      if (loginCode !== EXIT_SUCCESS) {
        // cmdLogin already emitted the KError to the right stream.
        return loginCode;
      }
    }

    // ---- 3. Pick an existing project or scaffold a new one ---------------
    // Build an authenticated client from the now-present profile. Bind the
    // resolved base-url/org explicitly via flags so the client matches intent.
    const clientArgs: ParsedArgs = {
      positional: args.positional,
      flags: { ...args.flags, "base-url": baseUrl, org: orgSlug },
    };
    const { client } = clientFromProfile(clientArgs);

    const explicitProject = args.flags["project"] ?? process.env["K9O_PROJECT"];
    let chosenSlug: string;
    let created = false;

    if (explicitProject !== undefined && explicitProject.length > 0) {
      // Operator named a project up front — honour it without prompting, but
      // validate the slug format so a typo fails fast (here, not at the server).
      validateSlug(explicitProject, "project");
      chosenSlug = explicitProject;
    } else {
      const listEnvelope = await client.projects.list();
      const projects = listEnvelope.data;
      if (format === "json") {
        // Non-interactive: cannot prompt for a pick. Require --project.
        throw new KError({
          code: "K9O_MISSING_PROJECT_CONTEXT",
          message: "k9o init in --output json mode requires --project (no interactive project pick)",
          context: { available: projects.map((p) => p.slug) },
          recommendation: "Re-run with --project <slug> (or K9O_PROJECT) to select or scaffold a project.",
        });
      }
      if (projects.length > 0) {
        process.stdout.write("Existing projects on this org:\n");
        projects.forEach((p, i) => {
          process.stdout.write(`  ${String(i + 1).padStart(2)}. ${p.slug}  (${p.name})\n`);
        });
        process.stdout.write("  Or enter a NEW slug to scaffold a project.\n");
      } else {
        process.stdout.write("No projects yet on this org. Enter a slug to scaffold your first one.\n");
      }
      // Loop the pick so a malformed new-slug re-prompts instead of aborting.
      let resolved: string | undefined;
      for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS && resolved === undefined; attempt++) {
        const pick = await readLineFromStdin("Project (number or new slug): ");
        if (pick.length === 0) {
          process.stdout.write("  Pick a number, an existing slug, or a new slug to scaffold.\n");
          continue;
        }
        // A bare integer in range selects an existing project; an existing slug
        // selects it as-is; anything else is treated as a new slug to scaffold.
        const asIndex = Number(pick);
        if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= projects.length) {
          resolved = projects[asIndex - 1]!.slug;
        } else if (projects.some((p) => p.slug === pick)) {
          resolved = pick;
        } else {
          try {
            validateSlug(pick, "project");
          } catch (e) {
            process.stdout.write(`  ${e instanceof KError ? e.message : String(e)}\n`);
            continue;
          }
          const name = (await readLineFromStdin(`Display name for "${pick}" [${pick}]: `)) || pick;
          const createEnvelope = await client.projects.create({ slug: pick, name });
          resolved = createEnvelope.data.slug;
          created = true;
        }
      }
      if (resolved === undefined) {
        throw new KError({
          code: "K9O_MISSING_PROJECT_CONTEXT",
          message: "no project selected",
          context: {},
          recommendation: "Run `k9o init` again and pick an existing project or enter a valid new slug.",
        });
      }
      chosenSlug = resolved;
    }

    // ---- 4. Persist baseUrl/orgSlug + activeProjectSlug (set-active) ------
    const creds = readCredentials(args.flags["credentials-file"]);
    const profile = creds.profiles[profileName];
    if (profile === undefined) {
      // Should not happen — login above (or pre-existing auth) guarantees it.
      throw new KError({
        code: "UNAUTHENTICATED",
        message: `No credentials for profile "${profileName}" after init. Run \`k9o login\` first.`,
        context: { profile: profileName },
        recommendation: "k9o login --base-url <url> --org <slug> --project <slug>",
      });
    }
    profile.baseUrl = baseUrl;
    profile.orgSlug = orgSlug;
    profile.activeProjectSlug = chosenSlug;
    creds.current = profileName;
    writeCredentials(creds, args.flags["credentials-file"]);

    // ---- 5. Report + next steps ------------------------------------------
    emitSuccess(
      format,
      {
        data: {
          profile: profileName,
          baseUrl,
          orgSlug,
          activeProjectSlug: chosenSlug,
          projectCreated: created,
        },
        meta: {},
      },
      (d) => {
        const lines = [
          `Workspace ready (profile "${d.profile}").`,
          `  org:     ${d.orgSlug}`,
          `  project: ${d.activeProjectSlug}${d.projectCreated ? " (created)" : ""}`,
          `  gateway: ${d.baseUrl}`,
          "",
          "Next steps:",
          "  k9o whoami                 confirm your active identity",
          "  k9o project list           see all projects on this org",
          "  k9o function list          list deployed functions on the active project",
        ];
        return lines.join("\n");
      },
    );
    return EXIT_SUCCESS;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}
