import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createForge } from "@/app/api/forges/route";
import { POST as command } from "@/app/api/forges/[forgeSlug]/commands/route";
import { createOperatorSession, SESSION_COOKIE } from "@/lib/auth/session";
import { GET } from "./route";

const originalSessionSecret = process.env.FORGEOS_SESSION_SECRET;

describe("GET /api/forges/[forgeSlug]/events", () => {
  beforeEach(() => {
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
  });

  afterEach(() => {
    restoreEnv("FORGEOS_SESSION_SECRET", originalSessionSecret);
  });

  it("rejects event reads without an operator session", async () => {
    const response = await GET(new NextRequest("http://localhost/api/forges/demo/events"), {
      params: Promise.resolve({ forgeSlug: "demo" })
    });
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(401);
    expect(payload).toEqual({ success: false, error: "Authentication required" });
  });

  it("returns missed events for authenticated operators", async () => {
    const forgeSlug = await createTestForge();
    await command(
      new NextRequest(`http://localhost/api/forges/${forgeSlug}/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({
          type: "pause_forge",
          idempotencyKey: "events-pause-forge"
        })
      }),
      { params: Promise.resolve({ forgeSlug }) }
    );

    const response = await GET(authenticatedRequest(`http://localhost/api/forges/${forgeSlug}/events?afterSequence=5`), {
      params: Promise.resolve({ forgeSlug })
    });
    const payload = (await response.json()) as { success: boolean; data?: Array<{ type: string }> };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data?.map((event) => event.type)).toEqual(expect.arrayContaining(["runtime.paused"]));
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
      body: JSON.stringify({ name: `Events API Forge ${Date.now()} ${Math.random()}`, template: "demo" })
    })
  );
  const payload = (await response.json()) as { data?: { forge: { slug: string } } };
  return payload.data!.forge.slug;
}

function authenticatedRequest(input: string) {
  const request = new NextRequest(input);
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
