/**
 * Keyless workload-identity federation: exchange an external OIDC token (for example the one GitHub Actions
 * issues to a workflow) for a short-lived platform token.
 *
 *   POST <base>/@<project>/workloads/<swi_id>/token   { oidcToken, tag? }   + a DPoP proof header
 *     -> { data: { access_token, token_type, expires_in, cnf? }, meta }
 *
 * The exchange needs no platform credential: the external token is the credential. The proof is an RFC 9449
 * DPoP JWS signed with a P-256 key made for this one exchange and dropped afterwards. The platform token is
 * kept in memory for the run; nothing is written to disk.
 *
 * Nothing here ever puts the external token or the platform token into an error message.
 */

import { generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { KError, kerrorFromWire, type KErrorWire } from "@k9o/core";

type FetchFn = typeof globalThis.fetch;

/** Federated workload identity ids look like `swi_<id>`. */
export const FEDERATED_WORKLOAD_ID_PATTERN = /^swi_[0-9A-Za-z_-]+$/;

export type DpopProofInput = {
  /** The exact request URL; the proof binds to its origin and path (no query, no fragment). */
  url: string;
  method?: string;
  /** Epoch seconds; defaults to now. */
  nowSec?: number;
  /** Defaults to a fresh random id. */
  jti?: string;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Build a DPoP proof JWS for one request, signed with a fresh ES256 (P-256) key that is discarded on return.
 * Header `{ typ: "dpop+jwt", alg: "ES256", jwk }`, claims `{ htm, htu, iat, jti }`, signature as raw r||s.
 */
export function buildDpopProof(input: DpopProofInput): string {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const target = new URL(input.url);
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
  };
  const claims = {
    htm: (input.method ?? "POST").toUpperCase(),
    htu: `${target.origin}${target.pathname}`,
    iat: input.nowSec ?? Math.floor(Date.now() / 1000),
    jti: input.jti ?? randomUUID(),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

export type OidcTokenSource = {
  oidcTokenFile?: string | undefined;
  oidcToken?: string | undefined;
  oidcAudience?: string | undefined;
  requestUrl?: string | undefined;
  requestToken?: string | undefined;
};

/** Read the token sources from flags and environment (flags win). */
export function oidcSourceFromEnv(flags: Record<string, string>, env: NodeJS.ProcessEnv = process.env): OidcTokenSource {
  const nonEmpty = (v: string | undefined): string | undefined => (v !== undefined && v.length > 0 ? v : undefined);
  return {
    oidcTokenFile: flags["oidc-token-file"],
    oidcToken: nonEmpty(env["K9O_OIDC_TOKEN"]),
    oidcAudience: flags["oidc-audience"] ?? nonEmpty(env["K9O_OIDC_AUDIENCE"]),
    requestUrl: nonEmpty(env["ACTIONS_ID_TOKEN_REQUEST_URL"]),
    requestToken: nonEmpty(env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]),
  };
}

function invalidField(message: string, field: string, recommendation: string | null): KError {
  return new KError({
    code: "K9O_INVALID_FIELD_VALUE",
    message,
    context: { field },
    recommendation,
  });
}

export function noOidcTokenError(): KError {
  return new KError({
    code: "K9O_MISSING_OIDC_TOKEN",
    message: "Workload federation needs an external OIDC token, and none was found.",
    context: {},
    recommendation:
      "Pass --oidc-token-file <path> or set K9O_OIDC_TOKEN. On GitHub Actions, add `permissions: id-token: write` " +
      "to the job so ACTIONS_ID_TOKEN_REQUEST_URL is set, and give --oidc-audience (or K9O_OIDC_AUDIENCE).",
  });
}

/**
 * Find the external OIDC token. Order: `--oidc-token-file`, then `K9O_OIDC_TOKEN`, then the GitHub Actions
 * token endpoint (needs an audience). The token is returned, never logged.
 */
export async function resolveOidcToken(src: OidcTokenSource, deps: { fetch?: FetchFn | undefined } = {}): Promise<string> {
  if (src.oidcTokenFile !== undefined) {
    if (src.oidcTokenFile === "true" || src.oidcTokenFile.length === 0) {
      throw invalidField("--oidc-token-file needs a file path.", "oidc-token-file", null);
    }
    let text: string;
    try {
      text = readFileSync(src.oidcTokenFile, "utf8");
    } catch (e) {
      throw invalidField(
        `Cannot read the OIDC token file ${src.oidcTokenFile}: ${(e as NodeJS.ErrnoException).code ?? "read error"}.`,
        "oidc-token-file",
        null,
      );
    }
    const token = text.trim();
    if (token.length === 0) throw invalidField(`The OIDC token file ${src.oidcTokenFile} is empty.`, "oidc-token-file", null);
    return token;
  }
  if (src.oidcToken !== undefined && src.oidcToken.trim().length > 0) return src.oidcToken.trim();

  if (src.requestUrl !== undefined && src.requestToken !== undefined) {
    if (src.oidcAudience === undefined || src.oidcAudience.length === 0 || src.oidcAudience === "true") {
      throw new KError({
        code: "K9O_MISSING_OIDC_AUDIENCE",
        message: "GitHub Actions issues the OIDC token for an audience, and none was given.",
        context: {},
        recommendation: "Pass --oidc-audience <aud> or set K9O_OIDC_AUDIENCE to the audience the workload's trust config expects.",
      });
    }
    const url = new URL(src.requestUrl);
    url.searchParams.set("audience", src.oidcAudience);
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${src.requestToken}`, accept: "application/json" },
      });
    } catch {
      throw new KError({
        code: "K9O_UPSTREAM_UNAVAILABLE",
        message: "Could not reach the GitHub Actions OIDC token endpoint.",
        context: { host: url.host },
        recommendation: "Retry the step. Check that the job has `permissions: id-token: write`.",
      });
    }
    if (!res.ok) {
      throw new KError({
        code: "K9O_MISSING_OIDC_TOKEN",
        message: `The GitHub Actions OIDC token endpoint refused the request (HTTP ${res.status}).`,
        context: { status: res.status },
        recommendation: "Check that the job has `permissions: id-token: write`.",
      });
    }
    let value: unknown;
    try {
      value = ((await res.json()) as { value?: unknown }).value;
    } catch {
      value = undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new KError({
        code: "K9O_MISSING_OIDC_TOKEN",
        message: "The GitHub Actions OIDC token endpoint returned no token.",
        context: {},
        recommendation: null,
      });
    }
    return value;
  }
  throw noOidcTokenError();
}

export type ExchangeResult = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  cnf: unknown;
};

const EXCHANGE_HINT =
  "The workload must be registered in this project, and its trust config must match the token's issuer, " +
  "audience and claims.";

function redact(err: KError, secrets: string[]): KError {
  const scrub = (s: string): string => secrets.reduce((acc, t) => (t.length > 0 ? acc.split(t).join("[redacted]") : acc), s);
  let context: Record<string, unknown> = {};
  try {
    context = JSON.parse(scrub(JSON.stringify(err.context))) as Record<string, unknown>;
  } catch {
    context = {};
  }
  return new KError({
    code: err.code,
    message: scrub(err.message),
    context,
    recommendation: err.recommendation === null ? null : scrub(err.recommendation),
    status: err.status,
    requestId: err.requestId,
  });
}

/** Add the registration and trust-config hint to the gateway's refusal, keeping any recommendation it gave. */
function withHint(err: KError): KError {
  const rec = err.recommendation === null ? EXCHANGE_HINT : `${err.recommendation} ${EXCHANGE_HINT}`;
  return new KError({
    code: err.code,
    message: err.message,
    context: err.context as Record<string, unknown>,
    recommendation: rec,
    status: err.status,
    requestId: err.requestId,
  });
}

export type ExchangeOptions = {
  baseUrl: string;
  projectSlug: string;
  /** The federated identity id, `swi_...`. */
  workloadId: string;
  oidcToken: string;
  tag?: string | undefined;
  orgSlug?: string | undefined;
  fetch?: FetchFn | undefined;
  /** Test seam. */
  nowSec?: number | undefined;
};

/** Exchange the external OIDC token at the gateway. Returns the platform token; throws a KError on refusal. */
export async function exchangeWorkloadToken(opts: ExchangeOptions): Promise<ExchangeResult> {
  const url = new URL(
    `/@${opts.projectSlug}/workloads/${encodeURIComponent(opts.workloadId)}/token`,
    opts.baseUrl,
  );
  const proof = buildDpopProof({ url: url.toString(), method: "POST", ...(opts.nowSec !== undefined ? { nowSec: opts.nowSec } : {}) });
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    dpop: proof,
    ...(opts.orgSlug !== undefined ? { "x-k9o-org-slug": opts.orgSlug } : {}),
  };
  const body = JSON.stringify({ oidcToken: opts.oidcToken, ...(opts.tag !== undefined ? { tag: opts.tag } : {}) });

  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { method: "POST", headers, body });
  } catch {
    throw new KError({
      code: "K9O_UPSTREAM_UNAVAILABLE",
      message: `Network error reaching ${url.origin} for the workload token exchange.`,
      context: { host: url.host },
      recommendation: "Check connectivity to the gateway.",
    });
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new KError({
      code: "K9O_INTERNAL_ERROR",
      message: `The token exchange returned HTTP ${res.status} with a body that is not JSON.`,
      context: { status: res.status },
      status: res.status,
    });
  }

  if (!res.ok) {
    const wire = parsed as Partial<KErrorWire> | null;
    if (wire !== null && typeof wire === "object" && typeof wire.code === "string" && typeof wire.message === "string") {
      throw withHint(redact(kerrorFromWire(wire as KErrorWire, res.status), [opts.oidcToken, proof]));
    }
    throw new KError({
      code: "K9O_INTERNAL_ERROR",
      message: `The token exchange returned HTTP ${res.status} with an unrecognised body.`,
      context: { status: res.status },
      status: res.status,
      recommendation: EXCHANGE_HINT,
    });
  }

  const data = (parsed as { data?: Record<string, unknown> } | null)?.data;
  const accessToken = data?.["access_token"];
  const expiresIn = data?.["expires_in"];
  if (typeof accessToken !== "string" || accessToken.length === 0 || typeof expiresIn !== "number") {
    throw new KError({
      code: "K9O_INTERNAL_ERROR",
      message: "The token exchange response is missing access_token or expires_in.",
      context: { status: res.status },
      status: res.status,
    });
  }
  return {
    accessToken,
    tokenType: typeof data?.["token_type"] === "string" ? (data["token_type"] as string) : "Bearer",
    expiresIn,
    cnf: data?.["cnf"] ?? null,
  };
}

/** The platform token for this process: in memory only, set by one exchange per run. */
export type FederatedSession = {
  workloadId: string;
  orgSlug: string | null;
  projectSlug: string;
  baseUrl: string;
  accessToken: string;
  tokenType: string;
  expiresIn: number;
};

let session: FederatedSession | null = null;

export function getFederatedSession(): FederatedSession | null {
  return session;
}

export function setFederatedSession(s: FederatedSession | null): void {
  session = s;
}
