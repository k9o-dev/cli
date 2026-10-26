/**
 * Unit tests for the CLI exit-code map per the error-family taxonomy.
 */

import { describe, expect, it } from "bun:test";
import { KError } from "@k9o/core";
import {
  exitCodeForError,
  EXIT_GENERIC,
  EXIT_MISSING_CONTEXT,
  EXIT_AUTH,
  EXIT_AUTHORITY,
  EXIT_NOT_FOUND,
  EXIT_CONFLICT,
  EXIT_VALIDATION_PARSE,
  EXIT_VALIDATION_SEMANTIC,
  EXIT_CAPACITY,
  EXIT_UPSTREAM_UNAVAILABLE,
  EXIT_TOKEN_EXPIRED,
} from "../src/exit-codes.ts";

describe("exitCodeForError — code-based", () => {
  it("maps K9O_MISSING_PROJECT_CONTEXT → 65", () => {
    expect(exitCodeForError(new KError({ code: "K9O_MISSING_PROJECT_CONTEXT", message: "x" }))).toBe(EXIT_MISSING_CONTEXT);
  });

  it("maps MISSING_PROJECT_CONTEXT → 65 (unprefixed canonical name)", () => {
    expect(exitCodeForError(new KError({ code: "MISSING_PROJECT_CONTEXT", message: "x" }))).toBe(EXIT_MISSING_CONTEXT);
  });

  it("maps K9O_INVALID_BUCKET_NAME → 70 by its family, whatever the HTTP status", () => {
    // Status 500 so only the code can send it to 70: a status-based rule would not.
    expect(exitCodeForError(new KError({ code: "K9O_INVALID_BUCKET_NAME", message: "x", status: 500 }))).toBe(EXIT_VALIDATION_PARSE);
    expect(exitCodeForError(new KError({ code: "K9O_INVALID_BUCKET_NAME", message: "x" }))).toBe(EXIT_VALIDATION_PARSE);
  });

  it("maps K9O_INVALID_FIELD_VALUE → 70 (parse-time)", () => {
    expect(exitCodeForError(new KError({ code: "K9O_INVALID_FIELD_VALUE", message: "x" }))).toBe(EXIT_VALIDATION_PARSE);
  });

  it("maps K9O_INVALID_CHARACTER → 70 (parse-time,)", () => {
    expect(exitCodeForError(new KError({ code: "K9O_INVALID_CHARACTER", message: "x" }))).toBe(EXIT_VALIDATION_PARSE);
  });

  it("maps K9O_POLICY_RULE_COLLISION → 70 (parse-time,)", () => {
    expect(exitCodeForError(new KError({ code: "K9O_POLICY_RULE_COLLISION", message: "x" }))).toBe(EXIT_VALIDATION_PARSE);
  });

  it("maps K9O_TIER_CAP_HIT → 72 (capacity)", () => {
    expect(exitCodeForError(new KError({ code: "K9O_TIER_CAP_HIT", message: "x" }))).toBe(EXIT_CAPACITY);
  });

  it("maps K9O_UPSTREAM_UNAVAILABLE → 73", () => {
    expect(exitCodeForError(new KError({ code: "K9O_UPSTREAM_UNAVAILABLE", message: "x" }))).toBe(EXIT_UPSTREAM_UNAVAILABLE);
  });

  it("maps SESSION_EXPIRED → 74 (token-expired)", () => {
    expect(exitCodeForError(new KError({ code: "SESSION_EXPIRED", message: "x" }))).toBe(EXIT_TOKEN_EXPIRED);
  });

  it("maps INVALID_CREDENTIALS → 66 (auth)", () => {
    expect(exitCodeForError(new KError({ code: "INVALID_CREDENTIALS", message: "x" }))).toBe(EXIT_AUTH);
  });

  it("maps RBAC_DENY → 67 (authority)", () => {
    expect(exitCodeForError(new KError({ code: "RBAC_DENY", message: "x" }))).toBe(EXIT_AUTHORITY);
  });

  it("maps *_NOT_FOUND → 68", () => {
    expect(exitCodeForError(new KError({ code: "PROJECT_NOT_FOUND", message: "x" }))).toBe(EXIT_NOT_FOUND);
    expect(exitCodeForError(new KError({ code: "K9O_USER_NOT_FOUND", message: "x" }))).toBe(EXIT_NOT_FOUND);
  });

  it("maps *_CONFLICT / *_ALREADY_* → 69", () => {
    expect(exitCodeForError(new KError({ code: "K9O_SLUG_CONFLICT", message: "x" }))).toBe(EXIT_CONFLICT);
    expect(exitCodeForError(new KError({ code: "EMAIL_ALREADY_REGISTERED", message: "x" }))).toBe(EXIT_CONFLICT);
  });
});

describe("exitCodeForError — status fallback", () => {
  it("maps status 404 → 68", () => {
    expect(exitCodeForError(new KError({ code: "X", message: "y", status: 404 }))).toBe(EXIT_NOT_FOUND);
  });
  it("keeps the workflow trigger/action shape errors on 71 (semantic) now that the gateway returns them as 400", () => {
    for (const code of ["K9O_WORKFLOW_TRIGGER_INVALID", "K9O_WORKFLOW_ACTION_INVALID"]) {
      expect(exitCodeForError(new KError({ code, message: "x", status: 400 }))).toBe(EXIT_VALIDATION_SEMANTIC);
    }
    expect(exitCodeForError(new KError({ code: "K9O_WORKFLOW_WEBHOOK_SIGNATURE_INVALID", message: "x", status: 401 }))).toBe(EXIT_AUTH);
    expect(exitCodeForError(new KError({ code: "K9O_TIER_CAP_HIT", message: "x", status: 409 }))).toBe(EXIT_CAPACITY);
  });

  it("maps status 422 → 71 (semantic)", () => {
    expect(exitCodeForError(new KError({ code: "X", message: "y", status: 422 }))).toBe(EXIT_VALIDATION_SEMANTIC);
  });
  it("maps status 5xx → 73 (upstream)", () => {
    expect(exitCodeForError(new KError({ code: "X", message: "y", status: 500 }))).toBe(EXIT_UPSTREAM_UNAVAILABLE);
    expect(exitCodeForError(new KError({ code: "X", message: "y", status: 503 }))).toBe(EXIT_UPSTREAM_UNAVAILABLE);
  });
});

describe("exitCodeForError — fallback", () => {
  it("maps non-KError to EXIT_GENERIC", () => {
    expect(exitCodeForError(new Error("plain"))).toBe(EXIT_GENERIC);
    expect(exitCodeForError("string thrown")).toBe(EXIT_GENERIC);
  });
});
