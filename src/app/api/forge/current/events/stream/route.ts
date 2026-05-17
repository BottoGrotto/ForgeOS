import { NextRequest } from "next/server";
import { runtimeStore } from "@/lib/runtime/store";
import type { RuntimeEvent } from "@/lib/runtime/types";

const encoder = new TextEncoder();

export async function GET(request: NextRequest) {
  const afterSequence = Number(request.nextUrl.searchParams.get("afterSequence") ?? "0");
  const once = request.nextUrl.searchParams.get("once") === "1";
  let lastSequence = Number.isFinite(afterSequence) ? afterSequence : 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const sendEvents = async () => {
        const events = await runtimeStore.getEvents(lastSequence);
        for (const event of events) {
          send(formatEvent(event));
          lastSequence = Math.max(lastSequence, event.sequence);
        }
      };

      await sendEvents();
      send(": heartbeat\n\n");

      if (once) {
        controller.close();
        return;
      }

      while (!request.signal.aborted) {
        await wait(3000);
        if (request.signal.aborted) {
          break;
        }
        await sendEvents();
        send(": heartbeat\n\n");
      }

      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    }
  });
}

function formatEvent(event: RuntimeEvent) {
  return `event: runtime.event\ndata: ${JSON.stringify(event)}\n\n`;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
