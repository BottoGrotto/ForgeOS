import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { POST as createForge } from "@/app/api/forges/route";
import { createOperatorSession, SESSION_COOKIE } from "@/lib/auth/session";
import { GET } from "./route";

const originalClientId = process.env.GITHUB_CLIENT_ID;
const originalClientSecret = process.env.GITHUB_CLIENT_SECRET;
const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
const originalSessionSecret = process.env.FORGEOS_SESSION_SECRET;

describe("GET /api/github/oauth/start", () => {
  afterEach(() => {
    restoreEnv("GITHUB_CLIENT_ID", originalClientId);
    restoreEnv("GITHUB_CLIENT_SECRET", originalClientSecret);
    restoreEnv("NEXT_PUBLIC_APP_URL", originalAppUrl);
    restoreEnv("FORGEOS_SESSION_SECRET", originalSessionSecret);
  });

  it("redirects to GitHub with state and PKCE cookies", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id";
    process.env.GITHUB_CLIENT_SECRET = "client-secret";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3000";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const forgeSlug = await createTestForge();

    const response = await GET(authenticatedRequest(`http://localhost/api/github/oauth/start?forgeSlug=${forgeSlug}`));
    const location = response.headers.get("location");

    expect(response.status).toBe(307);
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=client-id");
    expect(location).toContain("scope=repo+read%3Auser");
    expect(response.headers.getSetCookie().join("\n")).toContain("forgeos_github_oauth_state");
    expect(response.headers.getSetCookie().join("\n")).toContain("forgeos_github_oauth_verifier");
  });

  it("rejects OAuth starts without an operator session", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id";
    process.env.GITHUB_CLIENT_SECRET = "client-secret";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const forgeSlug = await createTestForge();

    const response = await GET(new NextRequest(`http://localhost/api/github/oauth/start?forgeSlug=${forgeSlug}`));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(401);
    expect(payload).toEqual({ success: false, error: "Authentication required" });
  });

  it("canonicalizes 0.0.0.0 starts to localhost before setting OAuth cookies", async () => {
    const response = await GET(new NextRequest("http://0.0.0.0:3000/api/github/oauth/start?forgeSlug=example-forge", {
      headers: { host: "0.0.0.0:3000" }
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/api/github/oauth/start?forgeSlug=example-forge");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("does not loop when Next reports 0.0.0.0 but the browser host is localhost", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id";
    process.env.GITHUB_CLIENT_SECRET = "client-secret";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";

    const response = await GET(authenticatedRequest("http://0.0.0.0:3000/api/github/oauth/start?forgeSlug=missing-forge", {
      headers: { host: "localhost:3000" }
    }));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(404);
    expect(payload.error).toBe("Forge not found.");
  });

  it("rejects OAuth starts for missing Forges", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id";
    process.env.GITHUB_CLIENT_SECRET = "client-secret";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";

    const response = await GET(authenticatedRequest("http://localhost/api/github/oauth/start?forgeSlug=missing-forge"));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(404);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Forge not found.");
  });

  it("fails closed when GitHub OAuth env vars are missing", async () => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const forgeSlug = await createTestForge();

    const response = await GET(authenticatedRequest(`http://localhost/api/github/oauth/start?forgeSlug=${forgeSlug}`));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(500);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("GitHub OAuth is not configured.");
  });

  it("treats placeholder GitHub OAuth env vars as unconfigured", async () => {
    process.env.GITHUB_CLIENT_ID = "...";
    process.env.GITHUB_CLIENT_SECRET = "...";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
    const forgeSlug = await createTestForge();

    const response = await GET(authenticatedRequest(`http://localhost/api/github/oauth/start?forgeSlug=${forgeSlug}`));
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(500);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("GitHub OAuth is not configured.");
  });
});

async function createTestForge() {
  const response = await createForge(
    new NextRequest("http://localhost/api/forges", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://localhost"
      },
      body: JSON.stringify({ name: `OAuth Start Forge ${Date.now()} ${Math.random()}` })
    })
  );
  const payload = (await response.json()) as { data?: { forge: { slug: string } } };
  return payload.data!.forge.slug;
}

function authenticatedRequest(input: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const request = new NextRequest(input, init);
  request.cookies.set(SESSION_COOKIE, createOperatorSession());
  return request;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
