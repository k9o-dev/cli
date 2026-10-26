/**
 * Argument parser for the `k9o` CLI.
 *
 * Common flags + per-command flag conventions. Long-form
 * flags are canonical (`--project`, `--output`); short-form is permitted
 * for `-q` / `-v` / `-h`.
 *
 * Returns:
 *   - `positional`: ordered list of non-flag arguments
 *   - `flags`: map of flag name → value (string for `--key value`; "true" for boolean flags)
 *   - `subcommand`: convenience accessor for `positional[0]` (the command verb)
 */

export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string>;
};

const SHORT_FLAGS: Record<string, string> = {
  q: "quiet",
  v: "verbose",
  h: "help",
};

/**
 * Boolean flags — those that take no value. If the next argument is
 * present, it's parsed as a positional, not consumed as the flag value.
 */
const BOOLEAN_FLAGS = new Set([
  "help",
  "quiet",
  "verbose",
  "no-color",
  "draft",
  "watch",
  "tail",
  // storage buckets and objects: switches that never take a value
  "empty",
  "upsert",
  "download",
  "stdin",
  // switches that never take a value
  "enable",
  "disable",
  "disabled",
  "yes",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    let key: string | null = null;

    if (a.startsWith("--")) {
      key = a.slice(2);
    } else if (a.startsWith("-") && a.length === 2) {
      const short = a.slice(1);
      key = SHORT_FLAGS[short] ?? short;
    }

    if (key !== null) {
      // Handle `--key=value` form
      const eqIdx = key.indexOf("=");
      if (eqIdx !== -1) {
        const k = key.slice(0, eqIdx);
        const v = key.slice(eqIdx + 1);
        flags[k] = v;
        continue;
      }
      // Boolean flag — don't consume next arg
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = "true";
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/**
 * Validate that all required flags are present. Returns the missing ones
 * (empty array if all present).
 */
export function requireFlags(args: ParsedArgs, required: string[]): string[] {
  return required.filter((f) => args.flags[f] === undefined);
}
