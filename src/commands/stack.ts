/**
 * `k9o stack` — local dev stack orchestration.
 *
 * REQUIRES `run.sh` from a k9o-core checkout. The npm package does not ship
 * it, so outside a checkout the command prints which dependency is missing and
 * exits. This command WRAPS, it does not reinvent: every verb shells out to
 * `run.sh stack …` (the compose spine + host-side health-gating + the
 * crypto-tier split). The CLI owns ergonomics only — flag→arg mapping, run.sh
 * resolution, and structured output — and re-encodes NONE of the
 * compose/env/crypto logic, so the dev-fallback vs `--full` (real vault-ops)
 * split ships verbatim: `stack up` → `run.sh stack up`, `--full` →
 * `run.sh stack up --full`.
 *
 *   - k9o stack up [--minimal|--ai|--full]   bring the stack up (tiers superset-ordered)
 *   - k9o stack down                          stop (keep volumes)
 *   - k9o stack nuke [--yes]                  teardown + volume wipe
 *   - k9o stack status                        health/endpoint map
 *   - k9o stack logs [service]                tail logs
 *
 * `k9o up` is a top-level alias for `k9o stack up`.
 *
 * Output: chatty pass-through (inherited stdio) by default; `--output json`
 * passes `--json` through to run.sh (machine-readable endpoint/status map — the
 * run.sh `status --json` contract).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, EXIT_LOCAL_CONFIG, EXIT_GENERIC } from "../exit-codes.ts";

const STACK_VERBS = new Set(["up", "down", "nuke", "status", "logs"]);
const TIER_FLAGS = ["minimal", "ai", "full"] as const;

/**
 * Locate the dev stack's `run.sh` orchestration. Resolution order:
 *   1. `K9O_RUNSH_PATH` explicit override,
 *   2. a copy placed at `<pkg>/vendor/run.sh` (not part of the npm package),
 *   3. a k9o-core checkout found by walking up from cwd (run.sh next to
 *      `infra/docker-compose.yml`).
 */
export function resolveRunSh(): string | null {
  const override = process.env.K9O_RUNSH_PATH;
  if (override && existsSync(override)) return override;

  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, "..", "vendor", "run.sh");
  if (existsSync(bundled)) return bundled;

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, "run.sh");
    if (existsSync(cand) && existsSync(join(dir, "infra", "docker-compose.yml"))) {
      return cand;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The one-line error for a command that needs `run.sh` when none can be found.
 * Shared by `stack`, `showroom` and `up`.
 */
export function runShMissingError(command: string): KError {
  return new KError({
    code: "K9O_DEVPROXY_BACKEND_NOT_FOUND",
    message:
      `\`k9o ${command}\` needs run.sh from a k9o-core checkout, which the npm package does not ship; run it inside a checkout or set K9O_RUNSH_PATH.`,
    context: { dependency: "run.sh (k9o-core checkout)" },
  });
}

/** Map `(verb, flags, positionals)` → the `run.sh` argv. Exported for tests. */
export function buildRunShArgs(args: ParsedArgs, jsonOutput: boolean): string[] {
  const verb = args.positional[1]!;
  const out: string[] = ["stack", verb];
  if (verb === "up") {
    for (const t of TIER_FLAGS) {
      if (args.flags[t] === "true") out.push(`--${t}`);
    }
  }
  if (verb === "nuke" && args.flags["yes"] === "true") out.push("--yes");
  if (verb === "logs" && args.positional[2]) out.push(args.positional[2]!);
  // `--json` is honored by run.sh `status`/`up`;
  // harmless passthrough on verbs that ignore it.
  if (jsonOutput) out.push("--json");
  return out;
}

function printStackHelp(): void {
  process.stdout.write(`
k9o stack — manage the local dev stack

Needs run.sh from a k9o-core checkout (not shipped in the npm package): run it
inside a checkout or set K9O_RUNSH_PATH.

USAGE
  k9o stack <verb> [--minimal | --ai | --full] [--yes] [service]
  k9o up                        Alias for \`k9o stack up\`

VERBS
  up [--minimal|--ai|--full]    Bring the stack up (tiers are a superset — see below)
  down                          Stop the stack (keeps volumes)
  nuke [--yes]                  Tear the stack down and wipe volumes
  status                        Print the health/endpoint map
  logs [service]                Tail logs (all services, or one by name)

TIERS (--minimal|--ai|--full, default = neither = the standard set)
  --minimal                     Gateway + Postgres only
  --ai                          + local model inference
  --full                        + real vault-ops custody (never the dev fallback)
`.trim() + "\n");
}

export async function dispatchStack(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const verb = args.positional[1];

  if (args.flags["help"] === "true") {
    printStackHelp();
    return EXIT_SUCCESS;
  }

  if (verb === undefined || !STACK_VERBS.has(verb)) {
    emitError(
      format,
      new KError({
        code: "CLI_USAGE",
        message: "usage: k9o stack <up|down|nuke|status|logs> [--minimal|--ai|--full]",
        context: { verb: verb ?? null },
      }),
    );
    return EXIT_USAGE;
  }

  const runsh = resolveRunSh();
  if (!runsh) {
    emitError(format, runShMissingError("stack"));
    return EXIT_LOCAL_CONFIG;
  }

  const runArgs = buildRunShArgs(args, format === "json");
  // JSON: capture stdout (the machine-readable map) + forward stderr live.
  // Default: inherit all stdio for the chatty, informative dev-loop UX.
  const result = spawnSync("bash", [runsh, ...runArgs], {
    stdio: format === "json" ? ["inherit", "pipe", "inherit"] : "inherit",
    env: { ...process.env },
  });

  if (format === "json" && result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.error) {
    emitError(
      format,
      new KError({
        code: "K9O_DEVPROXY_EXEC_FAILED",
        message: `failed to run orchestration: ${result.error.message}`,
        context: {},
      }),
    );
    return EXIT_GENERIC;
  }
  return result.status ?? EXIT_GENERIC;
}
