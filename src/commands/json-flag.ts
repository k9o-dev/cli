/** Shared helpers for the approvals commands: usage errors, whole-number flags and JSON object flags. */

import { KError } from "@k9o/core";
import type { ParsedArgs } from "../args.ts";
import { emitError, type OutputFormat } from "../output.ts";
import { EXIT_USAGE } from "../exit-codes.ts";

export function usageError(format: OutputFormat, message: string, recommendation?: string): number {
  emitError(format, new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message,
    context: {},
    ...(recommendation !== undefined ? { recommendation } : {}),
  }));
  return EXIT_USAGE;
}

/** A whole-number flag in [min, max]: undefined when absent, an error message string when invalid. */
export function intFlag(args: ParsedArgs, name: string, min: number, max: number): number | undefined | string {
  const raw = args.flags[name];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) return `--${name} must be a whole number from ${min} to ${max}`;
  return Number(raw);
}

/** A flag holding a JSON object: the parsed object, undefined when absent, or an error message string. */
export function jsonObjectFlag(args: ParsedArgs, name: string): Record<string, unknown> | undefined | string {
  const raw = args.flags[name];
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `--${name} must be a JSON object`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return `--${name} must be a JSON object`;
  return parsed as Record<string, unknown>;
}

/** A string flag that must carry a value (a bare `--name` parses as "true"). */
export function textFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return v === undefined || v === "true" ? undefined : v;
}
