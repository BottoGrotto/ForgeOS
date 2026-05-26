import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createForge } from "@/app/api/forges/route";
import { POST as command } from "@/app/api/forges/[forgeSlug]/commands/route";
import { createOperatorSession, SESSION_COOKIE } from "@/lib/auth/session";
import { runtimeStore } from "@/lib/runtime/store";
import { GET } from "./route";

const originalSessionSecret = process.env.FORGEOS_SESSION_SECRET;

describe("GET /api/forges/[forgeSlug]/events/stream", () => {
  beforeEach(() => {
    process.env.FORGEOS_SESSION_SECRET = "test-session-secret";
  });

  afterEach(() => {
    restoreEnv("FORGEOS_SESSION_SECRET", originalSessionSecret);
  });

  it("rejects event streams without an operator session", async () => {
    const response = await GET(new NextRequest("http://localhost/api/forges/demo/events/stream?once=1"), {
      params: Promise.resolve({ forgeSlug: "demo" })
    });
    const payload = (await response.json()) as { success: boolean; error?: string };

    expect(response.status).toBe(401);
    expect(payload).toEqual({ success: false, error: "Authentication required" });
  });

  it("streams missed runtime events using SSE framing", async () => {
    const created = await createForge(
      new NextRequest("http://localhost/api/forges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({ name: `SSE Forge ${Date.now()} ${Math.random()}`, template: "demo" })
      })
    );
    const createdPayload = (await created.json()) as { data?: { forge: { slug: string } } };
    const forgeSlug = createdPayload.data!.forge.slug;

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
          idempotencyKey: "sse-pause-forge"
        })
      }),
      { params: Promise.resolve({ forgeSlug }) }
    );

    const response = await GET(authenticatedRequest(`http://localhost/api/forges/${forgeSlug}/events/stream?afterSequence=5&once=1`), {
      params: Promise.resolve({ forgeSlug })
    });
    const body = await readStream(response.body);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: runtime.event");
    expect(body).toContain("\"type\":\"runtime.paused\"");
    expect(body).toContain(": heartbeat");
  });

  it("streams queued and started run events after execution begins", async () => {
    const created = await createForge(
      new NextRequest("http://localhost/api/forges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({ name: `SSE Run Forge ${Date.now()} ${Math.random()}`, template: "demo" })
      })
    );
    const createdPayload = (await created.json()) as { data?: { forge: { slug: string } } };
    const forgeSlug = createdPayload.data!.forge.slug;
    const operationId = `${forgeSlug}-op-runtime`;

    await command(
      new NextRequest(`http://localhost/api/forges/${forgeSlug}/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({
          type: "run_operation",
          operationId,
          idempotencyKey: "sse-run-operation"
        })
      }),
      { params: Promise.resolve({ forgeSlug }) }
    );
    await waitForEvent(forgeSlug, "run.started");

    const response = await GET(authenticatedRequest(`http://localhost/api/forges/${forgeSlug}/events/stream?afterSequence=0&once=1`), {
      params: Promise.resolve({ forgeSlug })
    });
    const body = await readStream(response.body);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("\"type\":\"run.queued\"");
    expect(body).toContain("\"type\":\"run.started\"");
    expect(body).toContain(`"operationId":"${operationId}"`);
    expect(body).toContain(": heartbeat");
  });

  it("sends SSE error events when in-stream event loading fails", async () => {
    const forgeSlug = await createTestForge();
    const getEvents = runtimeStore.getEvents;
    runtimeStore.getEvents = async (...args) => {
      void args;
      throw new Error("event store unavailable");
    };

    try {
      const response = await GET(authenticatedRequest(`http://localhost/api/forges/${forgeSlug}/events/stream?afterSequence=0&once=1`), {
        params: Promise.resolve({ forgeSlug })
      });
      const body = await readStream(response.body);

      expect(response.status).toBe(200);
      expect(body).toContain("event: runtime.error");
      expect(body).toContain("\"message\":\"Event stream failed\"");
    } finally {
      runtimeStore.getEvents = getEvents;
    }
  });
});

async function createTestForge() {
  const created = await createForge(
    new NextRequest("http://localhost/api/forges", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost",
        origin: "http://localhost"
      },
      body: JSON.stringify({ name: `SSE Error Forge ${Date.now()} ${Math.random()}`, template: "demo" })
    })
  );
  const createdPayload = (await created.json()) as { data?: { forge: { slug: string } } };
  return createdPayload.data!.forge.slug;
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

async function waitForEvent(forgeSlug: string, type: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const events = await runtimeStore.getEvents(forgeSlug, 0);
    if (events.some((event) => event.type === type)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readStream(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let body = "";

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    body += decoder.decode(result.value, { stream: true });
  }

  body += decoder.decode();
  return body;
}
