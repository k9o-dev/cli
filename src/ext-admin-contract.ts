/**
 * `k9o ext-admin` verb-registration contract (descriptor approach).
 *
 * The `k9o` binary owns the `ext-admin` command tree — grouping,
 * `--help`, aliases, root-guard, dispatch. The `@k9o/extension-cli` toolchain exports
 * an `EXT_ADMIN_VERBS: ExtAdminVerb[]` array built against this contract; the
 * CLI merges those into the one tree under the "Publish & operate" group. The
 * toolchain owns each verb's *logic*; the CLI owns the binary *chrome*.
 * Emit + error mapping flow through `ExtAdminCtx` so registered verbs behave
 * identically to the native "Use" verbs (`list`/`available`/`enable`/…).
 *
 * SemVer: this interface is published and versioned with `@k9o/cli`. The toolchain
 * imports it type-only (`import type { ExtAdminVerb } from "@k9o/cli/ext-admin-contract"`)
 * — types erase at runtime, so the `@k9o/cli` → `@k9o/extension-cli` runtime
 * dependency carries no cycle.
 */

import type { ParsedArgs } from "./args.ts";
import type { OutputFormat } from "./output.ts";

/** A single argument a registered verb accepts (drives `--help` + validation). */
export interface ExtAdminArgSpec {
  name: string;
  summary: string;
  /** CLI ergonomics: a bare positional vs a named `--flag`. */
  position: "positional" | "flag";
  type: "string" | "number" | "boolean" | "json";
  required?: boolean;
}

/**
 * Execution context the `k9o` binary hands a registered verb's `run()`.
 * Everything a publisher verb needs to make its call + emit consistently —
 * without reaching into `@k9o/core` internals.
 */
export interface ExtAdminCtx {
  /** Full parsed args (flags + positionals) for the invocation. */
  args: ParsedArgs;
  /** Positionals after the verb, in order — e.g. `[slug]` or `[submissionId]`. */
  positionals: string[];
  /** Bound calling context, for building Group A/B/C URLs. */
  context: {
    /** Member/data-plane base (e.g. `https://<orgSlug>.api.k9o.io`). */
    baseUrl: string;
    orgSlug?: string | undefined;
    projectSlug?: string | undefined;
  };
  /**
   * `fetch`-compatible function with the caller's bearer auth already
   * injected. Pass an ABSOLUTE URL (the verb knows its own host/plane —
   * Group A `<orgSlug>.api.k9o.io`, Group B `console.k9o.io`). Auth headers
   * are added; any caller-supplied headers are preserved.
   */
  fetchFn: typeof fetch;
  /** Resolved `--output` format. */
  format: OutputFormat;
  /** Emit a success envelope to stdout (format already bound). */
  emitSuccess<T>(envelope: { data: T; meta?: Record<string, unknown> }, render?: (data: T) => string): void;
  /** Emit an error (KError-aware) to stderr (format already bound). */
  emitError(error: unknown): void;
  /** Map a thrown error to its exit code. */
  exitCodeForError(error: unknown): number;
}

/**
 * A publisher/operator verb registered into the `ext-admin` tree by the extension toolchain.
 * `run` performs the operation and returns the process exit code (it should
 * emit via the supplied `ctx`, not write stdout/stderr directly).
 */
export interface ExtAdminVerb {
  /** e.g. "publish" | "install" | "deprecate" | "metrics" | "status" | "logs". */
  verb: string;
  /** One-line description shown under "Publish & operate" in `--help`. */
  summary: string;
  /** Declared args (for `--help` + the CLI's positional extraction). */
  args?: ExtAdminArgSpec[];
  /** Execute the verb; return an exit code (0 success; see exit-codes.ts otherwise). */
  run(ctx: ExtAdminCtx): Promise<number>;
}
