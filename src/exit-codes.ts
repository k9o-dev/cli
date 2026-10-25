/**
 * CLI exit-code map — family-aware mapping from
 * error taxonomy to OS-level exit codes.
 */

import { KError } from "@k9o/core";

export const EXIT_SUCCESS = 0;
export const EXIT_GENERIC = 1;
export const EXIT_USAGE = 2;
export const EXIT_LOCAL_CONFIG = 64;
export const EXIT_MISSING_CONTEXT = 65;
export const EXIT_AUTH = 66;
export const EXIT_AUTHORITY = 67;
export const EXIT_NOT_FOUND = 68;
export const EXIT_CONFLICT = 69;
export const EXIT_VALIDATION_PARSE = 70;
export const EXIT_VALIDATION_SEMANTIC = 71;
export const EXIT_CAPACITY = 72;
export const EXIT_UPSTREAM_UNAVAILABLE = 73;
export const EXIT_TOKEN_EXPIRED = 74;
export const EXIT_LIFECYCLE = 75;

/**
 * Map a KError to its exit code family taxonomy. Codes
 * follow the patterns observed + the codes coined by gateway
 * + SDK surfaces.
 *
 * The mapping is best-effort code-string + status-based; unknown
 * patterns fall through to status-based mapping; ultimate fallback
 * is EXIT_GENERIC (1).
 */
export function exitCodeForError(e: unknown): number {
  if (!(e instanceof KError)) return EXIT_GENERIC;

  // Code-based first
  const code = e.code;
  if (code === "K9O_MISSING_PROJECT_CONTEXT" || code === "K9O_MISSING_ORG_CONTEXT" || code === "MISSING_PROJECT_CONTEXT" || code === "MISSING_ORG_CONTEXT") return EXIT_MISSING_CONTEXT;
  if (code === "K9O_INVALID_BASE_URL" || code === "K9O_INVALID_FIELD_VALUE" || code === "K9O_INVALID_BUCKET_NAME" || code === "K9O_INVALID_CHARACTER" || code === "K9O_POLICY_RULE_COLLISION") return EXIT_VALIDATION_PARSE;
  if (code === "K9O_TIER_CAP_HIT") return EXIT_CAPACITY;
  // The gateway now returns these two as 400 (family "Validation — semantic"); a bare 400 maps to
  // the parse-time exit, so the code keeps them on the semantic one.
  if (code === "K9O_WORKFLOW_TRIGGER_INVALID" || code === "K9O_WORKFLOW_ACTION_INVALID") return EXIT_VALIDATION_SEMANTIC;
  if (code === "K9O_UPSTREAM_UNAVAILABLE") return EXIT_UPSTREAM_UNAVAILABLE;
  if (code === "K9O_OTP_EXPIRED" || code === "K9O_SESSION_EXPIRED" || code === "SESSION_EXPIRED") return EXIT_TOKEN_EXPIRED;
  if (code === "CLI_CONFIG_INVALID") return EXIT_LOCAL_CONFIG;
  if (code.includes("PROJECT_SOFT_DELETED") || code.includes("EXTENSION_PURGE_GATE_REQUIRED")) return EXIT_LIFECYCLE;
  if (code === "UNAUTHENTICATED" || code === "INVALID_CREDENTIALS" || code === "REFRESH_TOKEN_INVALID" || code === "MFA_REQUIRED") return EXIT_AUTH;
  if (code === "RBAC_DENY" || code === "ACCESS_DENIED" || code === "FORBIDDEN" || code.includes("AUTHORITY_INSUFFICIENT") || code.includes("PERMISSION_DENIED")) return EXIT_AUTHORITY;
  if (code.endsWith("_NOT_FOUND") || code === "NOT_FOUND") return EXIT_NOT_FOUND;
  if (code.endsWith("_CONFLICT") || code.endsWith("_ALREADY_EXISTS") || code === "ALREADY_EXISTS" || code.includes("ALREADY_") || code === "K9O_CONSTRAINT_VIOLATION" || code === "EMAIL_ALREADY_REGISTERED") return EXIT_CONFLICT;

  // Status-based fallback
  const status = e.status;
  if (status !== null) {
    if (status === 400) return EXIT_VALIDATION_PARSE;
    if (status === 401) return EXIT_AUTH;
    if (status === 403) return EXIT_AUTHORITY;
    if (status === 404) return EXIT_NOT_FOUND;
    if (status === 409) return EXIT_CONFLICT;
    if (status === 410) return EXIT_TOKEN_EXPIRED;
    if (status === 422) return EXIT_VALIDATION_SEMANTIC;
    if (status === 429) return EXIT_CAPACITY;
    if (status >= 500) return EXIT_UPSTREAM_UNAVAILABLE;
  }
  return EXIT_GENERIC;
}
