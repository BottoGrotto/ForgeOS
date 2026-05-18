import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const originalClientId = process.env.GITHUB_CLIENT_ID;
const originalClientSecret = process.env.GITHUB_CLIENT_SECRET;
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

describe("GET /api/github/oauth/start", () => {
  afterEach(() => {
    restoreEnv("GITHUB_CLIENT_ID", originalClientId);
    restoreEnv("GITHUB_CLIENT_SECRET", originalClientSecret);
    restoreEnv("NEXT_PUBLIC_APP_URL", originalAppUrl);
  });

  it("redirects to GitHub with state and PKCE cookies", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id";
    process.env.GITHUB_CLIENT_SECRET = "client-secret";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3000";

    const response = await GET(new NextRequest("http://localhost/api/github/oauth/start?forgeSlug=alpha"));
    const location = response.headers.get("location");

    expect(response.status).toBe(307);
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=client-id");
    expect(location).toContain("scope=repo+read%3Auser");
    expect(response.headers.getSetCookie().join("\n")).toContain("forgeos_github_oauth_state");
    expect(response.headers.getSetCookie().join("\n")).toContain("forgeos_github_oauth_verifier");
  });

  it("fails closed when GitHub OAuth env vars are missing", async () => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;

    const response = await GET(new NextRequest("http://localhost/api/github/oauth/start?forgeSlug=alpha"));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(500);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("GitHub OAuth is not configured.");
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
