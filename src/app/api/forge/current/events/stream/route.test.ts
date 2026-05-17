import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/runtime/commands/route";
import { GET } from "./route";

describe("GET /api/forge/current/events/stream", () => {
  it("streams missed runtime events using SSE framing", async () => {
    await POST(
      new NextRequest("http://localhost/api/runtime/commands", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "localhost",
          origin: "http://localhost"
        },
        body: JSON.stringify({
          type: "reset_demo_state",
          idempotencyKey: `sse-reset-${Date.now()}-${Math.random()}`
        })
      })
    );
    await POST(
      new NextRequest("http://localhost/api/runtime/commands", {
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
      })
    );

    const response = await GET(new NextRequest("http://localhost/api/forge/current/events/stream?afterSequence=5&once=1"));
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
