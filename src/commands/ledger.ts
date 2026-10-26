/**
 * `k9o ledger verify` — offline audit-ledger integrity verification.
 *
 * THIN LAUNCHER, ZERO VERIFICATION LOGIC. The only verification implementation
 * in existence is the Rust `kibo-ledger-verify` crate's `[[bin]]`, built
 * strictly to the Code-Point Profile. This command maps its args to that
 * binary's invocation contract, spawns it, pipes stdout/stderr through
 * verbatim, and propagates its exit code.
 *
 * Reimplementing verification in TypeScript is forbidden: a second
 * first-party verifier is exactly the two-verifiers-can-disagree drift the
 * single-core discipline exists to prevent.
 *
 * Binary contract:
 *   kibo-ledger-verify (--file <ledger> | --stdin)
 *                      [--key-set <keyset>] [--signature <base64|@path>]
 *                      [--format json|ndjson]
 *   --key-set + --signature are OPTIONAL but MUST be supplied together:
 *     both     → Step-5 platform-signature verification runs (RSASSA-PKCS1
 *                over the raw input bytes); the verdict's `signature.checked`
 *                is true.
 *     neither  → chain integrity (Steps 1–4) still fully verified; the
 *                offline saved-file auditor case. `signature.checked` false.
 *   --format omitted → the binary auto-detects (leading `[` ⇒ JSON, else NDJSON).
 *   stdout = the JSON verdict (verbatim machine contract)
 *   stderr = human diagnostics only (never the machine result)
 *   exit 0 = verified | 1 = verification failed (tamper/mismatch/signature)
 *        2 = operational error before a verdict (bad args / IO / parse)
 *
 * Binary resolution order:
 *   1. $K9O_LEDGER_VERIFY_BIN          explicit override (dev / CI)
 *   2. a prebuilt at                   <cli>/vendor/<platform>-<arch>/kibo-ledger-verify (not part of the npm package)
 *   3. `kibo-ledger-verify` on $PATH   standalone-install case
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { emitError, resolveOutputFormat } from "../output.ts";
import { EXIT_SUCCESS, EXIT_USAGE } from "../exit-codes.ts";

const BIN_NAME = "kibo-ledger-verify";

function printLedgerHelp(): void {
  process.stdout.write(`
k9o ledger — offline audit-ledger integrity verification

Needs the kibo-ledger-verify binary, which the npm package does not ship: put
it on PATH or set K9O_LEDGER_VERIFY_BIN.

USAGE
  k9o ledger verify (--file <ledger> | --stdin) [--key-set <keyset> --signature <sig>] [--format json|ndjson]

  --key-set + --signature are optional but must be supplied together — when
  both are given, platform-signature verification also runs; otherwise only
  chain integrity is checked (the offline saved-file auditor case).
`.trim() + "\n");
}

export async function dispatchLedger(args: ParsedArgs): Promise<number> {
  const sub = args.positional[1];
  const format = resolveOutputFormat(args.flags);
  if (sub === undefined || args.flags["help"] === "true") {
    printLedgerHelp();
    return sub === undefined ? EXIT_USAGE : EXIT_SUCCESS;
  }
  if (sub === "verify") return cmdLedgerVerify(args);
  emitError(format, new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message: `unknown ledger subcommand "${sub}"`,
    context: { sub },
    recommendation: "Valid: verify",
  }));
  return EXIT_USAGE;
}

function cmdLedgerVerify(args: ParsedArgs): number {
  const format = resolveOutputFormat(args.flags);

  const file = args.flags["file"];
  const stdin = args.flags["stdin"] === "true";
  const keySet = args.flags["key-set"];
  const signature = args.flags["signature"];
  const fmt = args.flags["format"];

  // Source: --file XOR --stdin.
  if (file !== undefined && stdin) {
    emitError(format, usageError("pass either --file <ledger> or --stdin, not both"));
    return EXIT_USAGE;
  }
  if (file === undefined && !stdin) {
    emitError(format, usageError("k9o ledger verify requires --file <ledger> or --stdin"));
    return EXIT_USAGE;
  }
  // --key-set + --signature are optional, but must be supplied together:
  // with both, platform-signature verification (Step 5) runs; with neither,
  // chain integrity (Steps 1–4) is still fully verified — the offline
  // saved-file auditor case. One without the other is a usage error.
  if ((keySet === undefined) !== (signature === undefined)) {
    emitError(format, usageError("--key-set and --signature must be supplied together (both enable platform-signature verification; omit both for chain-integrity-only)"));
    return EXIT_USAGE;
  }
  if (fmt !== undefined && fmt !== "json" && fmt !== "ndjson") {
    emitError(format, usageError(`--format must be json | ndjson (got "${fmt}")`));
    return EXIT_USAGE;
  }

  const bin = resolveBinary();
  if (bin === null) {
    emitError(format, new KError({
      code: "CLI_LEDGER_VERIFY_BIN_MISSING",
      message: `\`k9o ledger verify\` needs the ${BIN_NAME} binary, which the npm package does not ship; put it on PATH or set K9O_LEDGER_VERIFY_BIN.`,
      context: { searched: ["$K9O_LEDGER_VERIFY_BIN", "vendor/", "$PATH"], dependency: BIN_NAME },
    }));
    return EXIT_USAGE; // operational error before a verdict → exit 2
  }

  // Build the binary's argv per the binary's argument contract. Flag names mirror ours,
  // so this is a pure pass-through map.
  const binArgs: string[] = [];
  if (stdin) binArgs.push("--stdin");
  else binArgs.push("--file", file!);
  if (keySet !== undefined) binArgs.push("--key-set", keySet);
  if (signature !== undefined) binArgs.push("--signature", signature);
  if (fmt !== undefined) binArgs.push("--format", fmt);

  // stdio: inherit all three so the stdout verdict and stderr diagnostics
  // pass through byte-for-byte (and --stdin reads the caller's stdin). No
  // re-encoding in the launcher.
  const result = spawnSync(bin, binArgs, { stdio: ["inherit", "inherit", "inherit"] });

  if (result.error !== undefined) {
    emitError(format, new KError({
      code: "CLI_LEDGER_VERIFY_SPAWN_FAILED",
      message: `failed to launch ${BIN_NAME}: ${result.error.message}`,
      context: { bin },
      recommendation: "Confirm the verifier binary is executable for this platform.",
    }));
    return EXIT_USAGE; // could not run → exit 2
  }

  // Propagate the verifier's exit code verbatim (0 verified / 1 failed /
  // 2 operational), per the binary's exit-code contract. Signal-terminated → 2.
  return result.status ?? EXIT_USAGE;
}

function usageError(message: string): KError {
  return new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message,
    context: {},
    recommendation: "k9o ledger verify (--file <ledger> | --stdin) [--key-set <keyset> --signature <base64|@path>] [--format json|ndjson]",
  });
}

/**
 * Locate the self-contained verifier binary. Returns its path, or null if
 * no candidate exists on any of the three resolution channels.
 */
function resolveBinary(): string | null {
  const override = process.env["K9O_LEDGER_VERIFY_BIN"];
  if (override !== undefined && override.length > 0 && existsSync(override)) return override;

  const exe = process.platform === "win32" ? `${BIN_NAME}.exe` : BIN_NAME;
  const platformArch = `${process.platform}-${process.arch}`;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist layout: <cli>/dist/index.js → ../vendor; src layout: <cli>/src/commands → ../../vendor
    for (const rel of [
      join(here, "..", "vendor", platformArch, exe),
      join(here, "..", "..", "vendor", platformArch, exe),
    ]) {
      if (existsSync(rel)) return rel;
    }
  } catch {
    // import.meta.url not resolvable — fall through to PATH.
  }

  // PATH lookup (standalone-install case): probe with --version.
  const probe = spawnSync(exe, ["--version"], { stdio: "ignore" });
  if (probe.error === undefined && probe.status !== null) return exe;

  return null;
}
