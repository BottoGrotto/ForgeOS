import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";

const originalPassword = process.env.FORGEOS_OPERATOR_PASSWORD;
const originalSecret = process.env.FORGEOS_SESSION_SECRET;

describe("POST /api/auth/login", () => {
  afterEach(() => {
    restoreEnv("FORGEOS_OPERATOR_PASSWORD", originalPassword);
    restoreEnv("FORGEOS_SESSION_SECRET", originalSecret);
  });

  it("creates an operator session for the configured password", async () => {
    process.env.FORGEOS_OPERATOR_PASSWORD = "correct";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";

    const response = await POST(loginRequest("correct"));
    const payload = (await response.json()) as { success: boolean; data?: { authenticated: boolean } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.authenticated).toBe(true);
    expect(response.headers.getSetCookie().join("\n")).toContain("forgeos_session");
  });

  it("rejects invalid passwords", async () => {
    process.env.FORGEOS_OPERATOR_PASSWORD = "correct";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";

    const response = await POST(loginRequest("wrong"));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(401);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Invalid operator password");
  });
});

function loginRequest(password: string) {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      origin: "http://localhost"
    },
    body: JSON.stringify({ password })
  });
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
