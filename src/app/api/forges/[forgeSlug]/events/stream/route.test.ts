import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { POST as createForge } from "@/app/api/forges/route";
import { POST as command } from "@/app/api/forges/[forgeSlug]/commands/route";
import { GET } from "./route";

describe("GET /api/forges/[forgeSlug]/events/stream", () => {
  it("streams missed runtime events using SSE framing", async () => {
    const created = await createForge(
      new NextRequest("http://localhost/api/forges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({ name: `SSE Forge ${Date.now()} ${Math.random()}` })
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

    const response = await GET(new NextRequest(`http://localhost/api/forges/${forgeSlug}/events/stream?afterSequence=5&once=1`), {
      params: Promise.resolve({ forgeSlug })
    });
    const body = await readStream(response.body);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: runtime.event");
    expect(body).toContain("\"type\":\"runtime.paused\"");
    expect(body).toContain(": heartbeat");
  });
});

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
