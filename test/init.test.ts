/**
 * Unit tests for the `k9o init` wizard resolution helpers.
 *
 * These cover the baseUrl-optional rule: the org slug is the
 * primary identity and the gateway is DERIVED from it, with an explicit
 * --base-url/K9O_BASE_URL honoured and a bare apex still derived to the org
 * subdomain. In --output json mode the helpers are non-interactive (no
 * stdin), so they are deterministic and tested directly here. The interactive
 * prompt/re-prompt paths need a TTY and are exercised manually + in CI.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { KError } from "@k9o/core";
import { resolveOrgSlug, resolveGatewayBaseUrl } from "../src/commands/init.ts";
import type { ParsedArgs } from "../src/args.ts";

const argsWith = (flags: Record<string, string>): ParsedArgs => ({ positional: ["init"], flags });

// Keep env hermetic — several tests assert flag/env precedence.
const savedEnv = { org: process.env["K9O_ORG"], base: process.env["K9O_BASE_URL"] };
afterEach(() => {
  if (savedEnv.org === undefined) delete process.env["K9O_ORG"];
  else process.env["K9O_ORG"] = savedEnv.org;
  if (savedEnv.base === undefined) delete process.env["K9O_BASE_URL"];
  else process.env["K9O_BASE_URL"] = savedEnv.base;
});

describe("resolveOrgSlug", () => {
  it("returns the --org flag value when valid", async () => {
    expect(await resolveOrgSlug(argsWith({ org: "acme" }), "json")).toBe("acme");
  });

  it("falls back to K9O_ORG when no flag is given", async () => {
    delete process.env["K9O_ORG"];
    process.env["K9O_ORG"] = "via-env";
    expect(await resolveOrgSlug(argsWith({}), "json")).toBe("via-env");
  });

  it("prefers the flag over the env var", async () => {
    process.env["K9O_ORG"] = "from-env";
    expect(await resolveOrgSlug(argsWith({ org: "from-flag" }), "json")).toBe("from-flag");
  });

  it("rejects a malformed slug with K9O_INVALID_FIELD_VALUE", async () => {
    await expect(resolveOrgSlug(argsWith({ org: "Bad_Org" }), "json")).rejects.toMatchObject({
      code: "K9O_INVALID_FIELD_VALUE",
    });
  });

  it("throws K9O_MISSING_PROJECT_CONTEXT in json mode when org is absent", async () => {
    delete process.env["K9O_ORG"];
    await expect(resolveOrgSlug(argsWith({}), "json")).rejects.toMatchObject({
      code: "K9O_MISSING_PROJECT_CONTEXT",
    });
  });
});

describe("resolveGatewayBaseUrl", () => {
  it("derives https://<org>.api.k9o.io when no base-url is supplied", async () => {
    delete process.env["K9O_BASE_URL"];
    expect(await resolveGatewayBaseUrl(argsWith({}), "acme", "json")).toBe("https://acme.api.k9o.io");
  });

  it("derives the org subdomain even from a bare apex --base-url", async () => {
    const url = await resolveGatewayBaseUrl(argsWith({ "base-url": "https://api.k9o.io" }), "acme", "json");
    expect(url).toBe("https://acme.api.k9o.io");
  });

  it("passes an explicit org subdomain through unchanged", async () => {
    const url = await resolveGatewayBaseUrl(argsWith({ "base-url": "https://acme.api.k9o.io" }), "acme", "json");
    expect(url).toBe("https://acme.api.k9o.io");
  });

  it("passes a self-hosted / Sovereign host through unchanged", async () => {
    const url = await resolveGatewayBaseUrl(argsWith({ "base-url": "https://k9o.internal.example.com" }), "acme", "json");
    expect(url).toBe("https://k9o.internal.example.com");
  });

  it("honours K9O_BASE_URL when no flag is given", async () => {
    process.env["K9O_BASE_URL"] = "http://localhost:8181";
    expect(await resolveGatewayBaseUrl(argsWith({}), "acme", "json")).toBe("http://localhost:8181");
  });

  it("rejects a path-bearing base-url with K9O_INVALID_BASE_URL", async () => {
    await expect(
      resolveGatewayBaseUrl(argsWith({ "base-url": "https://api.k9o.io/v2" }), "acme", "json"),
    ).rejects.toBeInstanceOf(KError);
  });
});
