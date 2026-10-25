/**
 * Output formatting — structured-output mode.
 *
 *   - `human` (default): pretty-printed for terminals; non-canonical;
 *     do NOT parse programmatically
 *   - `json`: SDK wire shape verbatim (`{data, meta}` on success;
 *     `{code, message, context, recommendation}` KError shape on
 *     failure to stderr) — canonical for CI / automation consumers
 *
 * Selection via `--output json` flag OR `K9O_OUTPUT=json` env var.
 */

import { KError } from "@k9o/core";

export type OutputFormat = "human" | "json";

export function resolveOutputFormat(flags: Record<string, string>): OutputFormat {
  if (flags["output"] === "json") return "json";
  if (flags["output"] === "human") return "human";
  if (process.env["K9O_OUTPUT"] === "json") return "json";
  return "human";
}

/**
 * Write a success envelope to stdout per the resolved output format.
 */
export function emitSuccess<T>(
  format: OutputFormat,
  envelope: { data: T; meta?: Record<string, unknown> },
  humanRenderer?: (data: T) => string,
): void {
  if (format === "json") {
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return;
  }
  if (humanRenderer !== undefined) {
    const rendered = humanRenderer(envelope.data);
    process.stdout.write(rendered + (rendered.endsWith("\n") ? "" : "\n"));
    return;
  }
  // Fallback human renderer — best-effort pretty print
  process.stdout.write(JSON.stringify(envelope.data, null, 2) + "\n");
}

/**
 * Write a KError to stderr per the resolved output format.
 */
export function emitError(format: OutputFormat, error: unknown): void {
  if (error instanceof KError) {
    if (format === "json") {
      const payload = {
        code: error.code,
        message: error.message,
        context: error.context,
        recommendation: error.recommendation,
        ...(error.requestId !== null ? { requestId: error.requestId } : {}),
      };
      process.stderr.write(JSON.stringify(payload, null, 2) + "\n");
    } else {
      const colored = useColor() && error.code ? `\x1b[31m[${error.code}]\x1b[0m` : `[${error.code}]`;
      process.stderr.write(`${colored} ${error.message}\n`);
      if (error.recommendation !== null) {
        const rec = useColor() ? `\x1b[33m→\x1b[0m ${error.recommendation}` : `→ ${error.recommendation}`;
        process.stderr.write(`${rec}\n`);
      }
    }
    return;
  }
  // Non-KError thrown values — usually programmer errors
  const message = error instanceof Error ? error.message : String(error);
  if (format === "json") {
    process.stderr.write(JSON.stringify({ code: "CLI_INTERNAL_ERROR", message }, null, 2) + "\n");
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
}

/**
 * Whether to emit ANSI color codes. Disabled by `--no-color` flag OR
 * `NO_COLOR` env var OR non-TTY stdout.
 */
let colorOverride: boolean | null = null;
export function setColorMode(useColor: boolean): void {
  colorOverride = useColor;
}
export function useColor(): boolean {
  if (colorOverride !== null) return colorOverride;
  if (process.env["NO_COLOR"] !== undefined) return false;
  return process.stdout.isTTY ?? false;
}
