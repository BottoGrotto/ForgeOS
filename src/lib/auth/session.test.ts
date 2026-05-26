import { afterEach, describe, expect, it } from "vitest";
import { sanitizeNextPath } from "./redirect";
import { createOperatorSession, verifyOperatorSession } from "./session";

const originalSecret = process.env.FORGEOS_SESSION_SECRET;
const originalTokenSecret = process.env.FORGEOS_TOKEN_SECRET;

describe("operator session", () => {
  afterEach(() => {
    if (originalSecret) {
      process.env.FORGEOS_SESSION_SECRET = originalSecret;
    } else {
      delete process.env.FORGEOS_SESSION_SECRET;
    }
    if (originalTokenSecret) {
      process.env.FORGEOS_TOKEN_SECRET = originalTokenSecret;
    } else {
      delete process.env.FORGEOS_TOKEN_SECRET;
    }
  });

  it("signs and verifies an unexpired operator session", () => {
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const session = createOperatorSession(1_000);

    expect(verifyOperatorSession(session, 2_000)).toBe(true);
  });

  it("rejects tampered and expired sessions", () => {
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const session = createOperatorSession(1_000);

    expect(verifyOperatorSession(`${session}tampered`, 2_000)).toBe(false);
    expect(verifyOperatorSession(session, 9 * 60 * 60 * 1000)).toBe(false);
  });

  it("requires FORGEOS_SESSION_SECRET instead of falling back to FORGEOS_TOKEN_SECRET", () => {
    delete process.env.FORGEOS_SESSION_SECRET;
    process.env.FORGEOS_TOKEN_SECRET = "legacy-token-secret";

    expect(() => createOperatorSession()).toThrow("FORGEOS_SESSION_SECRET is required.");
    expect(() => verifyOperatorSession("payload.signature")).toThrow("FORGEOS_SESSION_SECRET is required.");
  });

  it("sanitizes post-login redirect targets to local page paths", () => {
    expect(sanitizeNextPath("/forges")).toBe("/forges");
    expect(sanitizeNextPath("/forge/demo?tab=logs")).toBe("/forge/demo?tab=logs");
    expect(sanitizeNextPath("//evil.test")).toBe("/forges");
    expect(sanitizeNextPath("https://evil.test/forges")).toBe("/forges");
    expect(sanitizeNextPath("/api/forges")).toBe("/forges");
    expect(sanitizeNextPath(null)).toBe("/forges");
  });
});
