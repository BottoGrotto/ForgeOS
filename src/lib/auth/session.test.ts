import { afterEach, describe, expect, it } from "vitest";
import { createOperatorSession, verifyOperatorSession } from "./session";

const originalSecret = process.env.FORGEOS_SESSION_SECRET;

describe("operator session", () => {
  afterEach(() => {
    if (originalSecret) {
      process.env.FORGEOS_SESSION_SECRET = originalSecret;
    } else {
      delete process.env.FORGEOS_SESSION_SECRET;
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
});
