/**
 * Unit tests for the CLI argument parser common flags.
 */

import { describe, expect, it } from "bun:test";
import { parseArgs, requireFlags } from "../src/args.ts";

describe("parseArgs", () => {
  it("parses positional + simple long flags", () => {
    const r = parseArgs(["project", "list", "--output", "json"]);
    expect(r.positional).toEqual(["project", "list"]);
    expect(r.flags["output"]).toBe("json");
  });

  it("parses short flags via map", () => {
    const r = parseArgs(["x", "-q", "-v"]);
    expect(r.flags["quiet"]).toBe("true");
    expect(r.flags["verbose"]).toBe("true");
  });

  it("treats boolean flags as no-value even when followed by positional", () => {
    const r = parseArgs(["--no-color", "command"]);
    expect(r.flags["no-color"]).toBe("true");
    expect(r.positional).toEqual(["command"]);
  });

  it("parses --key=value form", () => {
    const r = parseArgs(["--project=member-portal"]);
    expect(r.flags["project"]).toBe("member-portal");
  });

  it("sets flag to 'true' when no value follows", () => {
    const r = parseArgs(["--verbose"]);
    expect(r.flags["verbose"]).toBe("true");
  });

  it("does not consume next arg as value if it looks like a flag", () => {
    const r = parseArgs(["--project", "--org", "acme"]);
    // --project becomes true (since --org starts with -)
    expect(r.flags["project"]).toBe("true");
    expect(r.flags["org"]).toBe("acme");
  });

  it("multi-positional preserved in order", () => {
    const r = parseArgs(["project", "create", "my-proj", "--name", "My"]);
    expect(r.positional).toEqual(["project", "create", "my-proj"]);
    expect(r.flags["name"]).toBe("My");
  });
});

describe("requireFlags", () => {
  it("returns empty when all required present", () => {
    const r = parseArgs(["--a", "1", "--b", "2"]);
    expect(requireFlags(r, ["a", "b"])).toEqual([]);
  });
  it("returns missing flag names", () => {
    const r = parseArgs(["--a", "1"]);
    expect(requireFlags(r, ["a", "b", "c"])).toEqual(["b", "c"]);
  });
});
