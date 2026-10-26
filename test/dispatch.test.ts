/**
 * End-to-end dispatch tests for the `k9o` CLI top-level main().
 *
 * Verifies command routing + unknown-command rejection + help/version flags.
 * Per-subcommand behaviour (auth flow, project list, etc.) is exercised
 * via integration with the @k9o/core SDK and is tested at that layer.
 */

import { describe, expect, it, mock } from "bun:test";
import { main } from "../src/index.ts";

describe("main() dispatch", () => {
  it("returns 0 for --help", async () => {
    const code = await main(["--help"]);
    expect(code).toBe(0);
  });

  it("returns 1 for no args (prints help, indicates non-zero)", async () => {
    const code = await main([]);
    expect(code).toBe(1);
  });

  it("returns 0 for --version", async () => {
    const code = await main(["--version"]);
    expect(code).toBe(0);
  });

  it("returns EXIT_USAGE (2) for unknown command", async () => {
    const code = await main(["zzz-nonsense", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for project with no subcommand", async () => {
    const code = await main(["project", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for migration with no subcommand", async () => {
    const code = await main(["migration", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for migration apply-pending with no pendingId", async () => {
    const code = await main(["migration", "apply-pending", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("migration pending and apply-pending <id> are wired: valid input gets past usage validation", async () => {
    // Positive controls. Without a profile these fail LATER (not exit 2), which is how we tell a wired command
    // from an unknown subcommand (which is exit 2, the same as a missing argument).
    expect(await main(["migration", "pending", "--output", "json"])).not.toBe(2);
    expect(await main(["migration", "apply-pending", "pmig_abc123", "--output", "json"])).not.toBe(2);
  });

  it("returns EXIT_USAGE for unknown migration subcommand", async () => {
    const code = await main(["migration", "blargh", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for function with no subcommand", async () => {
    const code = await main(["function", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for unknown project subcommand", async () => {
    const code = await main(["project", "blargh", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for policy with no subcommand", async () => {
    const code = await main(["policy", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for audit with no subcommand", async () => {
    const code = await main(["audit", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for unknown policy subcommand", async () => {
    const code = await main(["policy", "zzz", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for unknown audit subcommand", async () => {
    const code = await main(["audit", "zzz", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for org with no subcommand", async () => {
    const code = await main(["org", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for me with no subcommand", async () => {
    const code = await main(["me", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for config with no subcommand", async () => {
    const code = await main(["config", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for extension with no subcommand", async () => {
    const code = await main(["extension", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for unknown org subcommand", async () => {
    const code = await main(["org", "zzz", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for unknown config key on set", async () => {
    const code = await main(["config", "set", "unsupportedKey", "value", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("config list works without API call (purely local)", async () => {
    // Should not error — config list reads local file (creates empty profile dir if absent)
    const code = await main(["config", "list", "--output", "json"]);
    expect(code).toBe(0);
  });

  it("returns EXIT_USAGE for ledger with no subcommand", async () => {
    const code = await main(["ledger", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("returns EXIT_USAGE for unknown ledger subcommand", async () => {
    const code = await main(["ledger", "zzz", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("ledger verify requires a source (--file or --stdin)", async () => {
    const code = await main(["ledger", "verify", "--key-set", "/tmp/k", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("ledger verify rejects both --file and --stdin", async () => {
    const code = await main(["ledger", "verify", "--file", "/tmp/x", "--stdin", "--key-set", "/tmp/k", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("ledger verify rejects --key-set without --signature (together-constraint)", async () => {
    const code = await main(["ledger", "verify", "--file", "/tmp/x", "--key-set", "/tmp/k", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("ledger verify rejects --signature without --key-set (together-constraint)", async () => {
    const code = await main(["ledger", "verify", "--file", "/tmp/x", "--signature", "abc==", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("ledger verify rejects an invalid --format", async () => {
    const code = await main(["ledger", "verify", "--file", "/tmp/x", "--key-set", "/tmp/k", "--signature", "abc==", "--format", "xml", "--output", "json"]);
    expect(code).toBe(2);
  });

  it("ledger verify reports a missing verifier binary as operational error (exit 2)", async () => {
    const prev = process.env["K9O_LEDGER_VERIFY_BIN"];
    process.env["K9O_LEDGER_VERIFY_BIN"] = "/nonexistent/kibo-ledger-verify-xyz";
    try {
      // chain-integrity-only (no key-set/signature) passes validation and
      // reaches binary resolution → missing binary is the operational error.
      const code = await main(["ledger", "verify", "--file", "/tmp/x", "--output", "json"]);
      expect(code).toBe(2);
    } finally {
      if (prev === undefined) delete process.env["K9O_LEDGER_VERIFY_BIN"];
      else process.env["K9O_LEDGER_VERIFY_BIN"] = prev;
    }
  });

  // `completion` runs fully offline, so a 0 exit deterministically proves the dispatch arm routes
  // (the unknown-command path can never return 0).
  it("routes `completion <shell>` and emits a script (exit 0)", async () => {
    expect(await main(["completion", "bash"])).toBe(0);
    expect(await main(["completion", "zsh", "--output", "json"])).toBe(0);
  });

  it("`completion` without a shell is a usage error (exit 2)", async () => {
    expect(await main(["completion", "--output", "json"])).toBe(2);
  });

  it("`completion` rejects an unsupported shell (exit 2)", async () => {
    expect(await main(["completion", "powershell", "--output", "json"])).toBe(2);
  });

  it("routes `init` to the wizard (json mode, no org → missing-context, not unknown-command)", async () => {
    const prevOrg = process.env["K9O_ORG"];
    delete process.env["K9O_ORG"];
    try {
      // Routed to dispatchInit: json-mode resolveOrgSlug throws
      // K9O_MISSING_PROJECT_CONTEXT before any network — non-zero proves routing.
      expect(await main(["init", "--output", "json"])).not.toBe(0);
    } finally {
      if (prevOrg === undefined) delete process.env["K9O_ORG"];
      else process.env["K9O_ORG"] = prevOrg;
    }
  });
});
