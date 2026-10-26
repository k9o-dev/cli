/**
 * Unit tests for CWI-mode's auth-path SHAPE — flag/env
 * recognition, `wl_<base62>` id format, and the `identifier`-profile tag
 * validation. The mint/DPoP wire mechanics are NOT tested
 * here because they don't exist yet — `clientFromProfile` must fail fast
 * with an honest "not yet operable" error when CWI-mode is selected.
 */

import { describe, expect, it } from "bun:test";
import { KError } from "@k9o/core";
import {
  validateWorkloadTag,
  resolveWorkloadId,
  cwiModeNotYetOperableError,
  clientFromProfile,
} from "../src/commands/auth.ts";

describe("clientFromProfile — CWI-mode dispatch happens BEFORE the credentials-file lookup", () => {
  it("throws the honest not-yet-operable error, not UNAUTHENTICATED, when workload-id is set", () => {
    // No credentials file is set up for this profile — if CWI-mode weren't
    // checked first, this would throw UNAUTHENTICATED ("run k9o login")
    // instead, which would be a misleading error for a caller who
    // deliberately selected CWI-mode.
    try {
      clientFromProfile({ positional: [], flags: { "workload-id": "wl_ab12CD34", profile: "cwi-test-nonexistent" } });
      throw new Error("expected clientFromProfile to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KError);
      expect((e as KError).code).toBe("K9O_INVALID_FIELD_VALUE");
      expect((e as KError).message).toContain("wl_ab12CD34");
      expect((e as KError).message).not.toContain("UNAUTHENTICATED");
    }
  });
});

describe("resolveWorkloadId — flag/env recognition", () => {
  it("returns undefined when CWI-mode is not selected", () => {
    expect(resolveWorkloadId({})).toBeUndefined();
  });

  it("reads --workload-id", () => {
    expect(resolveWorkloadId({ "workload-id": "wl_ab12CD34" })).toBe("wl_ab12CD34");
  });

  it("rejects a malformed workload id", () => {
    expect(() => resolveWorkloadId({ "workload-id": "not-a-workload-id" })).toThrow(KError);
    try {
      resolveWorkloadId({ "workload-id": "not-a-workload-id" });
    } catch (e) {
      expect((e as KError).code).toBe("K9O_INVALID_FIELD_VALUE");
      expect((e as KError).message).not.toMatch(/ch\d\d|\u00a7/);
    }
  });

  it("validates the tag eagerly alongside a valid id", () => {
    expect(() =>
      resolveWorkloadId({ "workload-id": "wl_ab12CD34", "workload-tag": "prod" }),
    ).not.toThrow();
    expect(() =>
      resolveWorkloadId({ "workload-id": "wl_ab12CD34", "workload-tag": "Prod Server" }),
    ).toThrow(KError);
  });
});

describe("validateWorkloadTag — identifier profile (mandatory negative-control set)", () => {
  it("accepts valid identifier-profile values", () => {
    for (const v of ["prod", "host-01", "canary", "a", "a.b_c-9"]) {
      expect(() => validateWorkloadTag(v)).not.toThrow();
    }
  });

  it("rejects empty string", () => {
    expect(() => validateWorkloadTag("")).toThrow(KError);
  });

  it("rejects NUL", () => {
    expect(() => validateWorkloadTag("prod\u0000")).toThrow(KError);
  });

  it("rejects a bidi override (Trojan-Source class)", () => {
    expect(() => validateWorkloadTag("prod‮txt")).toThrow(KError);
  });

  it("rejects zero-width space (ZWSP)", () => {
    expect(() => validateWorkloadTag("pro​d")).toThrow(KError);
  });

  it("rejects a homoglyph (Cyrillic 'а' U+0430, not Latin 'a')", () => {
    expect(() => validateWorkloadTag("prodа")).toThrow(KError);
  });

  it("rejects LF", () => {
    expect(() => validateWorkloadTag("prod\ndeploy")).toThrow(KError);
  });

  it("rejects U+2028 (line separator)", () => {
    expect(() => validateWorkloadTag("prod deploy")).toThrow(KError);
  });

  it("rejects uppercase (identifier profile is lowercase-only)", () => {
    expect(() => validateWorkloadTag("Prod")).toThrow(KError);
  });

  it("rejects a leading/trailing separator", () => {
    expect(() => validateWorkloadTag("-prod")).toThrow(KError);
    expect(() => validateWorkloadTag("prod-")).toThrow(KError);
  });

  it("rejects a value over 63 chars", () => {
    expect(() => validateWorkloadTag("a".repeat(64))).toThrow(KError);
  });

  it("coined code is K9O_INVALID_CHARACTER, message free of internal spec citations", () => {
    try {
      validateWorkloadTag("Prod Server");
      throw new Error("expected validateWorkloadTag to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(KError);
      expect((e as KError).code).toBe("K9O_INVALID_CHARACTER");
      expect((e as KError).message).not.toMatch(/ch\d\d|\u00a7/);
    }
  });
});

describe("cwiModeNotYetOperableError — honest failure, not a misleading fallback", () => {
  it("names the workload id and is free of internal spec citations (customer-facing text)", () => {
    const e = cwiModeNotYetOperableError("wl_ab12CD34");
    expect(e.code).toBe("K9O_INVALID_FIELD_VALUE");
    expect(e.message).toContain("wl_ab12CD34");
    expect(e.message).not.toMatch(/ch\d\d|\u00a7/);
  });
});
