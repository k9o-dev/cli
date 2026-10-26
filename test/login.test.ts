/**
 * `k9o login` signs in as the operator (`/auth/sign-in`, then the MFA challenge when the org requires it),
 * refreshes the session through `/auth/refresh`, and a service token replaces the login entirely.
 * Everything runs against a fake gateway behind fetch.
 */

import { describe, expect, it } from "bun:test";
import { KError } from "@k9o/core";
import { operatorSignIn, operatorRefresh } from "../src/operator-auth.ts";
import { refreshSessionIfNeeded, clientFromProfile } from "../src/commands/auth.ts";
import { envelope, fakeFetch, runCli, tempCredentials, tempPath, type Handler } from "./helpers.ts";

const BASE = "http://localhost:9";
const NOW_S = Math.floor(Date.now() / 1000);

const signInData = (over: Record<string, unknown> = {}) => ({
  accessToken: "at_1",
  accessTokenExp: NOW_S + 900,
  refreshToken: "rt_1",
  refreshTokenExp: NOW_S + 86_400,
  user: { id: "u_1", email: "op@acme.test", displayName: "Op" },
  org: { id: "org_1", slug: "acme", displayName: "Acme" },
  project: null,
  activeProjectId: null,
  mfa: { required: false, methodsAvailable: [] },
  exchangeTicket: null,
  redirectUrl: null,
  ...over,
});

describe("operatorSignIn", () => {
  it("plain sign-in: POST /auth/sign-in { method, email, password, orgSlug }, no MFA call", async () => {
    const { fetch, calls } = fakeFetch((c) => (c.path === "/auth/sign-in" ? { body: envelope(signInData()) } : undefined));
    const s = await operatorSignIn({ baseUrl: BASE, orgSlug: "acme", email: "op@acme.test", password: "pw", fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/auth/sign-in");
    expect(calls[0]!.body).toEqual({ method: "EMAIL_PASSWORD", email: "op@acme.test", password: "pw", orgSlug: "acme" });
    expect(s.accessToken).toBe("at_1");
    expect(s.refreshToken).toBe("rt_1");
    expect(s.org.slug).toBe("acme");
    expect(s.mfaVerified).toBe(false);
  });

  it("omits orgSlug when none is given (the gateway picks a single-org operator's org)", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: envelope(signInData()) }));
    await operatorSignIn({ baseUrl: BASE, email: "a@b.test", password: "pw", fetch });
    expect(calls[0]!.body).toEqual({ method: "EMAIL_PASSWORD", email: "a@b.test", password: "pw" });
  });

  it("MFA required: challenges with the access token as Bearer and keeps the re-issued token", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.path === "/auth/sign-in") {
        return { body: envelope(signInData({ mfa: { required: true, methodsAvailable: ["totp"] } })) };
      }
      if (c.path === "/auth/mfa/challenge") {
        return { body: envelope({ accessToken: "at_verified", accessTokenExp: NOW_S + 900, mfa: { verified: true } }) };
      }
      return undefined;
    });
    const s = await operatorSignIn({ baseUrl: BASE, email: "op@acme.test", password: "pw", mfaCode: "123456", fetch });
    expect(calls.map((c) => c.path)).toEqual(["/auth/sign-in", "/auth/mfa/challenge"]);
    expect(calls[1]!.headers["authorization"]).toBe("Bearer at_1");
    expect(calls[1]!.body).toEqual({ method: "totp", code: "123456" });
    expect(s.accessToken).toBe("at_verified");
    expect(s.refreshToken).toBe("rt_1");
    expect(s.mfaVerified).toBe(true);
  });

  it("MFA required and no code supplied: asks the prompt callback", async () => {
    const { fetch, calls } = fakeFetch((c) =>
      c.path === "/auth/sign-in"
        ? { body: envelope(signInData({ mfa: { required: true, methodsAvailable: ["totp", "webauthn"] } })) }
        : { body: envelope({ accessToken: "at_v", accessTokenExp: NOW_S + 900, mfa: { verified: true } }) },
    );
    let asked = 0;
    await operatorSignIn({
      baseUrl: BASE, email: "a@b.test", password: "pw", fetch,
      promptMfaCode: async () => { asked++; return " 654321\n"; },
    });
    expect(asked).toBe(1);
    expect(calls[1]!.body).toEqual({ method: "totp", code: "654321" });
  });

  it("MFA required, no code and no way to ask: fails with a message naming --mfa-code", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: envelope(signInData({ mfa: { required: true, methodsAvailable: ["totp"] } })) }));
    const err = await operatorSignIn({ baseUrl: BASE, email: "a@b.test", password: "pw", fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(KError);
    expect((err as KError).code).toBe("CLI_MFA_CODE_REQUIRED");
    expect((err as KError).recommendation).toContain("--mfa-code");
    expect(calls).toHaveLength(1);
  });

  it("enrollment required: no session is issued, so it fails clearly and never challenges", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: envelope(signInData({
        accessToken: null, accessTokenExp: null, refreshToken: null, refreshTokenExp: null,
        mfa: { required: true, methodsAvailable: [], enrollmentRequired: true },
        enrollmentToken: "enroll_tok",
      })),
    }));
    const err = await operatorSignIn({ baseUrl: BASE, email: "a@b.test", password: "pw", mfaCode: "123456", fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(KError);
    expect((err as KError).code).toBe("CLI_MFA_ENROLLMENT_REQUIRED");
    expect((err as KError).recommendation).toContain("Console");
    expect(calls.map((c) => c.path)).toEqual(["/auth/sign-in"]);
  });

  it("only a non-TOTP factor enrolled: says the CLI cannot verify it", async () => {
    const { fetch } = fakeFetch(() => ({ body: envelope(signInData({ mfa: { required: true, methodsAvailable: ["webauthn"] } })) }));
    const err = await operatorSignIn({ baseUrl: BASE, email: "a@b.test", password: "pw", mfaCode: "1", fetch }).catch((e) => e);
    expect((err as KError).code).toBe("CLI_MFA_METHOD_UNSUPPORTED");
  });

  it("a wrong password surfaces the gateway's error", async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: { code: "K9O_INVALID_CREDENTIALS", message: "Invalid email or password." } }));
    const err = await operatorSignIn({ baseUrl: BASE, email: "a@b.test", password: "bad", fetch }).catch((e) => e);
    expect((err as KError).code).toBe("K9O_INVALID_CREDENTIALS");
  });
});

describe("operatorRefresh", () => {
  it("POST /auth/refresh { refreshToken }", async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: envelope({ accessToken: "at_2", accessTokenExp: NOW_S + 900, refreshToken: "rt_2", refreshTokenExp: NOW_S + 86_400 }),
    }));
    const r = await operatorRefresh({ baseUrl: BASE, refreshToken: "rt_1", fetch });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe("/auth/refresh");
    expect(calls[0]!.body).toEqual({ refreshToken: "rt_1" });
    expect(r.refreshToken).toBe("rt_2");
  });
});

describe("k9o login (command)", () => {
  const loginHandler: Handler = (c) => (c.path === "/auth/sign-in" ? { body: envelope(signInData()) } : undefined);

  it("persists the operator session under the profile and reports it", async () => {
    const t = tempPath();
    try {
      const r = await runCli(
        ["login", "--base-url", BASE, "--org", "acme", "--email", "op@acme.test", "--password", "pw", "--project", "portal", "--credentials-file", t.path, "--output", "json"],
        loginHandler,
      );
      expect(r.code).toBe(0);
      const saved = JSON.parse(await Bun.file(t.path).text());
      const p = saved.profiles["default"];
      expect(p.accessToken).toBe("at_1");
      expect(p.refreshToken).toBe("rt_1");
      expect(p.orgSlug).toBe("acme");
      expect(p.userId).toBe("u_1");
      expect(p.activeProjectSlug).toBe("portal");
      expect(new Date(p.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(JSON.parse(r.stdout).data.email).toBe("op@acme.test");
    } finally {
      t.cleanup();
    }
  });

  it("needs no project: the profile just has none active", async () => {
    const t = tempPath();
    try {
      const r = await runCli(
        ["login", "--base-url", BASE, "--email", "op@acme.test", "--password", "pw", "--credentials-file", t.path, "--output", "json"],
        loginHandler,
      );
      expect(r.code).toBe(0);
      const p = JSON.parse(await Bun.file(t.path).text()).profiles["default"];
      expect(p.activeProjectSlug).toBeNull();
      expect(p.orgSlug).toBe("acme"); // taken from the sign-in response, not parsed from a host name
    } finally {
      t.cleanup();
    }
  });

  it("completes the MFA step from --mfa-code", async () => {
    const t = tempPath();
    try {
      const r = await runCli(
        ["login", "--base-url", BASE, "--email", "a@b.test", "--password", "pw", "--mfa-code", "111222", "--credentials-file", t.path, "--output", "json"],
        (c) =>
          c.path === "/auth/sign-in"
            ? { body: envelope(signInData({ mfa: { required: true, methodsAvailable: ["totp"] } })) }
            : c.path === "/auth/mfa/challenge"
              ? { body: envelope({ accessToken: "at_verified", accessTokenExp: NOW_S + 900, mfa: { verified: true } }) }
              : undefined,
      );
      expect(r.code).toBe(0);
      expect(JSON.parse(await Bun.file(t.path).text()).profiles["default"].accessToken).toBe("at_verified");
      expect(r.calls[1]!.body).toEqual({ method: "totp", code: "111222" });
    } finally {
      t.cleanup();
    }
  });

  it("enrollment required: non-zero exit, nothing saved, message points at the Console", async () => {
    const t = tempPath();
    try {
      const r = await runCli(
        ["login", "--base-url", BASE, "--email", "a@b.test", "--password", "pw", "--credentials-file", t.path, "--output", "json"],
        () => ({ body: envelope(signInData({ accessToken: null, accessTokenExp: null, refreshToken: null, refreshTokenExp: null, mfa: { required: true, methodsAvailable: [], enrollmentRequired: true } })) }),
      );
      expect(r.code).not.toBe(0);
      expect(JSON.parse(r.stderr).code).toBe("CLI_MFA_ENROLLMENT_REQUIRED");
      expect(await Bun.file(t.path).exists()).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it("help says password sign-in is the interim", async () => {
    const r = await runCli(["login", "--help"], () => undefined);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("interim");
    expect(r.stdout).toContain("device authorisation");
  });
});

describe("refreshSessionIfNeeded", () => {
  const refreshHandler: Handler = (c) =>
    c.path === "/auth/refresh"
      ? { body: envelope({ accessToken: "at_new", accessTokenExp: NOW_S + 900, refreshToken: "rt_new", refreshTokenExp: NOW_S + 86_400 }) }
      : undefined;

  it("refreshes an expired access token and saves the new pair (the refresh token is single-use)", async () => {
    const c = tempCredentials({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    try {
      const { fetch, calls } = fakeFetch(refreshHandler);
      await refreshSessionIfNeeded({ positional: [], flags: { "credentials-file": c.path } }, { fetch });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body).toEqual({ refreshToken: "rt_old" });
      const p = c.read().profiles["default"];
      expect(p.accessToken).toBe("at_new");
      expect(p.refreshToken).toBe("rt_new");
      expect(new Date(p.expiresAt).getTime()).toBeGreaterThan(Date.now());
    } finally {
      c.cleanup();
    }
  });

  it("does nothing while the access token is still valid", async () => {
    const c = tempCredentials();
    try {
      const { fetch, calls } = fakeFetch(refreshHandler);
      await refreshSessionIfNeeded({ positional: [], flags: { "credentials-file": c.path } }, { fetch });
      expect(calls).toHaveLength(0);
    } finally {
      c.cleanup();
    }
  });

  it("a refused refresh token becomes UNAUTHENTICATED with a re-login hint", async () => {
    const c = tempCredentials({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    try {
      const { fetch } = fakeFetch(() => ({ status: 401, body: { code: "K9O_REFRESH_TOKEN_INVALID", message: "invalid" } }));
      const err = await refreshSessionIfNeeded({ positional: [], flags: { "credentials-file": c.path } }, { fetch }).catch((e) => e);
      expect(err).toBeInstanceOf(KError);
      expect((err as KError).code).toBe("UNAUTHENTICATED");
      expect((err as KError).recommendation).toContain("k9o login");
    } finally {
      c.cleanup();
    }
  });

  it("is skipped in service-token mode", async () => {
    const c = tempCredentials({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    process.env["K9O_SERVICE_TOKEN"] = "svc_tok";
    try {
      const { fetch, calls } = fakeFetch(refreshHandler);
      await refreshSessionIfNeeded({ positional: [], flags: { "credentials-file": c.path } }, { fetch });
      expect(calls).toHaveLength(0);
    } finally {
      delete process.env["K9O_SERVICE_TOKEN"];
      c.cleanup();
    }
  });
});

describe("service-token mode (K9O_SERVICE_TOKEN)", () => {
  it("authenticates with the token as Bearer, no login, org and project from env", async () => {
    const r = await runCli(
      ["project", "list", "--base-url", BASE, "--profile", "no-such-profile-svc", "--output", "json"],
      (c) => (c.path === "/projects" ? { body: envelope([]) } : undefined),
      { K9O_SERVICE_TOKEN: "svc_secret", K9O_ORG: "acme", K9O_PROJECT: "portal" },
    );
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.headers["authorization"]).toBe("Bearer svc_secret");
    expect(r.calls[0]!.headers["x-k9o-org-slug"]).toBe("acme");
    expect(r.calls[0]!.headers["x-k9o-project-slug"]).toBe("portal");
  });

  it("takes org and project from flags, which win over env", async () => {
    const r = await runCli(
      ["audit", "query", "--org", "flagorg", "--project", "flagproj", "--base-url", BASE, "--output", "json"],
      (c) => (c.path === "/@flagproj/audit-log" ? { body: envelope([], { cursor: { next: null } }) } : undefined),
      { K9O_SERVICE_TOKEN: "svc_secret", K9O_ORG: "envorg", K9O_PROJECT: "envproj" },
    );
    expect(r.code).toBe(0);
    expect(r.calls[0]!.path).toBe("/@flagproj/audit-log");
    expect(r.calls[0]!.headers["x-k9o-org-slug"]).toBe("flagorg");
  });

  it("wins over a saved login", async () => {
    const c = tempCredentials({ accessToken: "at_saved" });
    try {
      const r = await runCli(
        ["project", "list", "--credentials-file", c.path, "--base-url", BASE, "--output", "json"],
        () => ({ body: envelope([]) }),
        { K9O_SERVICE_TOKEN: "svc_secret", K9O_ORG: "acme" },
      );
      expect(r.calls[0]!.headers["authorization"]).toBe("Bearer svc_secret");
    } finally {
      c.cleanup();
    }
  });

  it("without an org or base URL it says what is missing instead of guessing", () => {
    process.env["K9O_SERVICE_TOKEN"] = "svc_secret";
    try {
      expect(() => clientFromProfile({ positional: [], flags: {} })).toThrow(/org context/);
    } finally {
      delete process.env["K9O_SERVICE_TOKEN"];
    }
  });

  it("needs a project only where the command needs one", () => {
    process.env["K9O_SERVICE_TOKEN"] = "svc_secret";
    try {
      expect(() => clientFromProfile({ positional: [], flags: { org: "acme", "base-url": BASE } })).not.toThrow();
      expect(() => clientFromProfile({ positional: [], flags: { org: "acme", "base-url": BASE } }, { requireProject: true })).toThrow(/project context/);
    } finally {
      delete process.env["K9O_SERVICE_TOKEN"];
    }
  });

  it("whoami reports service-token mode and `k9o --help` documents the variable", async () => {
    const who = await runCli(["whoami", "--output", "json"], () => undefined, { K9O_SERVICE_TOKEN: "svc_secret", K9O_ORG: "acme" });
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout).data.mode).toBe("service-token");
    expect(who.stdout).not.toContain("svc_secret");
    const help = await runCli(["--help"], () => undefined);
    expect(help.stdout).toContain("K9O_SERVICE_TOKEN");
  });
});
