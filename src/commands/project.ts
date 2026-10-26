/**
 * `k9o project` subcommands — list / create / get / set-active.
 *
 * Wire to `client.projects.*`: GET/POST /projects, GET /projects/{slug}. The
 * gateway names a project's display field `displayName`.
 */

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { clientFromProfile } from "./auth.ts";
import { emitSuccess, emitError, resolveOutputFormat } from "../output.ts";
import { readCredentials, writeCredentials, resolveActiveProfile } from "../config-store.ts";
import { EXIT_SUCCESS, EXIT_USAGE, exitCodeForError } from "../exit-codes.ts";
import { wire, type WireProject } from "../wire.ts";

const CUSTODY_MODES = ["PLATFORM_MANAGED", "SKR", "BYOK", "HYOK"] as const;
type CustodyMode = (typeof CUSTODY_MODES)[number];

function printProjectHelp(): void {
  process.stdout.write(`
k9o project — create, list, and switch between projects

USAGE
  k9o project <subcommand> [args...] [flags...]

SUBCOMMANDS
  list                         List projects accessible to the caller
  create <slug> [--name <display name>] [--region <code>] [--custody-mode PLATFORM_MANAGED|SKR|BYOK|HYOK]
                               Create a new project (display name defaults to the slug)
  get <slug>                   Get a project by slug
  set-active <slug>            Set the active project for this profile
`.trim() + "\n");
}

export async function dispatchProject(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printProjectHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  try {
    if (sub === "list") return await cmdProjectList(args);
    if (sub === "create") return await cmdProjectCreate(args);
    if (sub === "get") return await cmdProjectGet(args);
    if (sub === "set-active") return await cmdProjectSetActive(args);
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown project subcommand "${sub}"`,
      context: { sub },
      recommendation: "Valid: list | create | get | set-active",
    }));
    return EXIT_USAGE;
  } catch (e) {
    emitError(format, e);
    return exitCodeForError(e);
  }
}

async function cmdProjectList(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const { client } = clientFromProfile(args);
  const envelope = wire<ReadonlyArray<WireProject>>(await client.projects.list());
  emitSuccess(format, envelope, (projects) => {
    if (projects.length === 0) return "No projects.";
    const rows = projects.map((p) =>
      `  ${p.slug.padEnd(30)}  ${p.displayName.padEnd(40)}  ${p.custodyMode.padEnd(17)}  ${p.region.padEnd(6)}  ${p.id}`,
    );
    return ["Projects:", ...rows].join("\n");
  });
  return EXIT_SUCCESS;
}

async function cmdProjectCreate(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.flags["slug"] ?? args.positional[2];
  if (slug === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o project create requires --slug <slug> (positional or flag)",
      context: {},
      recommendation: "k9o project create my-project --name 'My Project'",
    }));
    return EXIT_USAGE;
  }
  // Computed after the guard so `slug` is narrowed to string (display name falls back to slug).
  const displayName = args.flags["name"] ?? slug;
  const custodyInput = args.flags["custody-mode"];
  if (custodyInput !== undefined && !(CUSTODY_MODES as ReadonlyArray<string>).includes(custodyInput)) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `invalid --custody-mode "${custodyInput}"`,
      context: { custodyMode: custodyInput },
      recommendation: `Valid: ${CUSTODY_MODES.join(" | ")}`,
    }));
    return EXIT_USAGE;
  }
  const custodyMode = custodyInput as CustodyMode | undefined;
  const region = args.flags["region"];
  const { client } = clientFromProfile(args);
  const envelope = wire<WireProject>(await client.projects.create({
    slug,
    displayName,
    ...(custodyMode !== undefined ? { custodyMode } : {}),
    ...(region !== undefined ? { region } : {}),
  }));
  emitSuccess(format, envelope, (p) =>
    `Created project ${p.slug} (${p.id}) — name="${p.displayName}" custody=${p.custodyMode} region=${p.region}`,
  );
  return EXIT_SUCCESS;
}

async function cmdProjectGet(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.flags["slug"] ?? args.positional[2];
  if (slug === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o project get requires <slug> (positional)",
      context: {},
      recommendation: "k9o project get member-portal",
    }));
    return EXIT_USAGE;
  }
  const { client } = clientFromProfile(args);
  const envelope = wire<WireProject>(await client.projects.get(slug));
  emitSuccess(format, envelope, (p) =>
    `Project ${p.slug} (${p.id})\n  name: ${p.displayName}\n  custody: ${p.custodyMode}\n  region: ${p.region}\n  status: ${p.status}\n  org: ${p.orgId}\n  created: ${p.createdAt}`,
  );
  return EXIT_SUCCESS;
}

async function cmdProjectSetActive(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const slug = args.positional[2];
  if (slug === undefined) {
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: "k9o project set-active requires <slug> (positional)",
      context: {},
      recommendation: "k9o project set-active member-portal",
    }));
    return EXIT_USAGE;
  }
  // Persist locally; no API call needed.
  const creds = readCredentials(args.flags["credentials-file"]);
  const profileName = resolveActiveProfile(args.flags, creds);
  const profile = creds.profiles[profileName];
  if (profile === undefined) {
    throw new KError({
      code: "UNAUTHENTICATED",
      message: `No credentials for profile "${profileName}". Run \`k9o login\` first.`,
      context: { profile: profileName },
    });
  }
  profile.activeProjectSlug = slug;
  writeCredentials(creds, args.flags["credentials-file"]);
  emitSuccess(format, { data: { profile: profileName, activeProjectSlug: slug }, meta: {} },
    (d) => `Active project set to "${d.activeProjectSlug}" for profile "${d.profile}".`);
  return EXIT_SUCCESS;
}
