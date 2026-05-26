import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoSnapshot } from "@/lib/mock/seed";
import { useForgeStore } from "./forge-store";

class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  readonly url: string;
  closed = false;

  constructor(url: string) {
    super();
    this.url = url;
    TestEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emitRuntimeEvent(sequence: number) {
    this.dispatchEvent(
      new MessageEvent("runtime.event", {
        data: JSON.stringify({
          id: `event-${sequence}`,
          forgeId: "forge",
          sequence,
          type: "run.progress",
          actorType: "runtime",
          message: "progress",
          severity: "info",
          payload: {},
          createdAt: new Date().toISOString()
        })
      })
    );
  }
}

describe("forge store event stream refresh", () => {
  const OriginalEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    TestEventSource.instances = [];
    globalThis.EventSource = TestEventSource as unknown as typeof EventSource;
    useForgeStore.setState({
      snapshot: null,
      selected: null,
      activePanel: "overview",
      inspectorTab: "summary",
      commandPending: false,
      commandError: null
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.EventSource = OriginalEventSource;
    vi.restoreAllMocks();
  });

  it("refreshes each forge snapshot independently from runtime events", async () => {
    const demo = createDemoSnapshot();
    const alpha = { ...demo, forge: { ...demo.forge, id: "alpha-id", slug: "alpha" }, lastEventSequence: 11 };
    const beta = { ...demo, forge: { ...demo.forge, id: "beta-id", slug: "beta" }, lastEventSequence: 12 };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/alpha/")) {
        return Response.json({ success: true, data: alpha });
      }
      if (url.includes("/beta/")) {
        return Response.json({ success: true, data: beta });
      }
      return Response.json({ success: false });
    });
    globalThis.fetch = fetchMock;

    const disconnectAlpha = useForgeStore.getState().connectEventStream("alpha", 0);
    TestEventSource.instances[0].emitRuntimeEvent(11);
    const disconnectBeta = useForgeStore.getState().connectEventStream("beta", 0);
    TestEventSource.instances[1].emitRuntimeEvent(12);

    await vi.advanceTimersByTimeAsync(200);

    expect(fetchMock).toHaveBeenCalledWith("/api/forges/alpha/snapshot", { cache: "no-store" });
    expect(fetchMock).toHaveBeenCalledWith("/api/forges/beta/snapshot", { cache: "no-store" });
    expect(useForgeStore.getState().snapshot?.forge.slug).toBe("beta");

    disconnectAlpha();
    disconnectBeta();
  });

  it("surfaces snapshot refresh failures from runtime events", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: false, error: "Snapshot load failed" }, { status: 500 }));
    globalThis.fetch = fetchMock;

    const disconnect = useForgeStore.getState().connectEventStream("demo", 0);
    TestEventSource.instances[0].emitRuntimeEvent(2);

    await vi.advanceTimersByTimeAsync(200);

    expect(useForgeStore.getState().commandError).toBe("Snapshot refresh failed: Snapshot load failed");

    disconnect();
  });

  it("clears a stream refresh error after a later successful snapshot refresh", async () => {
    const snapshot = createDemoSnapshot();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: false, error: "Snapshot load failed" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { ...snapshot, lastEventSequence: 3 } }));
    globalThis.fetch = fetchMock;

    const disconnect = useForgeStore.getState().connectEventStream("demo", 0);
    TestEventSource.instances[0].emitRuntimeEvent(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(useForgeStore.getState().commandError).toBe("Snapshot refresh failed: Snapshot load failed");

    TestEventSource.instances[0].emitRuntimeEvent(3);
    await vi.advanceTimersByTimeAsync(200);

    expect(useForgeStore.getState().snapshot?.lastEventSequence).toBe(3);
    expect(useForgeStore.getState().commandError).toBeNull();

    disconnect();
  });
});
