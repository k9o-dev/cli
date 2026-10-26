/**
 * Response shapes the gateway actually returns, for the commands that render them.
 *
 * Where `@k9o/core` declares a different shape for the same route, the CLI reads
 * the gateway's (the OpenAPI and the route handlers are the source of truth).
 * Only the fields the CLI prints are listed. Cast with `wire<T>()`.
 */

import type { Envelope } from "@k9o/core";

/** Re-type an SDK envelope as the shape the gateway returns on the wire. */
export function wire<T>(env: Envelope<unknown>): Envelope<T> {
  return env as unknown as Envelope<T>;
}

/** GET /projects, GET /projects/{slug}, POST /projects. */
export type WireProject = {
  id: string;
  slug: string;
  orgId: string;
  displayName: string;
  description: string | null;
  productScope: string;
  region: string;
  custodyMode: string;
  status: string;
  role: string | null;
  createdAt: string;
};

/** GET /@{project}/policies and friends. A bundle has no name or version. */
export type WirePolicyBundle = {
  id: string;
  status: string;
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
  supersededAt: string | null;
  editorMode: string;
  pendingChangeId?: string | null;
};

/** POST /@{project}/policies/{id}/publish: a bundle, or a queued approval. */
export type WirePublishResult = Partial<WirePolicyBundle> & {
  pendingChangeId?: string;
  bundleId?: string;
  status?: string;
};

/** GET /members, PATCH /members/{id}. */
export type WireMember = {
  userId: string;
  orgId: string;
  role: string;
  email: string;
  displayName: string;
  invitedAt: string;
  acceptedAt: string | null;
  /** Raw membership status: active | suspended. */
  status: string;
  /** Derived state: invited | active | suspended. */
  state: string;
};

/** POST /members: a member (201, existing user) or a pending invitation (202). */
export type WireInviteResult = Partial<WireMember> & {
  invitation?: { id: string; email: string; role: string; expiresAt: string };
  delivery?: unknown;
};

/** GET /org. */
export type WireOrg = {
  id: string;
  slug: string | null;
  displayName: string;
  customDomain: string | null;
  billingTier: string | null;
  role: string | null;
  createdAt: string;
};

/** GET /audit-log (org plane). Only `type` and `limit` are honoured by the route. */
export type WireOrgAuditEvent = {
  id: string;
  type: string;
  actorId: string | null;
  targetKind: string | null;
  targetId: string | null;
  createdAt: string;
};

/** POST /org/smtp/test-email. */
export type WireSmtpTestResult = {
  accepted: boolean;
  resolvedTier: string;
  to: string;
  dryRun: boolean;
};

/** GET /me/sessions. */
export type WireSession = {
  id: string;
  issuedAt: string;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  isCurrentSession: boolean;
};

/** GET /@{project}/extensions-admin (list and detail). */
export type WireInstalledExtension = {
  installId: string;
  extensionId: string;
  extensionSlug: string;
  manifestVersion: string;
  /** enabled | disabled. */
  status: string;
  enabledAt: string;
  disabledAt: string | null;
  config?: Record<string, unknown>;
  updateAvailable: boolean;
  latestVersion: string | null;
};

/** GET /@{project}/functions. Runtime and tier are as deployed. */
export type WireFunction = {
  id: string;
  name: string;
  runtime?: string;
  tier?: string;
  status?: string;
  createdAt?: string;
};
