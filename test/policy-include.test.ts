/**
 * Unit tests for `k9o policy`'s multi-file `include` composition
 * (packages/cli/src/policy-include.ts) — CLI include mechanics.
 *
 * Uses real temp files (not mocked fs) — the module does real disk I/O
 * (readFileSync + relative-path resolution against each file's own
 * directory), so the tests exercise the actual resolution behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KError } from "@k9o/core";
import { resolvePolicyDocument } from "../src/policy-include.ts";
import { loadPolicyDocument } from "../src/commands/policy.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "k9o-policy-include-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(relPath: string, content: unknown): string {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, JSON.stringify(content));
  return abs;
}

describe("resolvePolicyDocument — single file, no include", () => {
  it("returns the file's own rules and policy unchanged", () => {
    const f = write("a.json", {
      rules: [{ name: "r1", when: { eq: ["a", "b"] }, action: "allow" }],
      policy: { collections: { docs: { actions: { select: ["r1"] } } } },
    });
    const doc = resolvePolicyDocument([f]);
    expect(doc.rules).toEqual([{ name: "r1", when: { eq: ["a", "b"] }, action: "allow" }]);
    expect(doc.policy).toEqual({ collections: { docs: { actions: { select: ["r1"] } } } });
  });

  it("a file with no policy block resolves to an empty policy object", () => {
    const f = write("a.json", { rules: [{ name: "r1", action: "allow" }] });
    expect(resolvePolicyDocument([f]).policy).toEqual({});
  });
});

describe("resolvePolicyDocument — include resolution", () => {
  it("pulls rules from an included file, relative to the INCLUDING file's own directory", () => {
    write("shared/common.json", { rules: [{ name: "common-rule", action: "allow" }] });
    const entry = write("main.json", {
      include: ["./shared/common.json"],
      rules: [{ name: "main-rule", action: "deny" }],
    });
    const doc = resolvePolicyDocument([entry]);
    const names = doc.rules.map((r) => r["name"]).sort();
    expect(names).toEqual(["common-rule", "main-rule"]);
  });

  it("resolves nested includes transitively", () => {
    write("c.json", { rules: [{ name: "c", action: "allow" }] });
    write("b.json", { include: ["./c.json"], rules: [{ name: "b", action: "allow" }] });
    const entry = write("a.json", { include: ["./b.json"], rules: [{ name: "a", action: "allow" }] });
    const names = resolvePolicyDocument([entry]).rules.map((r) => r["name"]).sort();
    expect(names).toEqual(["a", "b", "c"]);
  });

  it("include paths are relative to the FILE, not the caller's cwd", () => {
    // subdir/entry.json includes ../shared/common.json — resolved relative
    // to subdir/, so it must reach dir/shared/common.json.
    write("shared/common.json", { rules: [{ name: "common", action: "allow" }] });
    const entry = write("subdir/entry.json", {
      include: ["../shared/common.json"],
      rules: [{ name: "entry", action: "allow" }],
    });
    const names = resolvePolicyDocument([entry]).rules.map((r) => r["name"]).sort();
    expect(names).toEqual(["common", "entry"]);
  });

  it("rejects a circular include", () => {
    write("b.json", { include: ["./a.json"], rules: [] });
    const a = write("a.json", { include: ["./b.json"], rules: [] });
    expect(() => resolvePolicyDocument([a])).toThrow(KError);
    try {
      resolvePolicyDocument([a]);
    } catch (e) {
      expect((e as KError).message).toContain("Circular include");
    }
  });

  it("include never appears in the resolved document", () => {
    write("shared.json", { rules: [{ name: "shared", action: "allow" }] });
    const entry = write("main.json", { include: ["./shared.json"], rules: [] });
    const doc = resolvePolicyDocument([entry]);
    expect(JSON.stringify(doc)).not.toContain("include");
  });
});

describe("resolvePolicyDocument — diamond-dependency dedup vs genuine collision", () => {
  it("deduplicates a rule reached via two include paths with a BYTE-IDENTICAL definition (diamond dependency)", () => {
    write("common.json", { rules: [{ name: "shared-rule", when: { eq: ["x", 1] }, action: "allow" }] });
    const fileA = write("a.json", { include: ["./common.json"], rules: [{ name: "a-only", action: "allow" }] });
    const fileB = write("b.json", { include: ["./common.json"], rules: [{ name: "b-only", action: "allow" }] });
    const doc = resolvePolicyDocument([fileA, fileB]);
    const sharedCopies = doc.rules.filter((r) => r["name"] === "shared-rule");
    expect(sharedCopies.length).toBe(1); // deduped, not doubled
    expect(doc.rules.map((r) => r["name"]).sort()).toEqual(["a-only", "b-only", "shared-rule"]);
  });

  it("rejects the SAME rule name with a DIFFERENT definition as a genuine collision", () => {
    const fileA = write("a.json", { rules: [{ name: "dup", action: "allow" }] });
    const fileB = write("b.json", { rules: [{ name: "dup", action: "deny" }] });
    expect(() => resolvePolicyDocument([fileA, fileB])).toThrow(KError);
    try {
      resolvePolicyDocument([fileA, fileB]);
    } catch (e) {
      expect((e as KError).code).toBe("K9O_POLICY_RULE_COLLISION");
      expect((e as KError).message).toContain("dup");
    }
  });

  it("dedup checks the FULL definition, not just the name — differing when clauses still collide", () => {
    const fileA = write("a.json", { rules: [{ name: "r", when: { eq: ["x", 1] }, action: "allow" }] });
    const fileB = write("b.json", { rules: [{ name: "r", when: { eq: ["x", 2] }, action: "allow" }] });
    expect(() => resolvePolicyDocument([fileA, fileB])).toThrow(KError);
  });
});

describe("resolvePolicyDocument — explicit multi-file merge (mode 2)", () => {
  it("merges rules and policy blocks from several standalone entry files", () => {
    const fileA = write("a.json", {
      rules: [{ name: "ra", action: "allow" }],
      policy: { collections: { docs: { actions: { select: ["ra"] } } } },
    });
    const fileB = write("b.json", {
      rules: [{ name: "rb", action: "allow" }],
      policy: { collections: { notes: { actions: { select: ["rb"] } } } },
    });
    const doc = resolvePolicyDocument([fileA, fileB]);
    expect(doc.rules.map((r) => r["name"]).sort()).toEqual(["ra", "rb"]);
    expect(doc.policy).toEqual({
      collections: { docs: { actions: { select: ["ra"] } }, notes: { actions: { select: ["rb"] } } },
    });
  });

  it("concatenates + dedupes colliding rule-reference arrays at the same policy application point", () => {
    const fileA = write("a.json", {
      rules: [],
      policy: { collections: { docs: { actions: { select: ["r1", "r2"] } } } },
    });
    const fileB = write("b.json", {
      rules: [],
      policy: { collections: { docs: { actions: { select: ["r2", "r3"] } } } },
    });
    const doc = resolvePolicyDocument([fileA, fileB]);
    expect(doc.policy).toEqual({ collections: { docs: { actions: { select: ["r1", "r2", "r3"] } } } });
  });

  it("rejects conflicting shapes at the same policy path (object vs array)", () => {
    const fileA = write("a.json", { rules: [], policy: { collections: { docs: "not-an-object" } } });
    const fileB = write("b.json", { rules: [], policy: { collections: { docs: { actions: {} } } } });
    expect(() => resolvePolicyDocument([fileA, fileB])).toThrow(KError);
  });
});

describe("resolvePolicyDocument — malformed input", () => {
  it("rejects a non-array include", () => {
    const f = write("a.json", { include: "not-an-array", rules: [] });
    expect(() => resolvePolicyDocument([f])).toThrow(KError);
  });

  it("rejects a rule with no name", () => {
    const f = write("a.json", { rules: [{ action: "allow" }] });
    expect(() => resolvePolicyDocument([f])).toThrow(KError);
  });

  it("rejects an unrecognized top-level key", () => {
    const f = write("a.json", { rules: [], bogus: true });
    expect(() => resolvePolicyDocument([f])).toThrow(KError);
  });

  it("rejects a missing file with a clear error, not a raw ENOENT", () => {
    expect(() => resolvePolicyDocument([join(dir, "does-not-exist.json")])).toThrow(KError);
  });

  it("rejects invalid JSON", () => {
    const abs = join(dir, "bad.json");
    writeFileSync(abs, "{ not valid json");
    expect(() => resolvePolicyDocument([abs])).toThrow(KError);
  });

  it("requires at least one entry file", () => {
    expect(() => resolvePolicyDocument([])).toThrow(KError);
  });
});

describe("loadPolicyDocument — backward compatibility (critical safety property)", () => {
  it("a single file with NO include field passes through EXACTLY unchanged, any shape, including a legacy shape that wouldn't pass the new {rules,policy} validation", () => {
    // Deliberately NOT the shape (no "rules"/"policy" wrapper,
    // an arbitrary extra key) — proves existing customer files that
    // predate this feature are never touched or re-validated.
    const legacyShape = { someArbitraryLegacyKey: true, rules: { collections: {} } };
    const f = write("legacy.json", legacyShape);
    const result = loadPolicyDocument({ positional: ["policy", "apply", f], flags: {} });
    expect(result).toEqual(legacyShape);
  });

  it("a single file WITH an include field goes through the new resolution path", () => {
    write("common.json", { rules: [{ name: "shared", action: "allow" }] });
    const f = write("main.json", { include: ["./common.json"], rules: [{ name: "main", action: "allow" }] });
    const result = loadPolicyDocument({ positional: ["policy", "apply", f], flags: {} });
    expect((result["rules"] as unknown[]).length).toBe(2);
  });

  it("multiple positional files always go through the new resolution path", () => {
    const a = write("a.json", { rules: [{ name: "ra", action: "allow" }] });
    const b = write("b.json", { rules: [{ name: "rb", action: "allow" }] });
    const result = loadPolicyDocument({ positional: ["policy", "apply", a, b], flags: {} });
    expect((result["rules"] as unknown[]).map((r) => (r as Record<string, unknown>)["name"]).sort()).toEqual(["ra", "rb"]);
  });
});
