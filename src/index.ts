#!/usr/bin/env bun
/**
 * `k9o` — the Kilimanjaro CLI.
 *
 * Top-level help (`k9o --help`) lists command GROUPS only, one line each;
 * every group prints its own subcommand detail via `k9o <group> --help`
 * (mirrors `k9o ext-admin --help` / `k9o ext --help`, the two groups this
 * pattern started on). Keep it that way — a flat dump of every subcommand
 * on one screen is what this file used to do, and it stopped being readable
 * once the surface grew past ~6 groups.
 */

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import pkg from "../package.json";
import { parseArgs } from "./args.ts";
import { setColorMode, emitError, resolveOutputFormat } from "./output.ts";
import { EXIT_USAGE, EXIT_GENERIC } from "./exit-codes.ts";
import { KError } from "@k9o/core";
import { cmdLogin, cmdLogout, cmdWhoami } from "./commands/auth.ts";
import { dispatchProject } from "./commands/project.ts";
import { dispatchByosCred } from "./commands/byos-cred.ts";
import { dispatchStorage } from "./commands/storage.ts";
import { dispatchAi } from "./commands/ai.ts";
import { dispatchVaultSecret } from "./commands/vault-secret.ts";
import { dispatchMigration } from "./commands/migration.ts";
import { dispatchFunction } from "./commands/function.ts";
import { dispatchPolicy } from "./commands/policy.ts";
import { dispatchAudit } from "./commands/audit.ts";
import { dispatchOrg } from "./commands/org.ts";
import { dispatchMe } from "./commands/me.ts";
import { dispatchConfig } from "./commands/config.ts";
import { dispatchExtAdmin } from "./commands/ext-admin.ts";
import { dispatchExt } from "./commands/ext.ts";
import { dispatchLedger } from "./commands/ledger.ts";
import { dispatchStack } from "./commands/stack.ts";
import { dispatchShowroom } from "./commands/showroom.ts";
import { dispatchDoctor } from "./commands/doctor.ts";
import { dispatchInit } from "./commands/init.ts";
import { dispatchCompletion } from "./commands/completion.ts";

// Single source of truth: the published package version. Inlined at build time
// by the bundler; read live from package.json when run from source in dev.
const CLI_VERSION = pkg.version;
const API_MAJOR = "v2";

function printHelp(): void {
  process.stdout.write(`
k9o — the Kilimanjaro CLI (${CLI_VERSION} api/${API_MAJOR})

USAGE
  k9o <command> [<subcommand>] [args...] [flags...]
  k9o <command> --help              Show detail + subcommands for <command>

GETTING STARTED
  init                         Interactive setup — auth + pick an active project
  login                        Sign in to a Kilimanjaro project
  logout                       Clear local credentials
  whoami                       Print the active identity

PROJECT RESOURCES
  project                      Create, list, and switch between projects
  byos-cred                    Pre-create a BYOS cloud credential (kibo://byos-creds/<id>)
  storage                      Manage storage locations (your own object stores): storage locations list|create|get|update|retire|test
  ai                           Platform AI primitives: ai embed <text>... | --file <path|->
  vault-secret                 Vault secrets — list/get/create/reveal/update/rotate/move/delete
  migration                    Apply + inspect schema migrations
  function                     Deploy, invoke, and manage serverless functions
  policy                       Manage policy bundles
  audit                        Query and export project audit events
  ext-admin                    Install, enable, and configure extensions
  ext                          Run a specific extension's own commands

ORG & ACCOUNT
  org                          Org-level resources — members, groups, roles, SMTP, IdP
  me                           Your own operator profile, sessions, and tokens

LOCAL DEV
  stack                        Manage the local dev stack (up/down/status/logs)
  showroom                     Provision a demo/showroom project
  doctor                       Check your local dev environment for issues

UTILITY
  config                       Local CLI profile config
  ledger                       Offline audit-ledger integrity verification
  completion                   Emit a shell completion script (bash|zsh|fish)

COMMON FLAGS
  --project <slug>             Project context override
  --org <slug>                 Org context override
  --output human | json        Output format (default: human)
  --no-color                   Disable ANSI colors
  --quiet / -q                 Suppress non-essential output
  --verbose / -v               Emit debug diagnostics
  --profile <name>             Profile selector (default: "default")
  --help / -h                  Show help

ENVIRONMENT
  K9O_BASE_URL                 Default --base-url for login
  K9O_ORG                      Default --org for login + commands
  K9O_PROJECT                  Default --project for login + commands
  K9O_PROFILE                  Default --profile selector
  K9O_OUTPUT                   Default --output format (human | json)

EXAMPLES
  k9o login --base-url https://acme.api.k9o.io --org acme --project member-portal
  k9o project list --output json
  k9o migration apply migrations.json
  k9o function invoke compute --payload '{"x":1,"y":2}'

  --output json emits the SDK wire shape verbatim ({data, meta} on success;
  {code, message, context, recommendation} on failure). Human output is
  best-effort pretty-print; do NOT parse it programmatically.
`.trim() + "\n");
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  // --no-color
  if (args.flags["no-color"] === "true") setColorMode(false);

  // --version (check before help so `--version` alone returns 0, not 1)
  if (args.flags["version"] === "true" || args.positional[0] === "--version") {
    process.stdout.write(`k9o/${CLI_VERSION} api/${API_MAJOR}\n`);
    return 0;
  }

  // No positional command at all — `k9o` bare or `k9o --help`. `k9o <command>
  // --help` must fall through to that command's own dispatcher below, so its
  // group-specific help prints instead of this top-level summary.
  if (args.positional.length === 0) {
    printHelp();
    return args.flags["help"] === "true" ? 0 : 1;
  }

  const cmd = args.positional[0]!;

  try {
    if (cmd === "login") return await cmdLogin(args);
    if (cmd === "logout") return await cmdLogout(args);
    if (cmd === "whoami") return await cmdWhoami(args);
    if (cmd === "project") return await dispatchProject(args);
    if (cmd === "byos-cred") return await dispatchByosCred(args);
    if (cmd === "storage") return await dispatchStorage(args);
    if (cmd === "ai") return await dispatchAi(args);
    if (cmd === "vault-secret") return await dispatchVaultSecret(args);
    if (cmd === "migration") return await dispatchMigration(args);
    if (cmd === "function") return await dispatchFunction(args);
    if (cmd === "policy") return await dispatchPolicy(args);
    if (cmd === "audit") return await dispatchAudit(args);
    if (cmd === "org") return await dispatchOrg(args);
    if (cmd === "me") return await dispatchMe(args);
    if (cmd === "config") return await dispatchConfig(args);
    if (cmd === "ext-admin" || cmd === "extension-admin") return await dispatchExtAdmin(args);
    if (cmd === "ext" || cmd === "extension") return await dispatchExt(args);
    if (cmd === "ledger") return await dispatchLedger(args);
    if (cmd === "stack") return await dispatchStack(args);
    // `k9o up` is a top-level alias for `k9o stack up`.
    if (cmd === "up") {
      return await dispatchStack({
        positional: ["stack", "up", ...args.positional.slice(1)],
        flags: args.flags,
      });
    }
    if (cmd === "showroom") return await dispatchShowroom(args);
    if (cmd === "doctor") return await dispatchDoctor(args);
    if (cmd === "init") return await dispatchInit(args);
    if (cmd === "completion") return await dispatchCompletion(args);

    // Unknown command
    const format = resolveOutputFormat(args.flags);
    emitError(format, new KError({
      code: "K9O_INVALID_FIELD_VALUE",
      message: `unknown command "${cmd}"`,
      context: { cmd },
      recommendation: "Run `k9o --help` to see the available commands.",
    }));
    return EXIT_USAGE;
  } catch (e) {
    const format = resolveOutputFormat(args.flags);
    emitError(format, e);
    return EXIT_GENERIC;
  }
}

/**
 * Run `main` only when this module is the process entry point — never on
 * import (the package also exports `.` for programmatic use). Portable
 * across Bun + Node: compare the resolved entry path (`process.argv[1]`)
 * against this module's own file URL. `import.meta.main` was Bun-only and
 * broke under the Node-targeted bundle (item B), so we use the
 * argv-vs-module-URL comparison that both runtimes honour.
 *
 * BOTH sides are resolved through `realpathSync` before comparison: when the
 * CLI is installed via npm, `k9o` is a symlink in the global bin dir, so
 * `process.argv[1]` is the symlink path while `import.meta.url` resolves to
 * the real `dist/index.js` — a raw `===` would never match and `main()` would
 * silently never run (also bites macOS `/var`→`/private/var`). realpath on
 * both collapses every symlink layer so the entry check is hardlink-stable.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const argv = realpathSync(entry);
    return self === argv;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exit(EXIT_GENERIC);
    });
}
