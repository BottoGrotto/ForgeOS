import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { createOperatorSession, SESSION_COOKIE } from "@/lib/auth/session";
import { middleware } from "./middleware";

const originalSecret = process.env.FORGEOS_SESSION_SECRET;

describe("middleware auth guard", () => {
  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.FORGEOS_SESSION_SECRET;
    } else {
      process.env.FORGEOS_SESSION_SECRET = originalSecret;
    }
  });

  it("allows private pages with a valid operator session cookie", async () => {
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const request = new NextRequest("http://localhost/forges");
    request.cookies.set(SESSION_COOKIE, createOperatorSession());

    const response = await middleware(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("redirects private pages to login with a sanitized next path", async () => {
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const response = await middleware(new NextRequest("http://localhost/forge/demo?tab=logs"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login?next=%2Fforge%2Fdemo%3Ftab%3Dlogs");
  });

  it("returns 401 for private APIs without an operator session", async () => {
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const response = await middleware(new NextRequest("http://localhost/api/forges"));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(401);
    expect(payload).toEqual({ success: false, error: "Authentication required" });
  });

  it("allows GitHub OAuth callbacks through so the route can validate signed OAuth state", async () => {
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const response = await middleware(new NextRequest("http://localhost/api/github/oauth/callback?code=abc&state=xyz"));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("requires an operator session before starting GitHub OAuth", async () => {
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const response = await middleware(new NextRequest("http://localhost/api/github/oauth/start?forgeSlug=demo"));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(401);
    expect(payload).toEqual({ success: false, error: "Authentication required" });
  });
});
