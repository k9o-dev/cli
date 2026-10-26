/**
 * Dispatch + guard tests for the one-binary extension surface:
 *   - `k9o ext-admin <verb>`        — management tree (native Use verbs + registered extension-toolchain verbs)
 *   - `k9o ext <slug> <verb>`       — dynamic per-extension dispatch
 *   - aliases `extension-admin`→`ext-admin`, `extension`→`ext`
 *
 * Covers routing and the reserved-slug/root guard. All paths here return
 * before any network call.
 */

import { describe, expect, it } from "bun:test";
import { main } from "../src/index.ts";

const J = ["--output", "json"];

describe("ext-admin tree", () => {
  it("no verb → EXIT_USAGE (prints help)", async () => {
    expect(await main(["ext-admin", ...J])).toBe(2);
  });

  it("unknown verb → EXIT_USAGE", async () => {
    expect(await main(["ext-admin", "zzz-nonsense", ...J])).toBe(2);
  });

  it("`available` was removed (no route): it is an unknown verb", async () => {
    expect(await main(["ext-admin", "available", ...J])).toBe(2);
  });

  it("a publisher-toolchain verb without the toolchain installed → EXIT_USAGE naming it", async () => {
    expect(await main(["ext-admin", "publish", ...J])).toBe(2);
  });

  it("enable without <slug> → EXIT_USAGE", async () => {
    expect(await main(["ext-admin", "enable", ...J])).toBe(2);
  });

  it("config without <slug> → EXIT_USAGE", async () => {
    expect(await main(["ext-admin", "config", ...J])).toBe(2);
  });

  it("extension-admin is an alias for ext-admin (no verb → EXIT_USAGE)", async () => {
    expect(await main(["extension-admin", ...J])).toBe(2);
  });

  it("extension-admin alias routes an unknown verb to a usage error", async () => {
    expect(await main(["extension-admin", "available", ...J])).toBe(2);
  });
});

describe("ext (dynamic per-extension) dispatch", () => {
  it("no slug → EXIT_USAGE (prints help)", async () => {
    expect(await main(["ext", ...J])).toBe(2);
  });

  it("reserved slug `admin` → EXIT_USAGE (points at ext-admin)", async () => {
    expect(await main(["ext", "admin", "list", ...J])).toBe(2);
  });

  it("slug without verb → EXIT_USAGE", async () => {
    expect(await main(["ext", "paperless", ...J])).toBe(2);
  });

  // slug + verb is wired: it reads the extension's declared commands, so with no sign-in it fails on
  // authentication (not as a usage error). See gateway-shapes.test.ts for the full call.
  it("slug + verb is wired: without a sign-in it fails on authentication, not usage", async () => {
    const code = await main(["ext", "paperless", "scan", "--profile", "no-such-profile-ext-test", ...J]);
    expect(code).not.toBe(2);
    expect(code).not.toBe(0);
  });

  it("extension is an alias for ext (slug + verb wired)", async () => {
    const code = await main(["extension", "paperless", "scan", "--profile", "no-such-profile-ext-test", ...J]);
    expect(code).not.toBe(2);
    expect(code).not.toBe(0);
  });

  it("extension alias with reserved slug → EXIT_USAGE", async () => {
    expect(await main(["extension", "admin", "list", ...J])).toBe(2);
  });
});
