/**
 * `k9o showroom` — provision a vertical showroom into the local dev stack
 * The dev-facing substrate verb: showroom
 * screenplays are richer + vertical-organized, so devs provision exactly the
 * use-case they want (the generic demo seed is internal-only, never a CLI verb).
 *
 *   - k9o showroom list           list the available verticals
 *   - k9o showroom <slug>         provision org + project + the vertical, print creds
 *
 * Wraps the local dev stack's `run.sh showroom …` (which shells `scripts/seed-showroom.ts`).
 * `--output json` passes `--json` through → the seeder emits a single
 * `{ org, project, ownerEmail, pat, endpoints }` object.
 */

import { spawnSync } from "node:child_process";

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE, EXIT_LOCAL_CONFIG, EXIT_GENERIC } from "../exit-codes.ts";
import { resolveRunSh } from "./stack.ts";

function printShowroomHelp(): void {
  process.stdout.write(`
k9o showroom — provision a demo/showroom project into the local dev stack

USAGE
  k9o showroom list             List the available verticals
  k9o showroom <slug>           Provision org + project + that vertical's data, print creds
`.trim() + "\n");
}

export async function dispatchShowroom(args: ParsedArgs): Promise<number> {
  const format = resolveOutputFormat(args.flags);
  const target = args.positional[1];

  if (target === undefined || args.flags["help"] === "true") {
    printShowroomHelp();
    return target === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }

  const runsh = resolveRunSh();
  if (!runsh) {
    emitError(
      format,
      new KError({
        code: "K9O_DEVPROXY_BACKEND_NOT_FOUND",
        message:
          "DevProxy orchestration (run.sh) not found. Set K9O_RUNSH_PATH, use a k9o build that bundles it, or run inside a k9o-core checkout.",
        context: {},
      }),
    );
    return EXIT_LOCAL_CONFIG;
  }

  const runArgs = ["showroom", target];
  // `list` is human/json either way; for a provision, pass --json so the seeder
  // emits the structured creds object instead of the human block.
  if (format === "json" && target !== "list") runArgs.push("--json");

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
