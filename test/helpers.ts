/**
 * Test helpers: a fake gateway behind `globalThis.fetch`, stdout/stderr capture, and a throwaway
 * credentials file. Commands run through `main()` exactly as the binary does.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.ts";

export type Call = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  rawBody: Uint8Array | null;
};

export type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; sse?: string };
export type Handler = (call: Call) => Reply | undefined;

export function jsonResponse(reply: Reply): Response {
  if (reply.sse !== undefined) return new Response(reply.sse, { status: reply.status ?? 200, headers: { "content-type": "text/event-stream" } });
  return new Response(JSON.stringify(reply.body ?? { data: null, meta: {} }), {
    status: reply.status ?? 200,
    headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
  });
}

export function envelope(data: unknown, meta: Record<string, unknown> = {}): { data: unknown; meta: Record<string, unknown> } {
  return { data, meta };
}

/** Build a fetch that records every call and answers through `handler` (404 envelope-less error otherwise). */
export function fakeFetch(handler: Handler): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown = undefined;
    let rawBody: Uint8Array | null = null;
    const b = init?.body;
    if (typeof b === "string") {
      try {
        body = JSON.parse(b);
      } catch {
        body = b;
      }
    } else if (b instanceof Uint8Array) {
      rawBody = b;
    } else if (b !== undefined && b !== null) {
      rawBody = new Uint8Array(await new Response(b as BodyInit).arrayBuffer());
    }
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body,
      rawBody,
    };
    calls.push(call);
    const reply = handler(call);
    if (reply === undefined) {
      return jsonResponse({ status: 404, body: { code: "K9O_NOT_FOUND", message: `no fake route for ${call.method} ${call.path}` } });
    }
    return jsonResponse(reply);
  };
  return { fetch: impl as typeof globalThis.fetch, calls };
}

export type Run = { code: number; stdout: string; stderr: string; calls: Call[] };

const ENV_KEYS = [
  "K9O_SERVICE_TOKEN", "K9O_ORG", "K9O_PROJECT", "K9O_BASE_URL", "K9O_PROFILE", "K9O_OUTPUT",
  "K9O_EMAIL", "K9O_PASSWORD", "K9O_MFA_CODE", "K9O_WORKLOAD_ID", "K9O_WORKLOAD_TAG",
  "K9O_OIDC_TOKEN", "K9O_OIDC_AUDIENCE", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
];

/**
 * Run `main(argv)` against a fake gateway with a clean K9O_* environment. `env` is set for the run only.
 * stdout and stderr are captured.
 */
export async function runCli(argv: string[], handler: Handler, env: Record<string, string> = {}): Promise<Run> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  const { fetch: fake, calls } = fakeFetch(handler);
  const realFetch = globalThis.fetch;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  globalThis.fetch = fake;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, stdout, stderr, calls };
  } finally {
    globalThis.fetch = realFetch;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

/** A temp credentials file holding one logged-in profile. Returns its path and a cleanup. */
export function tempCredentials(profile: Record<string, unknown> = {}, name = "default"): { path: string; read: () => any; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "k9o-cli-test-"));
  const path = join(dir, "credentials");
  const full = {
    refreshToken: "rt_old",
    accessToken: "at_valid",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    baseUrl: "http://localhost:9",
    orgSlug: "acme",
    userId: "u_1",
    userEmail: "op@acme.test",
    activeProjectSlug: "portal",
    ...profile,
  };
  writeFileSync(path, JSON.stringify({ current: name, profiles: { [name]: full } }));
  return {
    path,
    read: () => JSON.parse(readFileSync(path, "utf8")),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A path inside a fresh temp dir (the file is not created). */
export function tempPath(file = "credentials"): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "k9o-cli-test-"));
  return { path: join(dir, file), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
