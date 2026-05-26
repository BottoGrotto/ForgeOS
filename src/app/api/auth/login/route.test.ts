import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { resetLoginRateLimitForTests } from "@/lib/auth/login-rate-limit";
import { POST } from "./route";

const originalPassword = process.env.FORGEOS_OPERATOR_PASSWORD;
const originalSecret = process.env.FORGEOS_SESSION_SECRET;
const originalTrustedProxyHeaders = process.env.FORGEOS_TRUSTED_PROXY_HEADERS;

describe("POST /api/auth/login", () => {
  afterEach(() => {
    restoreEnv("FORGEOS_OPERATOR_PASSWORD", originalPassword);
    restoreEnv("FORGEOS_SESSION_SECRET", originalSecret);
    restoreEnv("FORGEOS_TRUSTED_PROXY_HEADERS", originalTrustedProxyHeaders);
    resetLoginRateLimitForTests();
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

  it("rate limits repeated invalid passwords by client address", async () => {
    process.env.FORGEOS_OPERATOR_PASSWORD = "correct";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await POST(loginRequest("wrong", "203.0.113.10"));
      expect(response.status).toBe(401);
    }

    const limited = await POST(loginRequest("wrong", "203.0.113.10"));
    const payload = (await limited.json()) as { success: boolean; error?: string };

    expect(limited.status).toBe(429);
    expect(payload).toEqual({ success: false, error: "Too many login attempts. Try again shortly." });
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("does not let arbitrary x-forwarded-for values bypass login rate limiting by default", async () => {
    process.env.FORGEOS_OPERATOR_PASSWORD = "correct";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    delete process.env.FORGEOS_TRUSTED_PROXY_HEADERS;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await POST(loginRequest("wrong", `203.0.113.${attempt}`));
      expect(response.status).toBe(401);
    }

    const limited = await POST(loginRequest("wrong", "203.0.113.99"));

    expect(limited.status).toBe(429);
  });

  it("uses forwarded addresses only when trusted proxy headers are enabled", async () => {
    process.env.FORGEOS_OPERATOR_PASSWORD = "correct";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    process.env.FORGEOS_TRUSTED_PROXY_HEADERS = "true";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await POST(loginRequest("wrong", "203.0.113.10"));
      expect(response.status).toBe(401);
    }

    const differentForwardedAddress = await POST(loginRequest("wrong", "203.0.113.11"));

    expect(differentForwardedAddress.status).toBe(401);
  });

  it("fails closed when mutating requests omit same-origin metadata", async () => {
    process.env.FORGEOS_OPERATOR_PASSWORD = "correct";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";

    const response = await POST(loginRequest("correct", "127.0.0.1", {}));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(403);
    expect(payload).toEqual({ success: false, error: "Invalid request origin" });
  });

  it("accepts same-origin referer when origin is absent", async () => {
    process.env.FORGEOS_OPERATOR_PASSWORD = "correct";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";

    const response = await POST(loginRequest("correct", "127.0.0.1", { referer: "http://localhost/login" }));

    expect(response.status).toBe(200);
  });

  it("returns a client error for malformed JSON instead of masking it as server config", async () => {
    process.env.FORGEOS_OPERATOR_PASSWORD = "correct";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";

    const response = await POST(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: "{"
      })
    );
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(400);
    expect(payload).toEqual({ success: false, error: "Invalid login request" });
  });
});

function loginRequest(password: string, address = "127.0.0.1", originHeaders: Record<string, string> = { origin: "http://localhost" }) {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      "x-forwarded-for": address,
      ...originHeaders
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
