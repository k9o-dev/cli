/**
 * Operator sign-in for the CLI.
 *
 * `k9o login` signs in as the OPERATOR (the person who administers an org),
 * through the gateway's `/auth/sign-in`, not as a project end user through
 * Gate. Password sign-in is the interim: browser-based device authorisation
 * replaces it once it lands.
 *
 *   1. POST /auth/sign-in   { method: "EMAIL_PASSWORD", email, password, orgSlug? }
 *        -> { accessToken, accessTokenExp, refreshToken, refreshTokenExp,
 *             user, org, project, mfa: { required, methodsAvailable, enrollmentRequired? } }
 *   2. If mfa.required: POST /auth/mfa/challenge { method: "totp", code }
 *      with the access token as Bearer
 *        -> { accessToken, accessTokenExp, mfa: { verified: true } }
 *      The returned access token replaces the first one.
 *   3. If mfa.enrollmentRequired: no session exists yet; the operator
 *      enrolls an authenticator in the Console and signs in again.
 *
 * Token refresh: POST /auth/refresh { refreshToken } -> a new access token and
 * a new (single-use) refresh token.
 *
 * Everything goes through `@k9o/core`'s request layer, so region routing,
 * envelope unwrapping and KError mapping are the SDK's.
 */

import { KError } from "@k9o/core";
import { request, type HttpClientConfig } from "@k9o/core/http";

export type OperatorSession = {
  accessToken: string;
  /** Epoch seconds. */
  accessTokenExp: number;
  refreshToken: string | null;
  /** Epoch seconds. */
  refreshTokenExp: number | null;
  user: { id: string; email: string; displayName: string | null };
  org: { id: string; slug: string; displayName: string };
  project: { id: string; slug: string; displayName: string } | null;
  /** True when an MFA challenge was cleared during this sign-in. */
  mfaVerified: boolean;
};

type SignInData = {
  accessToken: string | null;
  accessTokenExp: number | null;
  refreshToken: string | null;
  refreshTokenExp: number | null;
  user: { id: string; email: string; displayName?: string | null };
  org: { id: string; slug: string; displayName: string };
  project: { id: string; slug: string; displayName: string } | null;
  mfa: { required: boolean; methodsAvailable: string[]; enrollmentRequired?: boolean };
  exchangeTicket?: string | null;
};

type MfaChallengeData = {
  accessToken: string;
  accessTokenExp: number;
  mfa: { verified: boolean };
};

type RefreshData = {
  accessToken: string;
  accessTokenExp: number;
  refreshToken: string;
  refreshTokenExp: number;
};

export type OperatorSignInOptions = {
  baseUrl: string;
  orgSlug?: string | undefined;
  email: string;
  password: string;
  /** A TOTP code supplied up front (`--mfa-code` / `K9O_MFA_CODE`). */
  mfaCode?: string | undefined;
  /** Called to obtain a TOTP code when MFA is required and none was supplied. */
  promptMfaCode?: (() => Promise<string>) | undefined;
  /** Test seam: a fake fetch. */
  fetch?: typeof globalThis.fetch | undefined;
};

function httpConfig(baseUrl: string, fetchImpl: typeof globalThis.fetch | undefined): HttpClientConfig {
  return { baseUrl, ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}) };
}

export async function operatorSignIn(opts: OperatorSignInOptions): Promise<OperatorSession> {
  const cfg = httpConfig(opts.baseUrl, opts.fetch);
  const first = await request<SignInData>(cfg, {
    method: "POST",
    path: "/auth/sign-in",
    body: {
      method: "EMAIL_PASSWORD",
      email: opts.email,
      password: opts.password,
      ...(opts.orgSlug !== undefined ? { orgSlug: opts.orgSlug } : {}),
    },
  });
  const d = first.data;

  if (d.mfa?.enrollmentRequired === true) {
    throw new KError({
      code: "CLI_MFA_ENROLLMENT_REQUIRED",
      message: "Your organisation requires multi-factor authentication and you have no authenticator enrolled.",
      context: { org: d.org?.slug ?? null },
      recommendation: "Enroll an authenticator app in the Console (Account, Security), then run `k9o login` again.",
    });
  }
  if (d.accessToken === null || d.accessToken === undefined || d.accessTokenExp === null || d.accessTokenExp === undefined) {
    throw new KError({
      code: "CLI_SIGN_IN_NO_SESSION",
      message: "Sign-in did not return a session (this org signs in through its own domain).",
      context: { org: d.org?.slug ?? null },
      recommendation: "Pass the org's API host as --base-url, or sign in through the Console.",
    });
  }

  let accessToken = d.accessToken;
  let accessTokenExp = d.accessTokenExp;
  let mfaVerified = false;

  if (d.mfa?.required === true) {
    if (!d.mfa.methodsAvailable.includes("totp")) {
      throw new KError({
        code: "CLI_MFA_METHOD_UNSUPPORTED",
        message: `Your enrolled MFA methods (${d.mfa.methodsAvailable.join(", ") || "none"}) are not supported by the CLI; it can verify an authenticator-app code (TOTP) only.`,
        context: { methodsAvailable: d.mfa.methodsAvailable },
        recommendation: "Enroll an authenticator app in the Console, or use the Console for this operation.",
      });
    }
    let code = opts.mfaCode;
    if (code === undefined || code.length === 0) {
      if (opts.promptMfaCode === undefined) {
        throw new KError({
          code: "CLI_MFA_CODE_REQUIRED",
          message: "A multi-factor code is required to finish signing in.",
          context: {},
          recommendation: "Pass --mfa-code <6 digits> or set K9O_MFA_CODE.",
        });
      }
      code = await opts.promptMfaCode();
    }
    code = code.trim();
    if (code.length === 0) {
      throw new KError({
        code: "CLI_MFA_CODE_REQUIRED",
        message: "A multi-factor code is required to finish signing in.",
        context: {},
        recommendation: "Pass --mfa-code <6 digits> or set K9O_MFA_CODE.",
      });
    }
    const verified = await request<MfaChallengeData>(cfg, {
      method: "POST",
      path: "/auth/mfa/challenge",
      body: { method: "totp", code },
      bearerToken: accessToken,
    });
    accessToken = verified.data.accessToken;
    accessTokenExp = verified.data.accessTokenExp;
    mfaVerified = verified.data.mfa.verified === true;
  }

  return {
    accessToken,
    accessTokenExp,
    refreshToken: d.refreshToken,
    refreshTokenExp: d.refreshTokenExp,
    user: { id: d.user.id, email: d.user.email, displayName: d.user.displayName ?? null },
    org: d.org,
    project: d.project ?? null,
    mfaVerified,
  };
}

/** Exchange a refresh token for a new access token and a new refresh token (the old one is spent). */
export async function operatorRefresh(opts: {
  baseUrl: string;
  refreshToken: string;
  fetch?: typeof globalThis.fetch | undefined;
}): Promise<RefreshData> {
  const env = await request<RefreshData>(httpConfig(opts.baseUrl, opts.fetch), {
    method: "POST",
    path: "/auth/refresh",
    body: { refreshToken: opts.refreshToken },
  });
  return env.data;
}

/** Epoch seconds to an ISO 8601 instant. */
export function epochSecondsToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
