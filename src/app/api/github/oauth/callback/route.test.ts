import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createForge } from "@/app/api/forges/route";
import { exchangeGitHubOAuthCode } from "@/lib/github/client";
import { createGitHubOAuthStart } from "@/lib/github/oauth";
import { createOperatorSession, SESSION_COOKIE } from "@/lib/auth/session";
import { runtimeStore } from "@/lib/runtime/store";
import { GET } from "./route";

vi.mock("@/lib/github/client", () => ({
  exchangeGitHubOAuthCode: vi.fn(async () => ({
    accessToken: "gho_test_token",
    tokenType: "bearer",
    scopes: ["repo", "read:user"]
  })),
  fetchGitHubAuthenticatedUser: vi.fn(async () => ({
    id: "123",
    login: "octocat"
  }))
}));

const originalClientId = process.env.GITHUB_CLIENT_ID;
const originalClientSecret = process.env.GITHUB_CLIENT_SECRET;
const originalTokenSecret = process.env.FORGEOS_TOKEN_SECRET;
const originalSessionSecret = process.env.FORGEOS_SESSION_SECRET;

describe("GET /api/github/oauth/callback", () => {
  beforeEach(() => {
    process.env.GITHUB_CLIENT_ID = "client-id";
    process.env.GITHUB_CLIENT_SECRET = "client-secret";
    process.env.FORGEOS_TOKEN_SECRET = "test-token-secret";
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
  });

  afterEach(() => {
    vi.clearAllMocks();
    restoreEnv("GITHUB_CLIENT_ID", originalClientId);
    restoreEnv("GITHUB_CLIENT_SECRET", originalClientSecret);
    restoreEnv("FORGEOS_TOKEN_SECRET", originalTokenSecret);
    restoreEnv("FORGEOS_SESSION_SECRET", originalSessionSecret);
  });

  it("exchanges a valid callback and stores the GitHub account outside snapshots", async () => {
    const forgeSlug = await createTestForge();
    const response = await GET(callbackRequest({ forgeSlug, verifier: "verifier-123" }));
    const location = response.headers.get("location");
    const account = await runtimeStore.getGitHubAccount(forgeSlug);
    const snapshot = await runtimeStore.getSnapshot(forgeSlug);

    expect(response.status).toBe(307);
    expect(location).toBe(`http://localhost/forge/${forgeSlug}/workspace?github=connected`);
    expect(response.headers.getSetCookie().join("\n")).toContain("forgeos_github_oauth_state=");
    expect(account).toMatchObject({ accountLogin: "octocat", accountId: "123", scopes: ["repo", "read:user"] });
    expect(JSON.stringify(snapshot)).not.toContain("gho_test_token");
  });

  it("fails closed and clears cookies when callback state does not match", async () => {
    const forgeSlug = await createTestForge();
    const response = await GET(callbackRequest({ forgeSlug, verifier: "verifier-123", callbackState: "other-state" }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`http://localhost/forge/${forgeSlug}/workspace?github=oauth_failed`);
    expect(response.headers.getSetCookie().join("\n")).toContain("forgeos_github_oauth_state=");
  });

  it("does not redirect malformed Forge cookie values into app paths", async () => {
    const response = await GET(callbackRequest({ forgeSlug: "//evil.test", verifier: "verifier-123" }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/forges?github=oauth_failed");
    expect(exchangeGitHubOAuthCode).not.toHaveBeenCalled();
  });

  it("does not exchange a callback without the authenticated session that started OAuth", async () => {
    const forgeSlug = await createTestForge();
    const response = await GET(callbackRequest({ forgeSlug, verifier: "verifier-123", includeSession: false }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`http://localhost/forge/${forgeSlug}/workspace?github=oauth_failed`);
    expect(exchangeGitHubOAuthCode).not.toHaveBeenCalled();
  });
});

function callbackRequest(input: { forgeSlug: string; verifier: string; callbackState?: string; includeSession?: boolean }) {
  const session = createOperatorSession();
  const start = createGitHubOAuthStart(
    { clientId: "client-id", clientSecret: "client-secret", redirectUri: "http://localhost/api/github/oauth/callback" },
    { forgeSlug: input.forgeSlug, session }
  );
  const request = new NextRequest(`http://localhost/api/github/oauth/callback?code=code-123&state=${input.callbackState ?? start.state}`);
  if (input.includeSession !== false) {
    request.cookies.set(SESSION_COOKIE, session);
  }
  request.cookies.set("forgeos_github_oauth_state", start.state);
  request.cookies.set("forgeos_github_oauth_verifier", input.verifier);
  request.cookies.set("forgeos_github_oauth_forge", input.forgeSlug);
  return request;
}

async function createTestForge() {
  const response = await createForge(
    new NextRequest("http://localhost/api/forges", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://localhost"
      },
      body: JSON.stringify({ name: `OAuth Callback Forge ${Date.now()} ${Math.random()}` })
    })
  );
  const payload = (await response.json()) as { data?: { forge: { slug: string } } };
  return payload.data!.forge.slug;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
