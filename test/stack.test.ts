import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRunShArgs, resolveRunSh } from "../src/commands/stack.ts";
import type { ParsedArgs } from "../src/args.ts";

function pa(positional: string[], flags: Record<string, string> = {}): ParsedArgs {
  return { positional, flags };
}

describe("k9o stack — run.sh arg mapping (wrap, not reinvent)", () => {
  it("maps `stack up` (default tier) to `stack up` — NO crypto flags added (double-gate = run.sh default)", () => {
    expect(buildRunShArgs(pa(["stack", "up"]), false)).toEqual(["stack", "up"]);
  });

  it("maps each tier flag straight through (so --full -> run.sh real vault-ops verbatim)", () => {
    expect(buildRunShArgs(pa(["stack", "up"], { full: "true" }), false)).toEqual(["stack", "up", "--full"]);
    expect(buildRunShArgs(pa(["stack", "up"], { minimal: "true" }), false)).toEqual(["stack", "up", "--minimal"]);
    expect(buildRunShArgs(pa(["stack", "up"], { ai: "true" }), false)).toEqual(["stack", "up", "--ai"]);
  });

  it("passes --json through when output is json (run.sh status/up JSON contract)", () => {
    expect(buildRunShArgs(pa(["stack", "status"]), true)).toEqual(["stack", "status", "--json"]);
  });

  it("forwards `nuke --yes` and `logs <service>`", () => {
    expect(buildRunShArgs(pa(["stack", "nuke"], { yes: "true" }), false)).toEqual(["stack", "nuke", "--yes"]);
    expect(buildRunShArgs(pa(["stack", "logs", "gateway"]), false)).toEqual(["stack", "logs", "gateway"]);
  });

  it("does NOT add tier flags on non-up verbs", () => {
    expect(buildRunShArgs(pa(["stack", "down"], { full: "true" }), false)).toEqual(["stack", "down"]);
  });
});

describe("k9o stack — run.sh resolution", () => {
  const created: string[] = [];
  afterEach(() => {
    delete process.env.K9O_RUNSH_PATH;
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created.length = 0;
  });

  it("honors K9O_RUNSH_PATH when it exists (takes precedence over the upward search)", () => {
    const dir = mkdtempSync(join(tmpdir(), "k9o-runsh-"));
    created.push(dir);
    const p = join(dir, "run.sh");
    writeFileSync(p, "#!/usr/bin/env bash\n");
    process.env.K9O_RUNSH_PATH = p;
    expect(resolveRunSh()).toBe(p);
  });

  it("falls back to the upward k9o-core search and finds run.sh + infra/docker-compose.yml", () => {
    // No override → resolves the k9o-core checkout this monorepo lives in.
    const found = resolveRunSh();
    expect(found).not.toBeNull();
    expect(found!.endsWith("/run.sh")).toBe(true);
  });
});
