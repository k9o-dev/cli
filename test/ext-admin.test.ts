/**
 * Dispatch + guard tests for the one-binary extension surface:
 *   - `k9o ext-admin <verb>`        — management tree (native Use verbs + registered extension-toolchain verbs)
 *   - `k9o ext <slug> <verb>`       — dynamic per-extension dispatch
 *   - aliases `extension-admin`→`ext-admin`, `extension`→`ext`
 *
 * Covers routing, the reserved-slug/root guard, and the two gated surfaces
 * (`available` marketplace + dynamic `ext` resolution) that error cleanly until
 * their endpoints land. All paths here return before any network call.
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

  it("available → EXIT_USAGE (gated: marketplace endpoint pending)", async () => {
    expect(await main(["ext-admin", "available", ...J])).toBe(2);
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

  it("extension-admin alias routes the gated available verb", async () => {
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

  it("slug + verb → EXIT_USAGE (gated: surfaces.cli sync pending)", async () => {
    expect(await main(["ext", "paperless", "scan", ...J])).toBe(2);
  });

  it("extension is an alias for ext (slug + verb gated)", async () => {
    expect(await main(["extension", "paperless", "scan", ...J])).toBe(2);
  });

  it("extension alias with reserved slug → EXIT_USAGE", async () => {
    expect(await main(["extension", "admin", "list", ...J])).toBe(2);
  });
});
