import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const originalClientId = process.env.GITHUB_CLIENT_ID;
const originalClientSecret = process.env.GITHUB_CLIENT_SECRET;
const originalAppUrl = process.env.FORGEOS_APP_URL;

describe("GET /api/github/oauth/config", () => {
  afterEach(() => {
    restoreEnv("GITHUB_CLIENT_ID", originalClientId);
    restoreEnv("GITHUB_CLIENT_SECRET", originalClientSecret);
    restoreEnv("FORGEOS_APP_URL", originalAppUrl);
  });

  it("reports missing placeholder OAuth configuration without redirecting to GitHub", async () => {
    process.env.GITHUB_CLIENT_ID = "...";
    process.env.GITHUB_CLIENT_SECRET = "...";
    process.env.FORGEOS_APP_URL = "http://localhost:3000";

    const response = await GET(new NextRequest("http://localhost/api/github/oauth/config"));
    const payload = (await response.json()) as { success: boolean; data?: { configured: boolean; missing: string[]; callbackUrl: string; applicationSettingsUrl?: string } };

    expect(response.status).toBe(200);
    expect(payload.data).toEqual({
      configured: false,
      missing: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      callbackUrl: "http://localhost:3000/api/github/oauth/callback",
      applicationSettingsUrl: undefined
    });
  });

  it("reports configured OAuth credentials", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id";
    process.env.GITHUB_CLIENT_SECRET = "client-secret";

    const response = await GET(new NextRequest("http://localhost/api/github/oauth/config"));
    const payload = (await response.json()) as { success: boolean; data?: { configured: boolean; missing: string[]; applicationSettingsUrl?: string } };

    expect(response.status).toBe(200);
    expect(payload.data?.configured).toBe(true);
    expect(payload.data?.missing).toEqual([]);
    expect(payload.data?.applicationSettingsUrl).toBe("https://github.com/settings/connections/applications/client-id");
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
