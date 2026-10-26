import { describe, expect, it } from "bun:test";

import { runChecks } from "../src/commands/doctor.ts";

// Status values are environment-dependent (docker up?, ports held?), so we
// assert the SHAPE: every expected check is present with a valid status. The
// human/json rendering is exercised by the smoke run.
describe("k9o doctor — preflight checks", () => {
  it("emits the expected check set with valid statuses", () => {
    const checks = runChecks();
    const names = checks.map((c) => c.name);

    for (const required of ["docker", "bun", "devproxy-backend"]) {
      expect(names).toContain(required);
    }
    // the 4 core stack ports
    for (const p of ["gateway", "console", "postgres", "pgbouncer"]) {
      expect(names).toContain(`port:${p}`);
    }

    for (const c of checks) {
      expect(["ok", "warn", "fail"]).toContain(c.status);
      expect(typeof c.detail).toBe("string");
      expect(c.detail.length).toBeGreaterThan(0);
    }
  });
});
